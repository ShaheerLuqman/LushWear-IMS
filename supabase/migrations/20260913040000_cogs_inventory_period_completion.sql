-- Replace every existing COGS/Inventory posting path with one that fires once a
-- fiscal period is fully resolved, instead of continuously re-summing partial data.
--
-- Three mechanisms touched cost_of_goods_sold/inventory before this migration:
--   post_order_journal            dead - its own DROP FUNCTION already ran in
--                                  20260910040000_post_by_courier_bill.sql
--   post_courier_bill_journal /
--   post_courier_payout_journal   still live, still post COGS/Inventory lines
--                                  per bill/payout alongside revenue/returns/
--                                  charges/tax
--   sync_month_cogs_journal       still live, re-sums cost_price for every
--                                  delivered order in a month on every status/
--                                  cost change, via the statement-level trigger
--                                  added in 20260913030000
--
-- The last two both post to the same two ledgers under different source_types,
-- so COGS has been double-counted since 20260910. Neither waits for a month to
-- be settled - they repost continuously as orders trickle in.
--
-- New behaviour: sync_period_cogs_journal posts Dr COGS / Cr Inventory for a
-- fiscal period exactly once, and only once every non-cancelled order in that
-- period has reached delivered or returned - mirrors the completed_orders_count
-- / total_orders gate get_month_summary_periods already uses
-- (supabase_schema.sql, "completed_orders_count (delivered + returned) over
-- total_orders"), but as a hard gate on one period instead of a ratio over all
-- of them. A period with any order still in transit posts nothing at all.

-- ==================== 1. Stop the old triggers/functions ====================

DROP TRIGGER IF EXISTS shopify_orders_cogs_journal_trigger_ins ON shopify_orders;
DROP TRIGGER IF EXISTS shopify_orders_cogs_journal_trigger_upd ON shopify_orders;
DROP TRIGGER IF EXISTS shopify_orders_cogs_journal_trigger_del ON shopify_orders;
DROP FUNCTION IF EXISTS trg_shopify_orders_sync_cogs_stmt();
DROP FUNCTION IF EXISTS trg_shopify_orders_sync_cogs_stmt_ins();
DROP FUNCTION IF EXISTS trg_shopify_orders_sync_cogs_stmt_del();
-- Superseded copy from before the statement-level fix, in case it is still
-- lingering under CREATE OR REPLACE on some environments.
DROP TRIGGER IF EXISTS shopify_orders_cogs_journal_trigger ON shopify_orders;
DROP FUNCTION IF EXISTS trg_shopify_orders_sync_cogs();
DROP FUNCTION IF EXISTS sync_month_cogs_journal(UUID, INT, INT);


-- ==================== 2. Strip COGS/Inventory out of bill/payout posting ====================
--
-- Same functions, same revenue/returns/charges/tax behaviour - only the two
-- journal_line() calls that touched cost_of_goods_sold/inventory are removed,
-- along with the now-unused cost locals.

CREATE OR REPLACE FUNCTION post_courier_bill_journal(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b           RECORD;
    v_found     BOOLEAN;
    v_from      DATE;
    v_total     NUMERIC(14, 2);
    v_advance   NUMERIC(14, 2);
    v_lines     JSONB;
BEGIN
    SELECT * INTO b FROM shopify_courier_bills WHERE id = p_bill_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_type = 'courier_bill_sale' AND source_id = p_bill_id;

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT journal_orders_from INTO v_from FROM system_organizations WHERE id = b.org_id;
    IF b.pickup_date < v_from THEN
        RETURN;
    END IF;

    SELECT ROUND(COALESCE(SUM(o.total_amount), 0), 2),
           ROUND(COALESCE(SUM(o.advance_amount), 0), 2)
      INTO v_total, v_advance
      FROM shopify_orders o
     WHERE o.courier_bill_id = p_bill_id
       AND lower(trim(COALESCE(o.order_status, ''))) <> 'cancelled';

    v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(b.org_id, b.courier),
                            v_total - v_advance, 'COD due from courier');
    v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'orders', 'Orders', 'Liability', '2200'),
                            v_advance, 'Advances applied');
    v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000'),
                            -v_total, NULL);

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            b.org_id, b.pickup_date, v_lines,
            b.courier || ' dispatch ' || to_char(b.pickup_date, 'DD Mon YYYY'),
            'sale', NULL::UUID, 'courier_bill_sale', b.id
        );
    END IF;
END;
$$;


-- One voucher per CPR, dated the payout date. What the CSV actually reports:
--
--   Cr Courier          every member's COD clears - collected on a delivery,
--                       uncollectible on a return
--   Dr Sales Return     a returned parcel's sale unwinds at full value
--       Cr Orders       its advance goes back to being refundable
--   Dr Delivery Charges every member's charge, deliveries and returns alike
--   Dr Withholding Tax  deducted from the payout (zero on returns)
--   Dr Cash             what actually arrived
--
-- No Inventory/COGS here any more - that reversal now happens once per fiscal
-- period, gated on every order in it reaching a terminal status, in
-- sync_period_cogs_journal below.
--
-- Cash falls out as delivered COD less charges less withholding - the same figure
-- shopify_courier_bills_with_totals derives as `receivable`.
CREATE OR REPLACE FUNCTION post_courier_payout_journal(p_payout_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    p          RECORD;
    v_found    BOOLEAN;
    v_from     DATE;
    v_cod      NUMERIC(14, 2);
    v_ret_cod  NUMERIC(14, 2);
    v_ret_tot  NUMERIC(14, 2);
    v_ret_adv  NUMERIC(14, 2);
    v_charge   NUMERIC(14, 2);
    v_tax      NUMERIC(14, 2);
    v_lines    JSONB;
BEGIN
    SELECT * INTO p FROM finances_courier_payouts WHERE id = p_payout_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_type = 'courier_payout' AND source_id = p_payout_id;

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT journal_orders_from INTO v_from FROM system_organizations WHERE id = p.org_id;

    SELECT
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'delivered'), 0), 2),
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'returned'), 0), 2),
        ROUND(COALESCE(SUM(o.total_amount) FILTER (WHERE lower(trim(o.order_status)) = 'returned'), 0), 2),
        ROUND(COALESCE(SUM(o.advance_amount) FILTER (WHERE lower(trim(o.order_status)) = 'returned'), 0), 2),
        ROUND(COALESCE(SUM(o.delivery_charge), 0), 2),
        ROUND(COALESCE(SUM(o.tax_amount), 0), 2)
      INTO v_cod, v_ret_cod, v_ret_tot, v_ret_adv, v_charge, v_tax
      FROM shopify_orders o
     WHERE o.courier_payout_id = p_payout_id
       -- A member whose bill was never posted (dispatched before the cutover) has no
       -- COD on the courier account to clear.
       AND COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE >= v_from;

    v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(p.org_id, p.courier),
                            -(v_cod + v_ret_cod), 'COD cleared');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'sales_return', 'Sales Return', 'Revenue', '4100'),
                            v_ret_tot, 'Returned parcels');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'orders', 'Orders', 'Liability', '2200'),
                            -v_ret_adv, 'Advances refundable');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100'),
                            v_charge, NULL);
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200'),
                            v_tax, NULL);
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'cash', 'Cash', 'Asset', '1000', TRUE),
                            v_cod - v_charge - v_tax, 'Payout received');

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio, 'receipt', NULL::UUID, 'courier_payout', p.id
        );
    END IF;
END;
$$;


-- ==================== 3. Clear every old COGS/Inventory line the three mechanisms posted ====================
--
-- Scoped by source_type, not by ledger account. receive_bill/unreceive_bill
-- also debit the Inventory account on a real purchase (source_type = 'bill')
-- and that activity is not part of what is being replaced here - a blanket
-- "every line on this ledger" delete removes receive_bill's Inventory line
-- too and leaves its Cash/Accounts-Payable counterpart as an orphaned,
-- unbalanced line, which is exactly the debits/credits mismatch this
-- migration was tripping over. Only the three mechanisms named in the header
-- comment ever posted COGS/Inventory outside of receive_bill:
--   order_cogs_month             COGS/Inventory only - delete the whole entry
--   courier_bill_sale/           mix COGS/Inventory with revenue/returns/
--   courier_payout               charges/tax lines that must survive - strip
--                                 only the COGS/Inventory lines and let
--                                 post_courier_bills_journal below repost the
--                                 voucher from scratch
--
-- Both the per-row balance constraint (journal_lines_must_balance) and the
-- header line-count constraint (journal_entries_must_have_lines) are
-- CONSTRAINT TRIGGERs and have to be deferred across this whole block, not
-- just journal_lines_balance_trigger (that one only maintains the cached
-- ledger balance in finances_ledger_balances and enforces nothing).
SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines DEFERRED;

DELETE FROM finances_journal_entries
 WHERE source_type = 'order_cogs_month';

DELETE FROM finances_journal_lines l
 USING finances_journal_entries e
 WHERE l.journal_id = e.id
   AND e.source_type IN ('courier_bill_sale', 'courier_payout')
   AND l.account_id IN (SELECT id FROM finances_ledgers WHERE system_key IN ('cost_of_goods_sold', 'inventory'));

-- Calling post_courier_bills_journal here (rather than post_courier_bill_journal/
-- post_courier_payout_journal directly) does not work inside this migration:
-- it opens with ALTER TABLE finances_journal_lines DISABLE TRIGGER
-- journal_lines_balance_trigger, and Postgres refuses ALTER TABLE on a table
-- that already has pending deferred-trigger events queued in the same
-- transaction - which the DELETEs above always leave behind while
-- journal_lines_must_balance/journal_entries_must_have_lines are still
-- DEFERRED. Looping the two posting functions directly avoids that DDL
-- entirely; journal_lines_balance_trigger only refreshes the cached ledger
-- balance for display and is not a correctness constraint, so skipping its
-- disable here just means each individual insert recalculates its ledger's
-- balance immediately rather than once at the end - correct either way, and
-- section 6 recalculates every ledger unconditionally regardless.
DO $$
DECLARE
    v_bill_id   UUID;
    v_payout_id UUID;
BEGIN
    FOR v_bill_id IN SELECT id FROM shopify_courier_bills ORDER BY pickup_date LOOP
        PERFORM post_courier_bill_journal(v_bill_id);
    END LOOP;

    FOR v_payout_id IN SELECT id FROM finances_courier_payouts ORDER BY payout_date LOOP
        PERFORM post_courier_payout_journal(v_payout_id);
    END LOOP;
END;
$$;

SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;


-- ==================== 4. New mechanism: post once a period is complete ====================
--
-- Delete-then-repost one voucher for (org, period), same idiom as the old
-- sync_month_cogs_journal, but gated: nothing posts (and any existing voucher
-- is left deleted) unless every non-cancelled order in the period has reached
-- delivered or returned. cost_price is summed for both statuses - a return
-- still shipped goods out and back, so its cost is real even though its
-- revenue unwound; only cancelled carries no cost. The same line-item
-- fallback post_courier_bill_journal used to carry (for a replacement order's
-- zeroed cost_price) is reused here for that same reason.
CREATE OR REPLACE FUNCTION sync_period_cogs_journal(p_org_id UUID, p_period_month INT, p_period_year INT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_start_day    INT;
    v_period_start DATE;
    v_open_count   INT;
    v_total        NUMERIC(14, 2);
    v_cogs         UUID;
    v_inventory    UUID;
    v_lines        JSONB;
BEGIN
    SELECT fiscal_month_start_day INTO v_start_day
      FROM system_organizations WHERE id = p_org_id;
    v_period_start := make_date(p_period_year, p_period_month, v_start_day);

    DELETE FROM finances_journal_entries
     WHERE org_id = p_org_id AND source_type = 'order_cogs_period' AND entry_date = v_period_start;

    SELECT COUNT(*) INTO v_open_count
      FROM shopify_orders o, fiscal_period_of(o.order_receiving_date, v_start_day) fp
     WHERE o.org_id = p_org_id
       AND fp.period_month = p_period_month
       AND fp.period_year  = p_period_year
       AND lower(trim(COALESCE(o.order_status, ''))) NOT IN ('delivered', 'returned', 'cancelled');

    IF v_open_count > 0 THEN
        -- Period not fully resolved yet - post nothing until it is.
        RETURN;
    END IF;

    SELECT COALESCE(SUM(
               CASE WHEN COALESCE(o.cost_price, 0) <> 0 THEN o.cost_price
                    ELSE (SELECT COALESCE(SUM((li ->> 'cost_price')::NUMERIC
                                              * GREATEST(COALESCE((li ->> 'qty')::NUMERIC, 0), 0)), 0)
                            FROM jsonb_array_elements(COALESCE(o.line_items, '[]'::jsonb)) li
                           WHERE (li ->> 'cost_price') IS NOT NULL)
               END), 0) INTO v_total
      FROM shopify_orders o, fiscal_period_of(o.order_receiving_date, v_start_day) fp
     WHERE o.org_id = p_org_id
       AND fp.period_month = p_period_month
       AND fp.period_year  = p_period_year
       AND lower(trim(o.order_status)) IN ('delivered', 'returned');

    IF v_total <= 0 THEN
        RETURN;
    END IF;

    v_cogs      := ensure_system_ledger(p_org_id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000');
    v_inventory := ensure_system_ledger(p_org_id, 'inventory', 'Inventory', 'Asset', '1400');

    v_lines := journal_line('[]'::jsonb, v_cogs, v_total,
                            'Cost of goods sold - ' || to_char(v_period_start, 'FMMonth YYYY'));
    v_lines := journal_line(v_lines, v_inventory, -v_total,
                            'Cost of goods sold - ' || to_char(v_period_start, 'FMMonth YYYY'));

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p_org_id, v_period_start, v_lines,
            'Cost of goods sold - ' || to_char(v_period_start, 'FMMonth YYYY'),
            'journal', NULL::UUID, 'order_cogs_period', NULL
        );
    END IF;
END;
$$;


-- Statement-level, same shape as 20260913030000_cogs_trigger_statement_level.sql -
-- one call per distinct (org, period) touched by the whole batch statement,
-- not per row, so a large CSV upsert does not re-scan the order table once per
-- row. UPDATE watches order_status and cost_price; a period only re-evaluates
-- when a row that could flip its completion or cost actually changed.
CREATE OR REPLACE FUNCTION trg_shopify_orders_sync_cogs_stmt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_period_cogs_journal(p.org_id, p.period_month, p.period_year)
      FROM (
          SELECT DISTINCT r.org_id, fp.period_month, fp.period_year
            FROM (
                SELECT o.org_id, o.order_receiving_date
                  FROM old_rows o
                  JOIN new_rows n ON n.id = o.id
                 WHERE o.order_status IS DISTINCT FROM n.order_status
                    OR o.cost_price IS DISTINCT FROM n.cost_price
                 UNION
                SELECT n.org_id, n.order_receiving_date
                  FROM new_rows n
                  JOIN old_rows o ON o.id = n.id
                 WHERE o.order_status IS DISTINCT FROM n.order_status
                    OR o.cost_price IS DISTINCT FROM n.cost_price
            ) r
            JOIN system_organizations so ON so.id = r.org_id
            CROSS JOIN LATERAL fiscal_period_of(r.order_receiving_date, so.fiscal_month_start_day) fp
      ) p;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_shopify_orders_sync_cogs_stmt_ins()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_period_cogs_journal(p.org_id, p.period_month, p.period_year)
      FROM (
          SELECT DISTINCT r.org_id, fp.period_month, fp.period_year
            FROM new_rows r
            JOIN system_organizations so ON so.id = r.org_id
            CROSS JOIN LATERAL fiscal_period_of(r.order_receiving_date, so.fiscal_month_start_day) fp
      ) p;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_shopify_orders_sync_cogs_stmt_del()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_period_cogs_journal(p.org_id, p.period_month, p.period_year)
      FROM (
          SELECT DISTINCT r.org_id, fp.period_month, fp.period_year
            FROM old_rows r
            JOIN system_organizations so ON so.id = r.org_id
            CROSS JOIN LATERAL fiscal_period_of(r.order_receiving_date, so.fiscal_month_start_day) fp
      ) p;
    RETURN NULL;
END;
$$;

CREATE TRIGGER shopify_orders_cogs_journal_trigger_ins
AFTER INSERT ON shopify_orders
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_shopify_orders_sync_cogs_stmt_ins();

CREATE TRIGGER shopify_orders_cogs_journal_trigger_upd
AFTER UPDATE ON shopify_orders
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_shopify_orders_sync_cogs_stmt();

CREATE TRIGGER shopify_orders_cogs_journal_trigger_del
AFTER DELETE ON shopify_orders
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_shopify_orders_sync_cogs_stmt_del();


-- ==================== 4.5. Point Month Summary at the new source_type ====================
--
-- get_month_summary_totals reads its cost_of_goods_sold field from
-- finances_journal_entries.source_type = 'order_cogs_month' - the only other
-- live reader of that source_type besides the trigger dropped above. Left
-- unchanged, Month Summary's COGS would silently read 0 forever, even for
-- periods sync_period_cogs_journal has posted, because it now writes
-- 'order_cogs_period' instead.
CREATE OR REPLACE FUNCTION get_month_summary_totals(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_entry_start DATE,
    p_entry_end DATE,
    p_org_id UUID
)
RETURNS TABLE(
    total_orders INT,
    total_gross_sale NUMERIC,
    total_return_amount NUMERIC,
    return_orders_count INT,
    delivered_orders_count INT,
    enroute_orders_count INT,
    unfulfilled_orders_count INT,
    cancelled_orders_count INT,
    net_sales NUMERIC,
    cost_of_goods_sold NUMERIC,
    tax_total NUMERIC,
    gross_profit NUMERIC,
    dc_charges_delivered NUMERIC,
    dc_charges_returned NUMERIC,
    dc_charges_total NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH period_orders AS (
        SELECT *
        FROM shopify_orders
        WHERE org_id = p_org_id
          AND order_receiving_date >= p_period_start
          AND order_receiving_date <  p_period_end
    ),
    order_totals AS (
        SELECT
            COUNT(*) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled')::INT AS total_orders,
            COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled'), 0) AS total_gross_sale,
            COALESCE(SUM(total_amount) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS total_return_amount,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'returned')::INT AS return_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) IN ('fulfilled', 'cna', 'rfd', 'ica'))::INT AS enroute_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'unfulfilled')::INT AS unfulfilled_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'cancelled')::INT AS cancelled_orders_count,
            COALESCE(SUM(tax_amount) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled'), 0) AS tax_total,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'delivered'), 0) AS dc_charges_delivered,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS dc_charges_returned
        FROM period_orders
    ),
    cogs AS (
        SELECT COALESCE(SUM(jl.debit), 0) AS cost_of_goods_sold
        FROM finances_journal_entries je
        JOIN finances_journal_lines jl ON jl.journal_id = je.id
        WHERE je.org_id = p_org_id
          AND je.source_type = 'order_cogs_period'
          AND je.entry_date >= p_entry_start
          AND je.entry_date <= p_entry_end
    )
    SELECT
        ot.total_orders,
        ot.total_gross_sale,
        ot.total_return_amount,
        ot.return_orders_count,
        ot.delivered_orders_count,
        ot.enroute_orders_count,
        ot.unfulfilled_orders_count,
        ot.cancelled_orders_count,
        (ot.total_gross_sale - ot.total_return_amount) AS net_sales,
        c.cost_of_goods_sold,
        ot.tax_total,
        (
            (ot.total_gross_sale - ot.total_return_amount)
            - (ot.dc_charges_delivered + ot.dc_charges_returned)
            - ot.tax_total
        ) AS gross_profit,
        ot.dc_charges_delivered,
        ot.dc_charges_returned,
        (ot.dc_charges_delivered + ot.dc_charges_returned) AS dc_charges_total
    FROM order_totals ot, cogs c;
$$;


-- ==================== 5. Backfill: evaluate every period that already exists ====================
--
-- The new trigger only fires on a future write. Every (org, period) that already
-- has orders needs one evaluation now, or a period completed before this
-- migration ran would carry no COGS/Inventory voucher until its next unrelated
-- edit. sync_period_cogs_journal itself decides whether that period is actually
-- complete - this just makes sure every period gets asked.
--
-- Deferred again here: section 3 left both constraints IMMEDIATE at its end,
-- and sync_period_cogs_journal's own DELETE-then-post_journal_entry sequence
-- (entry row inserted, then its lines inserted as a separate statement) needs
-- them DEFERRED across that gap the same way section 3 did, or the header
-- row trips "must have at least two lines" between its own two statements.
SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines DEFERRED;

DO $$
DECLARE
    v_period RECORD;
BEGIN
    FOR v_period IN
        SELECT DISTINCT o.org_id, fp.period_month, fp.period_year
          FROM shopify_orders o
          JOIN system_organizations so ON so.id = o.org_id
          CROSS JOIN LATERAL fiscal_period_of(o.order_receiving_date, so.fiscal_month_start_day) fp
    LOOP
        PERFORM sync_period_cogs_journal(v_period.org_id, v_period.period_month, v_period.period_year);
    END LOOP;
END;
$$;

SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;


-- ==================== 6. Recalculate every ledger balance ====================

DO $$
BEGIN
    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l;
END;
$$;

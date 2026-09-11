-- Post by document, not by order.
--
-- Phase 5 first posted one voucher per order: 7,976 entries on Sales Revenue, which
-- is unreadable as a ledger statement and does not match how the business actually
-- reconciles. The two documents it works from are the ones the Courier Payment Report
-- already shows:
--
--   courier bill  one courier, one pickup date - the parcels that went out together.
--                 Posts the whole bill: revenue, COGS, COD due, advances applied.
--   CPR payout    the PostEx CSV - what actually arrived, with its breakdown of
--                 delivery charges, withholding, and which parcels came back.
--
-- Returns therefore settle on the CPR that reports them rather than on the status
-- flip, so returned_at is no longer needed for posting: a parcel is financially a
-- return when the courier bills it as one. The trade-off is that a parcel marked
-- returned in the app before it reaches a CPR still shows as revenue until then.

DROP FUNCTION IF EXISTS post_order_journal(UUID);
DROP FUNCTION IF EXISTS post_orders_journal(UUID, UUID[]);


-- One voucher per courier bill, dated its pickup date.
--
--   Dr Courier        COD the courier will collect   (total - advance)
--   Dr Orders         advances already held, applied against the sale
--       Cr Sales Revenue                             (total)
--   Dr COGS           cost of what shipped
--       Cr Inventory
--
-- No delivery charge and no withholding: those columns are written by the settlement
-- paths and are still zero when a parcel is picked up. They post on the CPR.
--
-- Rebuilt on every call, so a bill absorbing more orders later (assign_courier_bills
-- moves them until the bill is closed) re-posts as one corrected voucher.
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
    v_cost      NUMERIC(14, 2);
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
           ROUND(COALESCE(SUM(o.advance_amount), 0), 2),
           ROUND(COALESCE(SUM(
               CASE WHEN COALESCE(o.cost_price, 0) <> 0 THEN o.cost_price
                    ELSE (SELECT COALESCE(SUM((li ->> 'cost_price')::NUMERIC
                                              * GREATEST(COALESCE((li ->> 'qty')::NUMERIC, 0), 0)), 0)
                            FROM jsonb_array_elements(COALESCE(o.line_items, '[]'::jsonb)) li
                           WHERE (li ->> 'cost_price') IS NOT NULL)
               END), 0), 2)
      INTO v_total, v_advance, v_cost
      FROM shopify_orders o
     WHERE o.courier_bill_id = p_bill_id
       AND lower(trim(COALESCE(o.order_status, ''))) <> 'cancelled';

    v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(b.org_id, b.courier),
                            v_total - v_advance, 'COD due from courier');
    v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'orders', 'Orders', 'Liability', '2200'),
                            v_advance, 'Advances applied');
    v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000'),
                            -v_total, NULL);
    v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000'),
                            v_cost, NULL);
    v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'inventory', 'Inventory', 'Asset', '1400'),
                            -v_cost, NULL);

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
--   Dr Inventory        returned goods back into stock
--       Cr COGS
--   Dr Delivery Charges every member's charge, deliveries and returns alike
--   Dr Withholding Tax  deducted from the payout (zero on returns)
--   Dr Cash             what actually arrived
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
    v_ret_cost NUMERIC(14, 2);
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
        ROUND(COALESCE(SUM(
            CASE WHEN COALESCE(o.cost_price, 0) <> 0 THEN o.cost_price
                 ELSE (SELECT COALESCE(SUM((li ->> 'cost_price')::NUMERIC
                                           * GREATEST(COALESCE((li ->> 'qty')::NUMERIC, 0), 0)), 0)
                         FROM jsonb_array_elements(COALESCE(o.line_items, '[]'::jsonb)) li
                        WHERE (li ->> 'cost_price') IS NOT NULL)
            END) FILTER (WHERE lower(trim(o.order_status)) = 'returned'), 0), 2),
        ROUND(COALESCE(SUM(o.delivery_charge), 0), 2),
        ROUND(COALESCE(SUM(o.tax_amount), 0), 2)
      INTO v_cod, v_ret_cod, v_ret_tot, v_ret_adv, v_ret_cost, v_charge, v_tax
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
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'inventory', 'Inventory', 'Asset', '1400'),
                            v_ret_cost, 'Returned to stock');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000'),
                            -v_ret_cost, NULL);
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


-- Batch entry point. Same trigger suspension as the per-order version it replaces:
-- the recalc trigger is FOR EACH ROW over a full re-aggregation, so a backfill has to
-- post first and recalculate once. p_bill_ids NULL means every bill in the org.
CREATE OR REPLACE FUNCTION post_courier_bills_journal(p_org_id UUID, p_bill_ids UUID[] DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID;
    v_n  INT := 0;
BEGIN
    ALTER TABLE finances_journal_lines DISABLE TRIGGER journal_lines_balance_trigger;

    FOR v_id IN
        SELECT b.id FROM shopify_courier_bills b
         WHERE b.org_id = p_org_id
           AND (p_bill_ids IS NULL OR b.id = ANY(p_bill_ids))
         ORDER BY b.pickup_date
    LOOP
        PERFORM post_courier_bill_journal(v_id);
        v_n := v_n + 1;
    END LOOP;

    FOR v_id IN
        SELECT y.id FROM finances_courier_payouts y WHERE y.org_id = p_org_id
         ORDER BY y.payout_date
    LOOP
        PERFORM post_courier_payout_journal(v_id);
    END LOOP;

    SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;
    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l WHERE l.org_id = p_org_id;

    RETURN v_n;
END;
$$;


-- Widened to the document-level source types that replaced the per-order ones.
CREATE OR REPLACE FUNCTION unpost_orders_journal(p_org_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_n INT;
BEGIN
    ALTER TABLE finances_journal_lines DISABLE TRIGGER journal_lines_balance_trigger;

    WITH gone AS (
        DELETE FROM finances_journal_entries
         WHERE org_id = p_org_id
           AND source_type IN ('order_sale', 'order_return', 'order_return_stock',
                               'courier_bill_sale', 'courier_payout')
        RETURNING 1
    )
    SELECT COUNT(*)::INT INTO v_n FROM gone;

    SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;
    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l WHERE l.org_id = p_org_id;

    RETURN v_n;
END;
$$;


-- Folio -> the CPR it names. The same payout reaches us written several ways:
-- "2/9/26" typed against a CSV, "02/09/26" zero-padded, "24/12/25-API" derived from
-- the tracking API (postex._folio_from_date's marker). Normalising to one key is what
-- keeps one real deposit from splitting into three payout vouchers. A folio that is
-- not a date at all (a hand-typed assignment number) is kept verbatim as its own key.
CREATE OR REPLACE FUNCTION folio_payout_date(p_folio TEXT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_clean TEXT := regexp_replace(trim(COALESCE(p_folio, '')), '-API$', '');
BEGIN
    IF v_clean !~ '^\d{1,2}/\d{1,2}/\d{2,4}$' THEN
        RETURN NULL;
    END IF;
    RETURN to_date(v_clean, CASE WHEN v_clean ~ '/\d{4}$' THEN 'DD/MM/YYYY' ELSE 'DD/MM/YY' END);
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION normalize_folio(p_folio TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(
        to_char(folio_payout_date(p_folio), 'FMDD/FMMM/YY'),
        regexp_replace(trim(COALESCE(p_folio, '')), '-API$', '')
    );
$$;


-- Group settled orders into the CPR that paid them, the way assign_courier_bills
-- groups dispatched orders into a pickup-date bill. Call after any write that settles
-- an order or changes its folio; post_courier_payout_journal then reads membership.
--
-- An order settled with no folio at all (bulk_update_order_settled records none) joins
-- no payout and posts no cash - it is settled operationally but not financially, and
-- shows up as COD still sitting on the courier's account.
CREATE OR REPLACE FUNCTION assign_courier_payouts(p_org_id UUID)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_n INT;
BEGIN
    INSERT INTO finances_courier_payouts (org_id, courier, folio, payout_date)
    SELECT p_org_id,
           o.courier,
           normalize_folio(o.folio),
           -- A folio that does not parse still has to sit somewhere on the calendar;
           -- the last dispatch it covers is the earliest date it can honestly be.
           COALESCE(folio_payout_date(o.folio),
                    MAX(COALESCE(o.courier_pickup_date, o.fulfilled_at))::DATE)
      FROM shopify_orders o
     WHERE o.org_id = p_org_id
       AND o.is_order_settled
       AND COALESCE(trim(o.folio), '') <> ''
       AND COALESCE(o.courier_pickup_date, o.fulfilled_at) IS NOT NULL
     GROUP BY o.courier, normalize_folio(o.folio), folio_payout_date(o.folio)
        ON CONFLICT (org_id, courier, folio) DO NOTHING;

    UPDATE shopify_orders o
       SET courier_payout_id = y.id
      FROM finances_courier_payouts y
     WHERE o.org_id = p_org_id
       AND y.org_id = p_org_id
       AND o.is_order_settled
       AND y.courier = o.courier
       AND y.folio = normalize_folio(o.folio)
       AND o.courier_payout_id IS DISTINCT FROM y.id;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    RETURN v_n;
END;
$$;

-- Orders -> journal (FINANCE_ACCOUNTING_PLAN.md Phase 5).
--
-- Revenue is recognised at DISPATCH, not delivery: the business treats a parcel
-- leaving as the sale, and it keeps the ledger reproducing Month Summary's existing
-- gross/return/net shape. The cost of that choice is that a return has to unwind a
-- full-value entry, which is what post_order_journal's return voucher does.
--
-- Every voucher is keyed (source_type, source_id) and rebuilt rather than patched -
-- an order's status, amounts and dates all move after a first posting, so re-posting
-- from scratch is the only thing that cannot drift. It also means a cancellation
-- unwinds by deleting the voucher, which matters because sync zeroes total_amount on
-- a cancelled order: the numbers needed to compute a reversal are gone by then, but
-- nothing needs them.

-- Cutover. Orders dispatched before this post nothing, so a pre-cutover order that
-- settles after it cannot credit a courier receivable that was never debited.
-- Per-org rather than a constant because posting functions are multi-tenant; not
-- exposed in the UI, since moving it after the fact would rewrite closed months.
ALTER TABLE system_organizations
    ADD COLUMN IF NOT EXISTS journal_orders_from DATE NOT NULL DEFAULT DATE '2026-01-01';


-- The courier account an order posts its COD against. Matched on system_key rather
-- than the ledger's name so renaming the account in the UI cannot break posting
-- ('PostEx' -> 'postex' -> 'courier_postex', 'Couriers Next' -> 'couriersnext' ->
-- 'courier_couriers_next').
CREATE OR REPLACE FUNCTION resolve_courier_ledger(p_org_id UUID, p_courier VARCHAR)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id  UUID;
    v_key TEXT := lower(regexp_replace(COALESCE(p_courier, ''), '[^a-zA-Z0-9]', '', 'g'));
BEGIN
    IF v_key <> '' THEN
        SELECT id INTO v_id
          FROM finances_ledgers
         WHERE org_id = p_org_id
           AND system_key LIKE 'courier%'
           AND replace(system_key, '_', '') = 'courier' || v_key
         LIMIT 1;
        IF v_id IS NOT NULL THEN
            RETURN v_id;
        END IF;
    END IF;
    -- SCS, "Other", or a courier switched off in Settings still ships real goods and
    -- still holds real COD - an unmapped name must not block the posting.
    RETURN ensure_system_ledger(p_org_id, 'courier_other', 'Courier Receivables - Other', 'Asset', '1159');
END;
$$;


-- Append one journal line, signed: positive debits, negative credits. Skips zero,
-- which is what keeps journal_lines_one_side_only satisfiable for an order with no
-- advance, no cost snapshot, or no COD.
CREATE OR REPLACE FUNCTION journal_line(p_lines JSONB, p_account UUID, p_amount NUMERIC, p_description TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE WHEN p_amount = 0 OR p_account IS NULL THEN p_lines
                ELSE p_lines || jsonb_build_object(
                    'account_id',  p_account,
                    'debit',       GREATEST(p_amount, 0),
                    'credit',      GREATEST(-p_amount, 0),
                    'description', p_description)
           END;
$$;


-- Post (or re-post) one order's three possible vouchers.
--
--   order_sale         on dispatch  Dr Courier COD / Dr Advances / Cr Sales
--                                   Dr COGS / Cr Inventory
--   order_return       on return    Dr Sales Returns / Cr Courier COD / Cr Advances
--   order_return_stock on receipt   Dr Inventory / Cr COGS
--
-- Courier charges and withholding appear in NEITHER: delivery_charge and tax_amount
-- are written by the settlement paths, so at dispatch and at return those columns are
-- still zero. They post on the payout voucher, where the figures are real.
CREATE OR REPLACE FUNCTION post_order_journal(p_order_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    o           RECORD;
    v_found     BOOLEAN;
    v_from      DATE;
    v_dispatch  DATE;
    v_returned  DATE;
    v_total     NUMERIC(14, 2);
    v_advance   NUMERIC(14, 2);
    v_cod       NUMERIC(14, 2);
    v_cost      NUMERIC(14, 2);
    v_courier   UUID;
    v_orders    UUID;
    v_inventory UUID;
    v_cogs      UUID;
    v_lines     JSONB;
BEGIN
    SELECT * INTO o FROM shopify_orders WHERE id = p_order_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_id = p_order_id
       AND source_type IN ('order_sale', 'order_return', 'order_return_stock');

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT journal_orders_from INTO v_from FROM system_organizations WHERE id = o.org_id;

    -- courier_pickup_date is only ever filled for couriers with a tracking
    -- integration; fulfilled_at carries TCS, Bykea, SCS and "Other", which would
    -- otherwise never post revenue at all.
    v_dispatch := COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE;
    IF v_dispatch IS NULL OR v_dispatch < v_from OR lower(trim(o.order_status)) = 'cancelled' THEN
        RETURN;
    END IF;

    v_total   := ROUND(COALESCE(o.total_amount, 0), 2);
    v_advance := ROUND(COALESCE(o.advance_amount, 0), 2);
    v_cod     := v_total - v_advance;

    v_cost := ROUND(COALESCE(o.cost_price, 0), 2);
    IF v_cost = 0 THEN
        -- A replacement's cost_price column is deliberately zeroed so it cannot
        -- double-count in Month Summary, but the goods really do leave stock and the
        -- per-line snapshot still carries what they cost.
        SELECT ROUND(COALESCE(SUM(
                   (li ->> 'cost_price')::NUMERIC * GREATEST(COALESCE((li ->> 'qty')::NUMERIC, 0), 0)
               ), 0), 2)
          INTO v_cost
          FROM jsonb_array_elements(COALESCE(o.line_items, '[]'::jsonb)) li
         WHERE (li ->> 'cost_price') IS NOT NULL;
    END IF;

    v_courier   := resolve_courier_ledger(o.org_id, o.courier);
    v_orders    := ensure_system_ledger(o.org_id, 'orders', 'Orders', 'Liability', '2200');
    v_inventory := ensure_system_ledger(o.org_id, 'inventory', 'Inventory', 'Asset', '1400');
    v_cogs      := ensure_system_ledger(o.org_id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000');

    v_lines := journal_line('[]'::jsonb, v_courier, v_cod, 'COD due from courier');
    v_lines := journal_line(v_lines, v_orders, v_advance, 'Advance applied');
    v_lines := journal_line(v_lines, ensure_system_ledger(o.org_id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000'),
                            -v_total, NULL);
    v_lines := journal_line(v_lines, v_cogs, v_cost, NULL);
    v_lines := journal_line(v_lines, v_inventory, -v_cost, NULL);

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            o.org_id, v_dispatch, v_lines,
            'Order #' || o.order_number, 'sale', NULL::UUID, 'order_sale', o.id
        );
    END IF;

    IF lower(trim(o.order_status)) <> 'returned' THEN
        RETURN;
    END IF;

    -- A return never had its revenue collected, so the whole sale unwinds: contra
    -- revenue for the full value, against the two accounts that carried it. The split
    -- is the same one dispatch used, so a partial advance nets to zero on both sides.
    v_returned := COALESCE(o.returned_at::DATE, v_dispatch);
    v_lines := journal_line('[]'::jsonb,
                            ensure_system_ledger(o.org_id, 'sales_return', 'Sales Return', 'Revenue', '4100'),
                            v_total, NULL);
    v_lines := journal_line(v_lines, v_courier, -v_cod, 'COD no longer collectible');
    v_lines := journal_line(v_lines, v_orders, -v_advance, 'Advance refundable');

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            o.org_id, v_returned, v_lines,
            'Return #' || o.order_number, 'return', NULL::UUID, 'order_return', o.id
        );
    END IF;

    -- Stock comes back only once the parcel physically does. Putting it back on the
    -- status flip would credit Inventory for goods still in the courier's van.
    IF lower(trim(COALESCE(o.piece_received, ''))) <> 'received' THEN
        RETURN;
    END IF;

    v_lines := journal_line('[]'::jsonb, v_inventory, v_cost, NULL);
    v_lines := journal_line(v_lines, v_cogs, -v_cost, NULL);

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            o.org_id, v_returned, v_lines,
            'Return to stock #' || o.order_number, 'return', NULL::UUID, 'order_return_stock', o.id
        );
    END IF;
END;
$$;


-- Post (or re-post) one courier payout: the CPR as it hits the bank.
--
--   Cr Courier            COD of the delivered members (receivable collected)
--   Dr Delivery Charges   every member's charge, returns included - a returned
--                         parcel's fee is deducted from the same pot
--   Dr Withholding Tax    deducted from the payout, zero on returns
--   Dr Cash               what actually arrived
--
-- Recomputed from members on every call, so a CSV upload replacing a
-- tax_amount_derived figure corrects the voucher instead of adding a second one.
CREATE OR REPLACE FUNCTION post_courier_payout_journal(p_payout_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    p        RECORD;
    v_found  BOOLEAN;
    v_from   DATE;
    v_cod    NUMERIC(14, 2);
    v_charge NUMERIC(14, 2);
    v_tax    NUMERIC(14, 2);
    v_lines  JSONB;
BEGIN
    SELECT * INTO p FROM finances_courier_payouts WHERE id = p_payout_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_type = 'courier_payout' AND source_id = p_payout_id;

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT journal_orders_from INTO v_from FROM system_organizations WHERE id = p.org_id;

    SELECT ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                          FILTER (WHERE lower(trim(o.order_status)) = 'delivered'), 0), 2),
           ROUND(COALESCE(SUM(COALESCE(o.delivery_charge, 0)), 0), 2),
           ROUND(COALESCE(SUM(COALESCE(o.tax_amount, 0)), 0), 2)
      INTO v_cod, v_charge, v_tax
      FROM shopify_orders o
     WHERE o.courier_payout_id = p_payout_id
       -- A member dispatched before the cutover never debited the courier account,
       -- so settling it here would credit a receivable that was never raised.
       AND COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE >= v_from;

    v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(p.org_id, p.courier), -v_cod, 'COD collected');
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100'),
                            v_charge, NULL);
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200'),
                            v_tax, NULL);
    v_lines := journal_line(v_lines, ensure_system_ledger(p.org_id, 'cash', 'Cash', 'Asset', '1000', TRUE),
                            v_cod - v_charge - v_tax, NULL);

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio, 'receipt', NULL::UUID, 'courier_payout', p.id
        );
    END IF;
END;
$$;

-- Split the single combined payout voucher into 4 separate entries, each its own
-- Dr <account> / Cr PostEx, so the courier ledger's own statement
-- (get_ledger_statement, filtered to WHERE jl.account_id = p_ledger_id) shows 4
-- distinct credit rows per CPR - individually matchable against the CSV's own
-- totals - instead of 1 combined "COD cleared" row netting all 4 together.
--
-- finances_journal_entries allows at most one row per (org_id, source_type,
-- source_id) when both are set (idx_journal_entries_source), so 4 vouchers
-- sharing p_payout_id need 4 distinct source_types - same pattern the old
-- (now-dead) post_order_journal used to split order_sale/order_return/
-- order_return_stock for one order id.
--
-- No advance/upfront concept exists for this org's orders, so v_ret_adv is
-- always 0 in practice; the Returns voucher is a clean 2-liner like the other
-- three. Kept as v_ret_tot - v_ret_adv rather than hardcoded, so an org that
-- does track advances isn't silently wrong.
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
    v_cash     UUID;
    v_courier  UUID;
    v_lines    JSONB;
BEGIN
    SELECT * INTO p FROM finances_courier_payouts WHERE id = p_payout_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_id = p_payout_id
       AND source_type IN ('courier_payout', 'courier_payout_return',
                            'courier_payout_delivery_charge', 'courier_payout_tax',
                            'courier_payout_cash');

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

    v_cash    := COALESCE(p.cash_ledger_id, ensure_system_ledger(p.org_id, 'cash', 'Cash', 'Asset', '1000', TRUE));
    v_courier := resolve_courier_ledger(p.org_id, p.courier);

    -- Returns: Dr Sales Return / Cr PostEx.
    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'sales_return', 'Sales Return', 'Revenue', '4100'),
                            v_ret_tot - v_ret_adv, 'Returned parcels');
    v_lines := journal_line(v_lines, v_courier, -(v_ret_tot - v_ret_adv), 'Returns Adjustment');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio || ' - Returns',
            'return', NULL::UUID, 'courier_payout_return', p.id
        );
    END IF;

    -- Delivery Charges: Dr Delivery Charges / Cr PostEx.
    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100'),
                            v_charge, NULL);
    v_lines := journal_line(v_lines, v_courier, -v_charge, 'Delivery charges deducted');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio || ' - Delivery Charges',
            'journal', NULL::UUID, 'courier_payout_delivery_charge', p.id
        );
    END IF;

    -- Withholding Tax: Dr Withholding Tax / Cr PostEx.
    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200'),
                            v_tax, NULL);
    v_lines := journal_line(v_lines, v_courier, -v_tax, 'Withholding tax deducted');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio || ' - Withholding Tax',
            'journal', NULL::UUID, 'courier_payout_tax', p.id
        );
    END IF;

    -- Cash: Dr <received-in ledger> / Cr PostEx - the actual net cash received,
    -- matching the CSV's own NET_AMOUNT total.
    v_lines := journal_line('[]'::jsonb, v_cash, v_cod - v_charge - v_tax, 'Payout received');
    v_lines := journal_line(v_lines, v_courier, -(v_cod - v_charge - v_tax), 'COD cleared');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines,
            p.courier || ' payout ' || p.folio || ' - Cash Received',
            'receipt', NULL::UUID, 'courier_payout_cash', p.id
        );
    END IF;
END;
$$;


-- unpost_orders_journal's bulk wipe needs the 4 new source_types too, or a full
-- unpost would leave the split payout vouchers behind as orphans while cleaning
-- up everything else.
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
                               'courier_bill_sale', 'courier_payout',
                               'courier_payout_return', 'courier_payout_delivery_charge',
                               'courier_payout_tax', 'courier_payout_cash')
        RETURNING 1
    )
    SELECT COUNT(*)::INT INTO v_n FROM gone;

    SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;
    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l WHERE l.org_id = p_org_id;

    RETURN v_n;
END;
$$;

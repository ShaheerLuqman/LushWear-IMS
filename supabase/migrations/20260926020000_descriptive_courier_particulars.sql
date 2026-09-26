-- Self-describing particulars on courier postings.
--
-- A ledger statement shows a line's own description, falling back to its
-- entry's narration only when the line has none. The courier postings gave most
-- lines a bare "Advances applied" / "Delivery charges deducted", so a row on
-- Customer Advances or the courier's ledger did not say which bill or payout it
-- came from. Every line now leads with its document:
--
--   CPR <courier> <pickup d/m/yy> - Advances Applied      dispatch bill (as on the Courier Payment Report)
--   CPR <courier> Pre-onboarding - Remaining Orders       the pre-onboarding bill
--   Payout <courier> <folio> - Delivery Charges           a courier payout (PostEx CPR CSV)
--
-- Payouts are "Payout", not "CPR", so a bill picked up on 1/4/26 and the payout
-- whose folio is 1/4/26 stay distinguishable. Amounts and accounts are unchanged
-- from 20260923010000_pre_onboarding_courier_bill.sql; only the text differs.
CREATE OR REPLACE FUNCTION post_courier_bill_journal(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b         RECORD;
    v_found   BOOLEAN;
    v_from    DATE;
    v_total   NUMERIC(14, 2);
    v_advance NUMERIC(14, 2);
    v_ref     TEXT;
    v_lines   JSONB;
BEGIN
    SELECT * INTO b FROM shopify_courier_bills WHERE id = p_bill_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_type = 'courier_bill_sale' AND source_id = p_bill_id;

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT onboarding_date INTO v_from FROM system_organizations WHERE id = b.org_id;
    IF b.pickup_date < v_from AND NOT b.is_pre_onboarding THEN
        RETURN;
    END IF;

    SELECT ROUND(COALESCE(SUM(o.total_amount), 0), 2),
           ROUND(COALESCE(SUM(o.advance_amount), 0), 2)
      INTO v_total, v_advance
      FROM shopify_orders o
     WHERE o.courier_bill_id = p_bill_id
       AND lower(trim(COALESCE(o.order_status, ''))) <> 'cancelled';

    IF b.is_pre_onboarding THEN
        v_ref := 'CPR ' || b.courier || ' Pre-onboarding';
        v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(b.org_id, b.courier),
                                v_total - v_advance, v_ref || ' - COD Receivable at Onboarding');
        v_lines := journal_line(v_lines,
                                ensure_system_ledger(b.org_id, 'opening_balance_equity',
                                                     'Opening Balance Equity', 'Equity', '3000'),
                                -(v_total - v_advance), v_ref || ' - Remaining Orders');
    ELSE
        v_ref := 'CPR ' || b.courier || ' ' || to_char(b.pickup_date, 'FMDD/FMMM/YY');
        v_lines := journal_line('[]'::jsonb, resolve_courier_ledger(b.org_id, b.courier),
                                v_total - v_advance, v_ref || ' - COD Receivable');
        v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'orders', 'Orders', 'Liability', '2200'),
                                v_advance, v_ref || ' - Advances Applied');
        v_lines := journal_line(v_lines, ensure_system_ledger(b.org_id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000'),
                                -v_total, v_ref || ' - Sales');
    END IF;

    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            b.org_id, b.pickup_date, v_lines, v_ref,
            'sale', NULL::UUID, 'courier_bill_sale', b.id
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION post_courier_payout_journal(p_payout_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    p          RECORD;
    v_found    BOOLEAN;
    v_from     DATE;
    v_cod      NUMERIC(14, 2);
    v_ret_net  NUMERIC(14, 2);
    v_ret_pre  NUMERIC(14, 2);
    v_charge   NUMERIC(14, 2);
    v_tax      NUMERIC(14, 2);
    v_cash     UUID;
    v_courier  UUID;
    v_cash_net NUMERIC(14, 2);
    v_ref      TEXT;
    v_lines    JSONB;
BEGIN
    SELECT * INTO p FROM finances_courier_payouts WHERE id = p_payout_id;
    v_found := FOUND;

    DELETE FROM finances_journal_entries
     WHERE source_id = p_payout_id
       AND source_type IN ('courier_payout', 'courier_payout_return',
                            'courier_payout_delivery_charge', 'courier_payout_tax',
                            'courier_payout_cash');
    -- Cascades to the journal entry it projected, via transaction_entries_journal_trigger.
    DELETE FROM finances_transaction_entries
     WHERE source_id = p_payout_id AND source_type = 'courier_payout_cash';

    IF NOT v_found THEN
        RETURN;
    END IF;

    SELECT onboarding_date INTO v_from FROM system_organizations WHERE id = p.org_id;

    SELECT
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'delivered'), 0), 2),
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'returned'
                                 AND NOT COALESCE(cb.is_pre_onboarding, FALSE)), 0), 2),
        ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0))
                       FILTER (WHERE lower(trim(o.order_status)) = 'returned'
                                 AND COALESCE(cb.is_pre_onboarding, FALSE)), 0), 2),
        ROUND(COALESCE(SUM(o.delivery_charge), 0), 2),
        ROUND(COALESCE(SUM(o.tax_amount), 0), 2)
      INTO v_cod, v_ret_net, v_ret_pre, v_charge, v_tax
      FROM shopify_orders o
      LEFT JOIN shopify_courier_bills cb ON cb.id = o.courier_bill_id
     WHERE o.courier_payout_id = p_payout_id
       AND (COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE >= v_from
            OR COALESCE(cb.is_pre_onboarding, FALSE));

    v_cash    := COALESCE(p.cash_ledger_id, ensure_system_ledger(p.org_id, 'cash', 'Cash', 'Asset', '1000', TRUE));
    v_courier := resolve_courier_ledger(p.org_id, p.courier);
    v_ref     := 'Payout ' || p.courier || ' ' || p.folio;

    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'sales_return', 'Sales Return', 'Revenue', '4100'),
                            v_ret_net, v_ref || ' - Returned Parcels');
    v_lines := journal_line(v_lines,
                            ensure_system_ledger(p.org_id, 'opening_balance_equity',
                                                 'Opening Balance Equity', 'Equity', '3000'),
                            v_ret_pre, v_ref || ' - Returned Pre-onboarding Parcels');
    v_lines := journal_line(v_lines, v_courier, -(v_ret_net + v_ret_pre), v_ref || ' - Returns Adjustment');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines, v_ref || ' - Returns',
            'return', NULL::UUID, 'courier_payout_return', p.id
        );
    END IF;

    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100'),
                            v_charge, v_ref || ' - Delivery Charges');
    v_lines := journal_line(v_lines, v_courier, -v_charge, v_ref || ' - Delivery Charges Deducted');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines, v_ref || ' - Delivery Charges',
            'journal', NULL::UUID, 'courier_payout_delivery_charge', p.id
        );
    END IF;

    v_lines := journal_line('[]'::jsonb, ensure_system_ledger(p.org_id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200'),
                            v_tax, v_ref || ' - Withholding Tax');
    v_lines := journal_line(v_lines, v_courier, -v_tax, v_ref || ' - Withholding Tax Deducted');
    IF jsonb_array_length(v_lines) >= 2 THEN
        PERFORM post_journal_entry(
            p.org_id, p.payout_date, v_lines, v_ref || ' - Withholding Tax',
            'journal', NULL::UUID, 'courier_payout_tax', p.id
        );
    END IF;

    -- Posted as a transaction entry so it also lands on the Transactions page -
    -- see 20260917000000_postex_payout_cash_as_transaction_entry.sql.
    v_cash_net := v_cod - v_charge - v_tax;
    IF v_cash_net <> 0 THEN
        INSERT INTO finances_transaction_entries
            (org_id, entry_date, amount, description, from_account_id, to_account_id, source_type, source_id)
        VALUES (
            p.org_id, p.payout_date, ABS(v_cash_net), v_ref || ' - Cash Received',
            CASE WHEN v_cash_net > 0 THEN v_courier ELSE v_cash    END,
            CASE WHEN v_cash_net > 0 THEN v_cash    ELSE v_courier END,
            'courier_payout_cash', p.id
        );
    END IF;
END;
$$;

-- Repost every bill and payout so existing entries carry the new text. The
-- batch function rebuilds each from its members (same amounts) and recalculates
-- ledger balances once at the end.
--
-- It ends with SET CONSTRAINTS ... IMMEDIATE, which lasts for the rest of the
-- transaction, so they are deferred again before each org - otherwise the next
-- org's first entry is checked for lines before post_journal_entry adds them.
DO $$
DECLARE
    v_org UUID;
BEGIN
    FOR v_org IN SELECT id FROM system_organizations LOOP
        SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines DEFERRED;
        PERFORM post_courier_bills_journal(v_org, NULL);
    END LOOP;
END;
$$;

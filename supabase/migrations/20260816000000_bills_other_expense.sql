-- Other expense on a bill: a flat amount alongside tax for costs that came
-- with the purchase but aren't stock or tax - transport, loading, courier.
-- Modelled exactly like tax_amount: a column on the bill, folded into total by
-- recalc_bill_totals, and its own debit line in receive_bill when > 0. The
-- account is lazily created via ensure_system_ledger, same as Tax on
-- Purchases (20260802100000_stop_seeding_tax_on_purchases.sql) - most orgs
-- will never use it.

ALTER TABLE finances_bills ADD COLUMN IF NOT EXISTS other_expense_amount
    DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (other_expense_amount >= 0);

CREATE OR REPLACE FUNCTION recalc_bill_totals(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_subtotal NUMERIC(14, 2);
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_subtotal
      FROM finances_bill_items WHERE bill_id = p_bill_id;

    UPDATE finances_bills
       SET subtotal   = v_subtotal,
           total      = v_subtotal + tax_amount + other_expense_amount,
           updated_at = NOW()
     WHERE id = p_bill_id;
END;
$$;

CREATE OR REPLACE FUNCTION receive_bill(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b               RECORD;
    v_inventory     UUID;
    v_tax_account   UUID;
    v_other_account UUID;
    v_lines         JSONB;
BEGIN
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % not found', p_bill_id;
    END IF;
    IF b.status = 'received' THEN
        RETURN;
    END IF;
    IF b.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cannot receive a cancelled bill';
    END IF;

    PERFORM recalc_bill_totals(p_bill_id);
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;

    IF b.total <= 0 THEN
        RAISE EXCEPTION 'Bill % has nothing to post - add at least one line', b.bill_number;
    END IF;

    -- Every line is stock, so the whole subtotal is one Inventory debit.
    v_inventory := ensure_system_ledger(b.org_id, 'inventory', 'Inventory', 'Asset', '1400');
    v_lines := jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory,
        'debit',      b.subtotal,
        'credit',     0,
        'description', 'Bill ' || b.bill_number));

    IF b.tax_amount > 0 THEN
        v_tax_account := ensure_system_ledger(
            b.org_id, 'tax_on_purchases', 'Tax on Purchases', 'Expense', '5900');
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', v_tax_account,
            'debit',      b.tax_amount,
            'credit',     0,
            'description', 'Tax on bill ' || b.bill_number));
    END IF;

    IF b.other_expense_amount > 0 THEN
        v_other_account := ensure_system_ledger(
            b.org_id, 'other_expenses', 'Other Expenses', 'Expense', '5910');
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', v_other_account,
            'debit',      b.other_expense_amount,
            'credit',     0,
            'description', 'Other expense on bill ' || b.bill_number));
    END IF;

    -- The supplier's own ledger is the credit side - there is no separate
    -- Accounts Payable control account (FINANCE_ACCOUNTING_PLAN.md Phase 2).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', b.supplier_id,
        'debit',      0,
        'credit',     b.total,
        'description', 'Bill ' || b.bill_number));

    -- Defensive: post_journal_entry does not replace an existing entry for the
    -- same source, and idx_journal_entries_source would reject a duplicate.
    DELETE FROM finances_journal_entries
     WHERE org_id = b.org_id AND source_type = 'bill' AND source_id = p_bill_id;

    PERFORM post_journal_entry(
        b.org_id,
        b.bill_date,
        v_lines,
        'Bill ' || b.bill_number || COALESCE(' (' || b.supplier_ref || ')', ''),
        'bill',
        b.created_by,
        'bill',
        b.id);

    IF NOT b.stock_applied THEN
        PERFORM apply_bill_stock(p_bill_id, 1);
        UPDATE finances_bills SET stock_applied = TRUE WHERE id = p_bill_id;
    END IF;

    UPDATE finances_bills SET status = 'received', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

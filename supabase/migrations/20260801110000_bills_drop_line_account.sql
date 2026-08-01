-- Drops bill_items.account_id. A purchase bill is always for stock, so every
-- line posts to the org's Inventory account and there is nothing to choose per
-- line. Anything paid for on the spot (ads, rent, packaging) is a cashbook
-- entry against its expense ledger - fewer steps, and it already worked. Bills
-- exist to record what is OWED, not to categorise spending.
--
-- Why this is a separate migration rather than an edit to 20260801090000: that
-- file had already been applied, so the column exists in the database and
-- editing the file could not remove it. 20260801090000 and 20260801100000 were
-- corrected in place for the benefit of fresh installs; this migration brings
-- an already-migrated database to the same shape.

ALTER TABLE bill_items DROP COLUMN IF EXISTS account_id;

-- receive_bill is re-created because the version applied alongside the old
-- schema grouped its journal lines BY account_id and would now fail on a column
-- that no longer exists. Identical to the body in 20260801100000; repeated here
-- so this migration stands on its own for a database that already ran that one.
CREATE OR REPLACE FUNCTION receive_bill(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b             RECORD;
    v_inventory   UUID;
    v_tax_account UUID;
    v_lines       JSONB;
BEGIN
    SELECT * INTO b FROM bills WHERE id = p_bill_id;
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
    SELECT * INTO b FROM bills WHERE id = p_bill_id;

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

    -- The supplier's own ledger is the credit side - there is no separate
    -- Accounts Payable control account (FINANCE_ACCOUNTING_PLAN.md Phase 2).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', b.supplier_id,
        'debit',      0,
        'credit',     b.total,
        'description', 'Bill ' || b.bill_number));

    -- Defensive: post_journal_entry does not replace an existing entry for the
    -- same source, and idx_journal_entries_source would reject a duplicate.
    DELETE FROM journal_entries
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
        UPDATE bills SET stock_applied = TRUE WHERE id = p_bill_id;
    END IF;

    UPDATE bills SET status = 'received', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

-- The failed create left bills rows behind: POST /api/bills inserted the header,
-- then the line insert hit the not-null constraint, and the two are separate
-- PostgREST calls with no transaction around them. A draft with no lines cannot
-- be received (receive_bill rejects a zero total) and is only clutter.
DELETE FROM bills b
 WHERE b.status = 'draft'
   AND NOT EXISTS (SELECT 1 FROM bill_items i WHERE i.bill_id = b.id);

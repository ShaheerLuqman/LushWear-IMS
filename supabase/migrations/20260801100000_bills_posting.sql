-- Phase 2, part 2: bill numbering, totals, posting, stock, and AP ageing.

-- Seeds the two system accounts bills post to. Deliberately NOT accounts_payable
-- (superseding the Phase 1 handoff note): the supplier's own ledger is credited,
-- so the party ledgers collectively are accounts payable.
DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'inventory', 'Inventory', 'Asset', '1400');
        PERFORM ensure_system_ledger(org.id, 'tax_on_purchases', 'Tax on Purchases', 'Expense', '5900');
    END LOOP;
END $$;

-- Next BILL-nnnn for an org. Races are possible under concurrent creates; the
-- UNIQUE (org_id, bill_number) constraint is what actually guarantees
-- uniqueness, and this only has to be right in the ordinary single-user case.
CREATE OR REPLACE FUNCTION next_bill_number(p_org_id UUID)
RETURNS VARCHAR
LANGUAGE sql
STABLE
AS $$
    SELECT 'BILL-' || LPAD(
        (COALESCE(MAX(SUBSTRING(bill_number FROM 6)::INT), 0) + 1)::TEXT, 4, '0')
      FROM bills
     WHERE org_id = p_org_id AND bill_number ~ '^BILL-[0-9]+$';
$$;

-- Totals are derived from the lines, never trusted from the client.
CREATE OR REPLACE FUNCTION recalc_bill_totals(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_subtotal NUMERIC(14, 2);
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_subtotal
      FROM bill_items WHERE bill_id = p_bill_id;

    UPDATE bills
       SET subtotal   = v_subtotal,
           total      = v_subtotal + tax_amount,
           updated_at = NOW()
     WHERE id = p_bill_id;
END;
$$;

-- Adds (p_sign = 1) or removes (p_sign = -1) this bill's stock.
--
-- Caveat worth knowing: receiving updates products.cost_price to the purchase
-- cost, but un-receiving does NOT restore the previous cost - the old value was
-- never recorded anywhere. Past orders are unaffected either way, since
-- orders.cost_price is snapshotted at order time.
CREATE OR REPLACE FUNCTION apply_bill_stock(p_bill_id UUID, p_sign INT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- variants.quantity is INTEGER while a bill line can be fractional (fabric
    -- by the metre), so the movement is rounded to whole units.
    UPDATE variants v
       SET quantity   = v.quantity + (p_sign * ROUND(agg.qty))::INT,
           updated_at = NOW()
      FROM (
          SELECT variant_id, SUM(quantity) AS qty
            FROM bill_items
           WHERE bill_id = p_bill_id AND variant_id IS NOT NULL
           GROUP BY variant_id
      ) agg
     WHERE v.id = agg.variant_id;

    IF p_sign > 0 THEN
        UPDATE products p
           SET cost_price = agg.unit_cost,
               updated_at = NOW()
          FROM (
              SELECT DISTINCT ON (product_id) product_id, unit_cost
                FROM bill_items
               WHERE bill_id = p_bill_id AND product_id IS NOT NULL
               ORDER BY product_id, created_at DESC
          ) agg
         WHERE p.id = agg.product_id;
    END IF;
END;
$$;

-- Receive a bill: post it to the journal, add its stock, mark it received.
-- Idempotent - receiving an already-received bill is a no-op rather than a
-- second posting.
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

-- Back to draft: unpost the journal entry and take the stock away again.
-- Refuses while payments are allocated, since those settle a bill that would no
-- longer be posted.
CREATE OR REPLACE FUNCTION unreceive_bill(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b RECORD;
BEGIN
    SELECT * INTO b FROM bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % not found', p_bill_id;
    END IF;
    IF b.status <> 'received' THEN
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM bill_payments WHERE bill_id = p_bill_id) THEN
        RAISE EXCEPTION
            'Bill % has payments against it - remove them before reopening', b.bill_number;
    END IF;

    DELETE FROM journal_entries
     WHERE org_id = b.org_id AND source_type = 'bill' AND source_id = p_bill_id;

    IF b.stock_applied THEN
        PERFORM apply_bill_stock(p_bill_id, -1);
        UPDATE bills SET stock_applied = FALSE WHERE id = p_bill_id;
    END IF;

    UPDATE bills SET status = 'draft', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

-- Pay a bill: one cashbook entry plus its allocation, in one transaction.
--
-- The payment is a CASHBOOK entry (entry_type='debit', folio=<supplier>), which
-- the Phase 1 projection turns into Dr supplier / Cr cash. Posting straight to
-- the journal instead would break Cash In Hand: cashbook_daily_balances
-- .closing_balance is computed from cashbook_entries alone, so cash would
-- disagree with the Cash account's journal balance.
CREATE OR REPLACE FUNCTION pay_bill(
    p_bill_id      UUID,
    p_payment_date DATE,
    p_amount       NUMERIC,
    p_description  TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    b          RECORD;
    v_paid     NUMERIC(14, 2);
    v_entry_id UUID;
BEGIN
    SELECT * INTO b FROM bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % not found', p_bill_id;
    END IF;
    IF b.status <> 'received' THEN
        RAISE EXCEPTION 'Only a received bill can be paid (bill % is %)', b.bill_number, b.status;
    END IF;
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be greater than 0';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM bill_payments WHERE bill_id = p_bill_id;
    IF v_paid + p_amount > b.total THEN
        RAISE EXCEPTION 'Payment of % exceeds the % outstanding on bill %',
            p_amount, b.total - v_paid, b.bill_number;
    END IF;

    INSERT INTO cashbook_entries (org_id, entry_date, entry_type, amount, description, folio)
    VALUES (b.org_id, p_payment_date, 'debit', p_amount,
            COALESCE(p_description, 'Payment for bill ' || b.bill_number), b.supplier_id)
    RETURNING id INTO v_entry_id;

    INSERT INTO bill_payments (org_id, bill_id, cashbook_entry_id, amount)
    VALUES (b.org_id, p_bill_id, v_entry_id, p_amount);

    RETURN v_entry_id;
END;
$$;

-- Bills with how much has actually been paid, so "paid" / "partially paid" is
-- always computed from the allocations rather than stored and left to drift.
CREATE OR REPLACE VIEW bills_with_paid AS
    SELECT b.*,
           COALESCE(p.paid, 0)             AS paid_amount,
           b.total - COALESCE(p.paid, 0)   AS outstanding,
           CASE
               WHEN b.status <> 'received'            THEN b.status
               WHEN COALESCE(p.paid, 0) >= b.total    THEN 'paid'
               WHEN COALESCE(p.paid, 0) > 0           THEN 'partially_paid'
               ELSE 'unpaid'
           END                             AS payment_status
      FROM bills b
      LEFT JOIN (
          SELECT bill_id, SUM(amount) AS paid
            FROM bill_payments GROUP BY bill_id
      ) p ON p.bill_id = b.id;

-- Outstanding payables per supplier, bucketed by how overdue each bill is.
-- Only received bills carry a payable; drafts and cancelled bills are not debts.
CREATE OR REPLACE FUNCTION get_ap_ageing(p_org_id UUID, p_as_of DATE)
RETURNS TABLE(
    supplier_id   UUID,
    supplier_name VARCHAR,
    outstanding   NUMERIC,
    not_due       NUMERIC,
    d1_30         NUMERIC,
    d31_60        NUMERIC,
    d61_90        NUMERIC,
    d90_plus      NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH open_bills AS (
        SELECT b.supplier_id,
               b.total - COALESCE(p.paid, 0) AS outstanding,
               -- No due date means due on receipt.
               p_as_of - COALESCE(b.due_date, b.bill_date) AS days_overdue
          FROM bills b
          LEFT JOIN (
              SELECT bill_id, SUM(amount) AS paid FROM bill_payments GROUP BY bill_id
          ) p ON p.bill_id = b.id
         WHERE b.org_id = p_org_id
           AND b.status = 'received'
           AND b.bill_date <= p_as_of
           AND b.total - COALESCE(p.paid, 0) > 0
    )
    SELECT l.id,
           l.name,
           SUM(ob.outstanding),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue <= 0), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue BETWEEN  1 AND 30), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue BETWEEN 31 AND 60), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue BETWEEN 61 AND 90), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue > 90), 0)
      FROM open_bills ob
      JOIN ledgers l ON l.id = ob.supplier_id
     GROUP BY l.id, l.name
     ORDER BY l.name;
$$;

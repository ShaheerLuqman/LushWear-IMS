-- Removes payment recording from bills. A bill records what is OWED; payments
-- are ordinary cashbook entries against the supplier's ledger, made whenever
-- the money actually moves. No allocation table, no Pay button, no pay_bill().
--
-- The consequence, and how it is handled:
-- Without allocations nothing links a payment to a bill, so "is this bill
-- paid?" can no longer be answered by looking the payment up. Instead it is
-- DERIVED from the supplier's ledger: that account is credited by bills and
-- debited by payments, so its debits are what has been settled. Applying those
-- debits to the supplier's received bills oldest-first (FIFO) says which bills
-- are still open and how old they are.
--
-- This is self-correcting: whatever is entered in the cashbook, the ledger is
-- the truth, and the report follows it. It also means a payment does not have
-- to name a bill - paying a supplier a round sum settles their oldest bills,
-- which is how the money actually behaves.

DROP VIEW IF EXISTS bills_with_paid;
DROP TABLE IF EXISTS bill_payments;
DROP FUNCTION IF EXISTS pay_bill(UUID, DATE, NUMERIC, TEXT);

-- Same as before minus the bill_payments guard: with FIFO settlement there is
-- no allocation that could be left dangling by reopening a bill. Removing the
-- bill's credit just moves the supplier's balance, and the report follows.
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

    DELETE FROM journal_entries
     WHERE org_id = b.org_id AND source_type = 'bill' AND source_id = p_bill_id;

    IF b.stock_applied THEN
        PERFORM apply_bill_stock(p_bill_id, -1);
        UPDATE bills SET stock_applied = FALSE WHERE id = p_bill_id;
    END IF;

    UPDATE bills SET status = 'draft', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

-- Bills with settlement derived FIFO from the supplier's ledger balance.
--
-- `settled` is every debit on the supplier's account. On a party ledger those
-- are payments. (An opening balance entered on the debit side would also count
-- here - enter a supplier's opening balance as a credit, which is the normal
-- direction for money owed.)
--
-- `prior` is the total of that supplier's earlier received bills, so each bill
-- is settled only once everything before it has been.
CREATE OR REPLACE VIEW bills_with_paid AS
WITH settled AS (
    SELECT account_id AS supplier_id,
           COALESCE(SUM(debit), 0) AS amount
      FROM journal_lines
     GROUP BY account_id
),
received AS (
    SELECT b.id,
           b.supplier_id,
           b.total,
           COALESCE(SUM(b.total) OVER (
               PARTITION BY b.supplier_id
               ORDER BY b.bill_date, b.bill_number
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0) AS prior
      FROM bills b
     WHERE b.status = 'received'
),
allocated AS (
    SELECT r.id,
           LEAST(r.total, GREATEST(COALESCE(s.amount, 0) - r.prior, 0)) AS paid
      FROM received r
      LEFT JOIN settled s ON s.supplier_id = r.supplier_id
)
SELECT b.*,
       COALESCE(a.paid, 0) AS paid_amount,
       -- A draft or cancelled bill is not a debt, so it has no outstanding.
       CASE WHEN b.status = 'received'
            THEN b.total - COALESCE(a.paid, 0)
            ELSE 0
       END AS outstanding,
       CASE
           WHEN b.status <> 'received'         THEN b.status
           WHEN COALESCE(a.paid, 0) >= b.total THEN 'paid'
           WHEN COALESCE(a.paid, 0) > 0        THEN 'partially_paid'
           ELSE 'unpaid'
       END AS payment_status
  FROM bills b
  LEFT JOIN allocated a ON a.id = b.id;

-- Ageing now reads the view, so it inherits the same FIFO settlement.
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
               b.outstanding,
               -- No due date means due on receipt.
               p_as_of - COALESCE(b.due_date, b.bill_date) AS days_overdue
          FROM bills_with_paid b
         WHERE b.org_id = p_org_id
           AND b.status = 'received'
           AND b.bill_date <= p_as_of
           AND b.outstanding > 0
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

-- 20260801120000_bills_remove_payment_allocation.sql never actually landed on
-- this database (only its unreceive_bill/get_ap_ageing pieces did, later, via
-- the rename migration) - finances_bills_with_paid was still the pre-FIFO view
-- joined to bill_payments, so any bill settled by an ordinary ledger payment
-- (the only way the app pays a supplier now - see BACKEND.md) never showed as
-- paid. bill_payments/pay_bill() were both already dead: nothing in the app
-- writes to either.
--
-- CREATE OR REPLACE VIEW can't be used here: discount_amount/other_expense_amount
-- were added to finances_bills (20260816*) after this view was first created, so
-- `b.*` now expands to more columns than the view's stored shape has at that
-- position - Postgres rejects that as a column rename, not an append. Drop and
-- recreate instead. get_ap_ageing queries this view by name in its body but
-- Postgres doesn't track that as a catalog dependency (only views/rules get
-- that), so CASCADE won't touch it and it doesn't need recreating - it's
-- included below only so a future re-run of this file stays a no-op.
DROP VIEW finances_bills_with_paid CASCADE;
DROP FUNCTION IF EXISTS pay_bill(UUID, DATE, NUMERIC, TEXT);
DROP TABLE IF EXISTS bill_payments;

CREATE VIEW finances_bills_with_paid AS
WITH settled AS (
    SELECT account_id AS supplier_id,
           COALESCE(SUM(debit), 0) AS amount
      FROM finances_journal_lines
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
      FROM finances_bills b
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
  FROM finances_bills b
  LEFT JOIN allocated a ON a.id = b.id;

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
               p_as_of - COALESCE(b.due_date, b.bill_date) AS days_overdue
          FROM finances_bills_with_paid b
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
      JOIN finances_ledgers l ON l.id = ob.supplier_id
     GROUP BY l.id, l.name
     ORDER BY l.name;
$$;

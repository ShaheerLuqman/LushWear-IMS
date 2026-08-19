-- Drops the due-date concept from bills: no due_date column, no
-- payment_terms_days on suppliers (its only purpose was defaulting that due
-- date). AP ageing buckets now key off days-since-bill-date instead of
-- days-overdue-against-due-date.
--
-- finances_bills_with_paid does `SELECT b.*`, so it depends on due_date and
-- has to be dropped and recreated around the column drop (same reasoning as
-- 20260819020000). get_ap_ageing is dropped and recreated regardless, for the
-- not_due -> current column rename.
DROP FUNCTION IF EXISTS get_ap_ageing(UUID, DATE);
DROP VIEW finances_bills_with_paid;

ALTER TABLE finances_bills DROP COLUMN IF EXISTS due_date;
ALTER TABLE finances_ledgers DROP COLUMN IF EXISTS payment_terms_days;

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

CREATE FUNCTION get_ap_ageing(p_org_id UUID, p_as_of DATE)
RETURNS TABLE(
    supplier_id   UUID,
    supplier_name VARCHAR,
    outstanding   NUMERIC,
    current       NUMERIC,
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
               p_as_of - b.bill_date AS days_since_bill
          FROM finances_bills_with_paid b
         WHERE b.org_id = p_org_id
           AND b.status = 'received'
           AND b.bill_date <= p_as_of
           AND b.outstanding > 0
    )
    SELECT l.id,
           l.name,
           SUM(ob.outstanding),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill <= 0), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill BETWEEN  1 AND 30), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill BETWEEN 31 AND 60), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill BETWEEN 61 AND 90), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill > 90), 0)
      FROM open_bills ob
      JOIN finances_ledgers l ON l.id = ob.supplier_id
     GROUP BY l.id, l.name
     ORDER BY l.name;
$$;

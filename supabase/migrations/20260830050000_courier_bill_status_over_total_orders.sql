-- payment_status measured settled orders against RESOLVED orders, so a bill whose
-- delivered orders were all settled read 'paid' while most of its parcels were still in
-- transit - the 25 Aug 2026 PostEx bill showed Paid at 9 settled of 26 orders, next to its
-- own Rs 60,965 remaining_amount. Two contradictory figures on one row, and the badge would
-- have flipped back off 'paid' as the remaining 17 parcels resolved unsettled.
--
-- The denominator is now the bill's whole order count: 'paid' means the courier has settled
-- every order on the bill, which cannot happen until they have all resolved. in_transit is
-- kept for a bill with nothing resolved yet - calling that 'unpaid' would imply money is
-- owed and withheld, when none is due.

CREATE OR REPLACE VIEW shopify_courier_bills_with_totals AS
WITH order_figures AS (
    SELECT o.courier_bill_id AS bill_id,
           LOWER(COALESCE(o.order_status, '')) AS status,
           COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0) AS cod,
           COALESCE(o.advance_amount, 0) AS advance,
           COALESCE(o.delivery_charge, 0) AS delivery,
           COALESCE(o.tax_amount, 0) AS tax,
           COALESCE(o.is_order_settled, FALSE) AS settled
      FROM shopify_orders o
     WHERE o.courier_bill_id IS NOT NULL
),
scored AS (
    SELECT f.*,
           f.status IN ('unfulfilled', 'fulfilled', 'rfd', 'cna', 'ica') AS in_transit,
           f.status IN ('delivered', 'returned') AS resolved,
           CASE
               WHEN f.status NOT IN ('delivered', 'returned') OR f.delivery = 0 THEN NULL
               WHEN f.status = 'returned' THEN -f.delivery
               ELSE f.cod - f.delivery - f.tax
           END AS receivable
      FROM order_figures f
),
in_transit_breakdown AS (
    SELECT bill_id, jsonb_object_agg(status, n) AS by_status
      FROM (
          SELECT s.bill_id, s.status, COUNT(*)::INTEGER AS n
            FROM scored s
           WHERE s.in_transit
           GROUP BY s.bill_id, s.status
      ) per_status
     GROUP BY bill_id
),
totals AS (
    SELECT s.bill_id,
           COUNT(*)::INTEGER AS total_orders,
           COUNT(*) FILTER (WHERE s.in_transit)::INTEGER AS in_transit_count,
           COUNT(*) FILTER (WHERE s.resolved)::INTEGER AS resolved_count,
           COUNT(*) FILTER (WHERE s.resolved AND s.settled AND s.receivable IS NOT NULL)::INTEGER AS settled_count,
           ROUND(SUM(s.cod), 2) AS bill_value,
           ROUND(SUM(s.advance), 2) AS advance_total,
           ROUND(SUM(s.delivery), 2) AS charges,
           ROUND(SUM(s.tax), 2) AS taxes,
           ROUND(COALESCE(SUM(s.cod) FILTER (WHERE s.status = 'returned' AND s.settled), 0), 2) AS returned_total,
           ROUND(COALESCE(SUM(s.receivable) FILTER (WHERE s.resolved AND s.settled), 0), 2) AS received_amount
      FROM scored s
     GROUP BY s.bill_id
)
SELECT b.id,
       b.org_id,
       b.courier,
       b.pickup_date,
       b.status AS workflow_status,
       b.notes,
       b.settled_at,
       b.created_at,
       b.updated_at,
       COALESCE(t.total_orders, 0) AS total_orders,
       COALESCE(t.in_transit_count, 0) AS in_transit_count,
       COALESCE(ib.by_status, '{}'::jsonb) AS in_transit_by_status,
       COALESCE(t.resolved_count, 0) AS resolved_count,
       COALESCE(t.settled_count, 0) AS settled_count,
       COALESCE(t.bill_value, 0) AS bill_value,
       COALESCE(t.advance_total, 0) AS advance_total,
       COALESCE(t.charges, 0) AS charges,
       COALESCE(t.taxes, 0) AS taxes,
       COALESCE(t.returned_total, 0) AS returned_total,
       COALESCE(t.bill_value, 0) - COALESCE(t.returned_total, 0) AS gross_cod,
       COALESCE(t.bill_value, 0) - COALESCE(t.returned_total, 0)
           - COALESCE(t.charges, 0) - COALESCE(t.taxes, 0) AS net_receivable,
       COALESCE(t.received_amount, 0) AS received_amount,
       ROUND(COALESCE(t.bill_value, 0) - COALESCE(t.returned_total, 0)
           - COALESCE(t.charges, 0) - COALESCE(t.taxes, 0)
           - COALESCE(t.received_amount, 0), 2) AS remaining_amount,
       -- Settled orders out of the bill's TOTAL orders, not just its resolved ones, so a
       -- bill still carrying parcels can never read 'paid'.
       CASE
           WHEN COALESCE(t.total_orders, 0) = 0 THEN 'in_transit'
           WHEN t.settled_count = t.total_orders THEN 'paid'
           WHEN t.settled_count = 0 AND COALESCE(t.resolved_count, 0) = 0 THEN 'in_transit'
           WHEN t.settled_count = 0 THEN 'unpaid'
           ELSE 'partially_paid'
       END AS payment_status
  FROM shopify_courier_bills b
  LEFT JOIN totals t ON t.bill_id = b.id
  LEFT JOIN in_transit_breakdown ib ON ib.bill_id = b.id;

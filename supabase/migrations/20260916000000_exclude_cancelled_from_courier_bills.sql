-- Cancelled orders stay linked to their courier_bill_id (membership = which pickup-date
-- batch a parcel was physically handed to the courier in, which does not change on
-- cancellation - see courier_bills.py's module docstring). But shopify_courier_bills_with_totals
-- counted and summed them into total_orders/cost_total/etc regardless of status, unlike
-- post_courier_bill_journal, which has always excluded cancelled orders from the journaled
-- $ total. Bring the view in line with the journal: cancelled orders no longer contribute to
-- a bill's counts or totals.

CREATE OR REPLACE VIEW shopify_courier_bills_with_totals AS
WITH order_figures AS (
    SELECT o.courier_bill_id AS bill_id,
           LOWER(COALESCE(o.order_status, '')) AS status,
           COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0) AS cod,
           COALESCE(o.advance_amount, 0) AS advance,
           COALESCE(o.delivery_charge, 0) AS delivery,
           COALESCE(o.tax_amount, 0) AS tax,
           COALESCE(o.cost_price, 0) AS cost,
           COALESCE(o.is_order_settled, FALSE) AS settled
      FROM shopify_orders o
     WHERE o.courier_bill_id IS NOT NULL
       AND LOWER(TRIM(COALESCE(o.order_status, ''))) <> 'cancelled'
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
           ROUND(SUM(s.cost), 2) AS cost_total,
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
       END AS payment_status,
       COALESCE(t.cost_total, 0) AS cost_total
  FROM shopify_courier_bills b
  LEFT JOIN totals t ON t.bill_id = b.id
  LEFT JOIN in_transit_breakdown ib ON ib.bill_id = b.id;


-- Keep post_courier_bill_journal in sync going forward: today it is only ever invoked from
-- one-off migration backfills, so a bill posted once and then hit by a later cancellation
-- (order 9941/9573's pattern - picked up while active, cancelled weeks afterward) would
-- freeze the journal at its stale, pre-cancellation amount instead of re-excluding the
-- order. post_courier_bill_journal already deletes-and-reposts idempotently
-- (20260913040000_cogs_inventory_period_completion.sql:64-65), so it is safe to call again
-- here; this just wires that up to fire automatically. Statement-level with transition
-- tables, same shape as trg_shopify_orders_sync_cogs_stmt in that same migration, so a bulk
-- status sync re-syncs each affected bill once rather than once per row.
CREATE OR REPLACE FUNCTION trg_shopify_orders_resync_courier_bill_journal_stmt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM post_courier_bill_journal(v.bill_id)
      FROM (
          SELECT DISTINCT n.courier_bill_id AS bill_id
            FROM old_rows o
            JOIN new_rows n ON n.id = o.id
           WHERE n.courier_bill_id IS NOT NULL
             AND (o.order_status IS DISTINCT FROM n.order_status
                  OR o.total_amount IS DISTINCT FROM n.total_amount
                  OR o.advance_amount IS DISTINCT FROM n.advance_amount)
      ) v;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS shopify_orders_resync_courier_bill_journal_trigger ON shopify_orders;
CREATE TRIGGER shopify_orders_resync_courier_bill_journal_trigger
AFTER UPDATE ON shopify_orders
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_shopify_orders_resync_courier_bill_journal_stmt();


-- One-off backfill: re-post every bill that already has a journal entry, so the 4 bills
-- posted on 2026-09-13 (before this trigger existed) are confirmed against current order
-- data too, not just newly-changed ones going forward. Harmless no-op for bills whose
-- amount is already correct (verified for all 4 existing courier_bill_sale entries prior to
-- this migration - see conversation).
DO $$
DECLARE
    v_bill_id UUID;
BEGIN
    FOR v_bill_id IN
        SELECT DISTINCT source_id FROM finances_journal_entries WHERE source_type = 'courier_bill_sale'
    LOOP
        PERFORM post_courier_bill_journal(v_bill_id);
    END LOOP;
END;
$$;

-- Courier payment bills: the settlement bundle for one courier's parcels picked up on one
-- date. Until now these existed only in the browser - buildCourierPaymentReportBills in
-- courier-payment-report.js regrouped them from scratch on every render, and
-- aggregate_courier_bill in services/pdf/courier_bill_summary.py did the same grouping a
-- second time for the PDF. Neither could be referenced, annotated, or settled, and the
-- report could only ever show bills inside the three-period window /orders/ returns.
--
-- Money is NOT stored. Every figure the report shows (bill value, received, remaining,
-- payment status) is a pure function of the member orders, so a stored copy is a second
-- source of truth that goes stale the moment a PostEx CSV lands. courier_bills_with_totals
-- below computes them instead - the same call finances_bills made for paid/partially_paid
-- (20260801090000_bills_schema.sql): "a stored payment status and the payments themselves
-- can drift apart, a computed one cannot".
--
-- What IS stored is what can't be derived: which orders are in the bill, and the human
-- decisions about it (notes, whether you've settled it with the courier).

CREATE TABLE IF NOT EXISTS shopify_courier_bills (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES system_organizations(id),
    courier     VARCHAR(100) NOT NULL,
    pickup_date DATE NOT NULL,
    -- Workflow state only - NOT payment status. Whether the courier has actually paid is
    -- derived in the view from the member orders' is_order_settled. 'settled' here means
    -- you have closed the bill out with the courier and it should stop absorbing new
    -- orders (see assign_courier_bills).
    status      VARCHAR(20) NOT NULL DEFAULT 'open'
                CONSTRAINT shopify_courier_bills_status_check CHECK (status IN ('open', 'settled')),
    notes       TEXT,
    settled_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One bill per courier per pickup date - the same identity the in-memory grouping key
    -- ("dateKey|courier") used, now enforced by the database so two concurrent assignment
    -- runs can't create a duplicate pair.
    CONSTRAINT shopify_courier_bills_org_courier_pickup_key UNIQUE (org_id, courier, pickup_date)
);

CREATE INDEX IF NOT EXISTS idx_shopify_courier_bills_org_pickup
    ON shopify_courier_bills (org_id, pickup_date DESC);

ALTER TABLE shopify_courier_bills ENABLE ROW LEVEL SECURITY;

-- Membership lives on the order, not in a join table: an order belongs to exactly one bill
-- by construction (its own courier + its own pickup date), so a join table would permit
-- states the domain does not have. ON DELETE SET NULL - deleting a bill unassigns its
-- orders rather than deleting them.
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS courier_bill_id UUID
    REFERENCES shopify_courier_bills(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_courier_bill_id
    ON shopify_orders (courier_bill_id) WHERE courier_bill_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- assign_courier_bills
-- ---------------------------------------------------------------------------
-- Find-or-create the bill for every order that has a pickup date and either no bill yet or
-- a bill that no longer matches its courier/pickup date, and stamp courier_bill_id onto it.
--
-- This is what keeps bills current as orders change. Rather than teaching each of the ten
-- shopify_orders write sites to maintain bill state, they call this once afterwards: it is
-- idempotent, so calling it after a write that changed nothing relevant is free. Orders
-- with no courier_pickup_date are left unassigned - they can't be placed on the pickup-date
-- timeline, and the report excludes them by the same rule.
--
-- p_order_ids limits the scan to the orders a caller just touched; NULL means the whole org
-- (the backfill at the bottom of this file, and any repair run).
--
-- Orders are never moved OUT of a bill already marked settled: a courier correcting a
-- pickup date after you have closed the bill would otherwise silently change what you
-- already agreed and paid against. Those orders keep their existing bill and are returned
-- in the `blocked` column so the caller can surface them.
CREATE OR REPLACE FUNCTION assign_courier_bills(
    p_org_id UUID,
    p_order_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(assigned INTEGER, blocked UUID[])
LANGUAGE plpgsql
AS $$
DECLARE
    v_assigned INTEGER := 0;
    v_blocked UUID[];
BEGIN
    -- Candidates: orders whose correct bill differs from the one they currently point at.
    -- The courier is normalized the same way the frontend did it (trim, blank -> 'Unknown')
    -- so an order with a missing courier still lands somewhere rather than being skipped.
    -- The pickup date is taken in PKT (matching app.timezones.PKT_TIMEZONE) rather than
    -- UTC: a parcel collected at 2am PKT belongs to that morning's pickup run, not to the
    -- previous calendar day the UTC instant falls on. 'Asia/Karachi', not '+05' - for a
    -- timestamptz, AT TIME ZONE reads a bare '+05' with POSIX's inverted sign convention
    -- and shifts the wrong way, putting every late-evening UTC pickup on the day before.
    CREATE TEMP TABLE IF NOT EXISTS _candidates (
        id UUID,
        courier VARCHAR(100),
        pickup_date DATE,
        current_bill_id UUID
    ) ON COMMIT DROP;
    TRUNCATE _candidates;

    INSERT INTO _candidates (id, courier, pickup_date, current_bill_id)
    SELECT o.id,
           COALESCE(NULLIF(BTRIM(o.courier), ''), 'Unknown'),
           (o.courier_pickup_date AT TIME ZONE 'Asia/Karachi')::DATE,
           o.courier_bill_id
      FROM shopify_orders o
     WHERE o.org_id = p_org_id
       AND o.courier_pickup_date IS NOT NULL
       AND (p_order_ids IS NULL OR o.id = ANY(p_order_ids));

    -- Drop the ones already sitting on the right bill - nothing to do for them.
    DELETE FROM _candidates c
     USING shopify_courier_bills b
     WHERE b.id = c.current_bill_id
       AND b.courier = c.courier
       AND b.pickup_date = c.pickup_date;

    SELECT COALESCE(ARRAY_AGG(c.id), '{}')
      INTO v_blocked
      FROM _candidates c
      JOIN shopify_courier_bills b ON b.id = c.current_bill_id
     WHERE b.status = 'settled';

    DELETE FROM _candidates c
     USING shopify_courier_bills b
     WHERE b.id = c.current_bill_id
       AND b.status = 'settled';

    INSERT INTO shopify_courier_bills (org_id, courier, pickup_date)
    SELECT DISTINCT p_org_id, c.courier, c.pickup_date FROM _candidates c
    ON CONFLICT (org_id, courier, pickup_date) DO NOTHING;

    WITH updated AS (
        UPDATE shopify_orders o
           SET courier_bill_id = b.id,
               updated_at = NOW()
          FROM _candidates c
          JOIN shopify_courier_bills b
            ON b.org_id = p_org_id
           AND b.courier = c.courier
           AND b.pickup_date = c.pickup_date
         WHERE o.id = c.id
           AND o.org_id = p_org_id
        RETURNING o.id
    )
    SELECT COUNT(*)::INTEGER INTO v_assigned FROM updated;

    -- A bill can be emptied by reassignment (every order moved to a corrected date). Leave
    -- settled ones alone - an emptied settled bill is a record of what was paid, and is
    -- also the evidence for anything reported in `blocked`.
    DELETE FROM shopify_courier_bills b
     WHERE b.org_id = p_org_id
       AND b.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM shopify_orders o WHERE o.courier_bill_id = b.id);

    RETURN QUERY SELECT v_assigned, COALESCE(v_blocked, '{}');
END;
$$;


-- ---------------------------------------------------------------------------
-- courier_bills_with_totals
-- ---------------------------------------------------------------------------
-- The bill plus every money figure the report shows, computed from its member orders.
-- Mirrors aggregateCourierPaymentReportBill in courier-payment-report.js exactly; that
-- function and aggregate_courier_bill in the PDF service both become readers of this view.
--
-- Formulas, keeping the originals' reasoning:
--   cod            = total_amount - advance_amount, per order (customer-facing COD)
--   bill_value     = SUM(cod)                    - already net of advance
--   returned_total = SUM(cod) over SETTLED returns only - an unsettled return isn't
--                    reconciled with the courier yet, so its value has to stay in
--                    remaining rather than being written off in advance
--   gross_cod      = bill_value - returned_total
--   net_receivable = gross_cod - charges - taxes
--   received       = SUM(receivable) over resolved AND settled orders, where receivable
--                    mirrors computeReceivable in orders-grid.js: NULL unless
--                    delivered/returned with a non-zero delivery_charge, -delivery_charge
--                    for a return, else total - (advance + delivery + tax)
--   remaining      = net_receivable - received
--
-- Rounded to paisa here rather than in the client: float sums leave residues like -5.5e-17
-- that format as "-0.00" on a fully-settled bill.
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
-- Per-status tally of each bill's in-transit orders, for the report's "12 unfulfilled -
-- 3 rfd" breakdown line. A separate grouping pass because jsonb_object_agg needs one row
-- per (bill, status) pair, not the per-order rows `scored` holds.
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
       -- Same ladder as aggregateCourierPaymentReportBill: a bill with no resolved order
       -- yet is in_transit; otherwise paid/unpaid/partially_paid by how many of its
       -- resolved orders the courier has settled.
       CASE
           WHEN COALESCE(t.resolved_count, 0) = 0 THEN 'in_transit'
           WHEN t.settled_count = t.resolved_count THEN 'paid'
           WHEN t.settled_count = 0 THEN 'unpaid'
           ELSE 'partially_paid'
       END AS payment_status
  FROM shopify_courier_bills b
  LEFT JOIN totals t ON t.bill_id = b.id
  LEFT JOIN in_transit_breakdown ib ON ib.bill_id = b.id;


-- Backfill every existing order into its bill. DO block rather than a bare SELECT so this
-- covers every org on the database, not just one.
DO $$
DECLARE
    v_org UUID;
BEGIN
    FOR v_org IN SELECT id FROM system_organizations LOOP
        PERFORM assign_courier_bills(v_org, NULL);
    END LOOP;
END;
$$;

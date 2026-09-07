-- Datetime the order was booked with the courier from the app (see orders.py's
-- _book_one_order). Distinct from courier_pickup_date (when the courier actually
-- collected the parcel, null until a delivery-status fetch) and updated_at (drifts
-- with every later edit). Null for orders fulfilled outside the app or before this
-- column shipped; the Print Airway Bill screen's date range filters on it.

ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ;

-- Approximate history so the screen is usable on day one: courier_pickup_date is the
-- closest real signal, falling back to updated_at.
UPDATE shopify_orders
   SET fulfilled_at = COALESCE(courier_pickup_date, updated_at)
 WHERE fulfilled_at IS NULL
   AND order_status = 'fulfilled'
   AND tracking_number IS NOT NULL
   AND courier IN ('PostEx', 'Couriers Next');

CREATE INDEX IF NOT EXISTS idx_orders_fulfilled_at ON shopify_orders(org_id, fulfilled_at DESC);

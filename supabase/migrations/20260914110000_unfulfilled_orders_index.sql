-- get_unfulfilled_orders (orders.py) filters shopify_orders on org_id + order_status =
-- 'unfulfilled', ordered by order_receiving_date desc - the existing indexes cover org_id
-- and order_status separately (idx_orders_org_id, idx_orders_order_status), leaving
-- Postgres to bitmap-and two single-column indexes and then sort, instead of a single
-- ordered index scan over what's actually a small, hot subset of the table (most orders
-- are not unfulfilled). Same reasoning as idx_shopify_orders_settled_folio.
CREATE INDEX IF NOT EXISTS idx_shopify_orders_unfulfilled
    ON shopify_orders (org_id, order_receiving_date DESC)
    WHERE order_status = 'unfulfilled';

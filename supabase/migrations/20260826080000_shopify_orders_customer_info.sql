-- Customer identity + shipping-address snapshot, captured once per order at sync time
-- (see app/services/shopify_sync.py's _apply_customer_fields) instead of looked up live
-- from Shopify on every read. customer_id is Shopify's numeric customer id - it links an
-- order to that customer's *other* orders in this table, which is what the Order
-- Fulfillment view's customer-status history is computed from. A re-sync only ever adds
-- or refreshes these fields from a non-empty Shopify value; it never blanks out what a
-- previous sync already captured.
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS customer_id BIGINT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS customer_address TEXT;
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS customer_city TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON shopify_orders(customer_id);

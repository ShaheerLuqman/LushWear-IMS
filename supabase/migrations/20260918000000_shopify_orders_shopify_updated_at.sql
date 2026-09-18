  -- Shopify's own last-modified timestamp for the order, as of the payload we last applied.
  -- Webhook delivery is at-least-once but not ordered - a delayed/retried "orders/updated"
  -- can arrive after a newer webhook already landed, carrying a stale (e.g. pre-fulfillment)
  -- snapshot that would otherwise silently revert courier/tracking/order_status back to old
  -- data (2026-09-17: orders 13839/13803 reverted to unfulfilled/Unassigned an hour after
  -- being correctly fulfilled, by a webhook payload older than what was already stored).
  -- _reconcile_one_order compares an incoming payload's updated_at against this column and
  -- skips it outright when it isn't newer.
  ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS shopify_updated_at TIMESTAMPTZ;

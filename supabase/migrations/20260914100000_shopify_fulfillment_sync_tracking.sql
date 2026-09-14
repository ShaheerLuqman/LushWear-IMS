  -- Durable marker for whether a fulfilled order's tracking/tag has actually been pushed to
  -- Shopify (see orders.py's _push_fulfillments_to_shopify / sweep_unsynced_shopify_fulfillments).
  -- That push used to run inline inside the same streaming HTTP response as the courier
  -- booking loop with no durable record of whether it happened - a dropped client connection
  -- could silently skip it with no trace on either side (2026-09-14: 7 orders booked and
  -- billed with Couriers Next, never tagged/fulfilled on Shopify, discovered only by noticing
  -- it missing on Shopify's side). Null now means "still owed to Shopify"; the periodic sweep
  -- retries anything still null a couple of minutes after fulfilled_at.
  ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS shopify_fulfillment_synced_at TIMESTAMPTZ;
  ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS shopify_fulfillment_sync_error TEXT;

  -- Backfill: assume every already-fulfilled order was already pushed under the old inline
  -- behaviour, so the sweep only ever deals with gaps going forward instead of replaying the
  -- store's entire fulfillment history (re-tagging and re-notifying customers) on first deploy.
  UPDATE shopify_orders
    SET shopify_fulfillment_synced_at = fulfilled_at
  WHERE shopify_fulfillment_synced_at IS NULL
    AND order_status = 'fulfilled'
    AND fulfilled_at IS NOT NULL;

  -- Matches the sweep's own query (order_status/synced_at/fulfilled_at) so it stays a quick
  -- index scan instead of a per-org sequential scan as shopify_orders grows.
  CREATE INDEX IF NOT EXISTS idx_shopify_orders_unsynced_fulfillment
      ON shopify_orders (org_id, fulfilled_at)
      WHERE order_status = 'fulfilled' AND shopify_fulfillment_synced_at IS NULL;

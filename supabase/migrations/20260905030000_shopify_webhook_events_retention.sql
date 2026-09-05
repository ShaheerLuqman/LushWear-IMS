-- An idempotency row (20260905010000_shopify_webhook_events.sql) only has to outlive
-- Shopify's retry schedule, so app/routes/shopify_webhooks.py's _prune_old_events deletes
-- anything older than a week. That delete filters on received_at, which the (org_id,
-- webhook_id) primary key can't serve.
CREATE INDEX IF NOT EXISTS shopify_webhook_events_received_at_idx
    ON shopify_webhook_events (received_at);

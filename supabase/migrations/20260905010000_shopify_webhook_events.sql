-- Idempotency guard for Shopify webhooks (Phase 1 of the GraphQL/webhooks
-- migration plan). Shopify webhook delivery is at-least-once, so a retried
-- delivery must not run the per-order reconciliation twice -
-- app/routes/shopify_webhooks.py upserts the incoming X-Shopify-Webhook-Id
-- here first (ignore_duplicates, same idiom as shopify_sync._try_acquire_sync_lock)
-- and skips processing when the row already existed.
CREATE TABLE IF NOT EXISTS shopify_webhook_events (
    org_id      UUID NOT NULL REFERENCES system_organizations(id),
    webhook_id  TEXT NOT NULL,
    topic       TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, webhook_id)
);

ALTER TABLE shopify_webhook_events ENABLE ROW LEVEL SECURITY;

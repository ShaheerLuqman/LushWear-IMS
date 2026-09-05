-- Webhook routing (app/routes/shopify_webhooks.py) resolves org_id from the
-- shop domain Shopify sends in X-Shopify-Shop-Domain, so it needs a lookup
-- path from shopify_store_url back to org_id. Unique (not just indexed) so
-- two orgs can't silently end up configured against the same store - a
-- webhook for it would only ever be routable to one of them anyway. Partial:
-- most rows predate Shopify being connected at all.
CREATE UNIQUE INDEX IF NOT EXISTS system_integration_settings_shopify_store_url_idx
    ON system_integration_settings (shopify_store_url)
    WHERE shopify_store_url IS NOT NULL;

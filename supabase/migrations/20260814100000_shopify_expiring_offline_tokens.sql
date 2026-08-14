-- Shopify now requires "expiring" offline access tokens for Public apps created
-- on/after 2026-04-01 (existing apps must migrate by 2027-01-01) - a plain
-- access_token from the classic OAuth grant is rejected by the Admin API
-- outright. shopify_refresh_token exchanges for a fresh access_token before
-- shopify_token_expires_at; see app/org_settings.py's ensure_valid_shopify_token
-- and https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
ALTER TABLE system_integration_settings
    ADD COLUMN IF NOT EXISTS shopify_refresh_token    TEXT,
    ADD COLUMN IF NOT EXISTS shopify_token_expires_at TIMESTAMPTZ;

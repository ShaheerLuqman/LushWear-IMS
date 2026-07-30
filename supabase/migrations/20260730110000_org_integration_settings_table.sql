-- Org-scoping cutover, part 5 (ORGANIZATIONS_USERS_PLAN.md Phase 2). Per-org
-- Shopify/PostEx credentials, replacing the global SHOPIFY_*/POSTEX_MERCHANT_TOKEN
-- env vars - once a second org exists, those global env vars would otherwise
-- point every org's "Sync from Shopify" button at the same (first org's) store.
--
-- shopify_access_token/postex_merchant_token are encrypted at the app layer
-- (Fernet, via app/org_settings.py using SETTINGS_ENCRYPTION_KEY) before being
-- stored here - never plaintext, unlike this app's own password hashes, since
-- these are third-party secrets belonging to external clients.
CREATE TABLE IF NOT EXISTS org_integration_settings (
    org_id                UUID PRIMARY KEY REFERENCES organizations(id),
    shopify_store_url     TEXT,
    shopify_access_token  TEXT,
    -- Per-org override; falls back to a shared default (app/org_settings.py)
    -- when unset - it isn't sensitive, so no need to force every org to set it.
    shopify_api_version   TEXT,
    postex_merchant_token TEXT,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same defense-in-depth reasoning as 20260730100000 (not the load-bearing
-- control - the backend's secret key bypasses this regardless).
ALTER TABLE org_integration_settings ENABLE ROW LEVEL SECURITY;

-- Persists the last-synced-at timestamp per sync type (currently only the
-- Shopify orders sync), so the API can expose "last synced" without running
-- a sync, and gate auto-sync on staleness. Single-row-per-id pattern, same as
-- app_pin.

CREATE TABLE IF NOT EXISTS sync_status (
    id             TEXT PRIMARY KEY,
    last_synced_at TIMESTAMPTZ NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sync_status ENABLE ROW LEVEL SECURITY;

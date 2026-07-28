-- Persists the last-synced-at timestamp per sync type (currently only the
-- Shopify orders sync), so the API can expose "last synced" without running
-- a sync, and gate auto-sync on staleness. Single-row-per-id pattern, same as
-- app_pin.
--
-- in_progress/lock_acquired_at implement a lock so overlapping sync triggers
-- (the periodic backend sync, a manual sync, multiple instances) don't run
-- concurrently: acquiring the lock is a single conditional UPDATE (only
-- matches when unlocked or the lock is stale), which Postgres serializes at
-- the row level - no advisory lock needed, and advisory locks don't survive
-- PostgREST's connectionless request model anyway.

CREATE TABLE IF NOT EXISTS sync_status (
    id               TEXT PRIMARY KEY,
    last_synced_at   TIMESTAMPTZ,
    in_progress      BOOLEAN NOT NULL DEFAULT FALSE,
    lock_acquired_at TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sync_status ENABLE ROW LEVEL SECURITY;

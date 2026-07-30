-- Makes POST /auth/bootstrap (creates the first org + first admin user)
-- race-free. Same single-row-by-fixed-id pattern as app_pin (id='default').
-- The route inserts this row with ON CONFLICT DO NOTHING and only proceeds if
-- the insert actually affected a row, instead of a plain "SELECT COUNT(*)
-- FROM users" check, which would be a TOCTOU race under concurrent requests.
CREATE TABLE IF NOT EXISTS system_bootstrap (
    id           TEXT PRIMARY KEY DEFAULT 'default',
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

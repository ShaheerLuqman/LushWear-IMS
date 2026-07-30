-- Foundation for the Organizations & Users migration (replaces the single shared
-- app-PIN, see ORGANIZATIONS_USERS_PLAN.md). One row per business
-- (`organizations`), one row per login (`users`), each user scoped to exactly
-- one org. `role` is kept as open text with a CHECK constraint rather than a
-- Postgres ENUM, matching this repo's existing convention for small fixed
-- value sets (see order_status/advance_status).
CREATE TABLE IF NOT EXISTS organizations (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id        UUID NOT NULL REFERENCES organizations(id),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id);

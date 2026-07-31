-- Multi-Org User Membership plan. Splits identity from org access: `users`
-- becomes pure identity (email/password, plus the platform-level
-- is_superadmin flag), and `org_memberships` becomes the actual source of org
-- access - one row per (person, org) pair, so the same identity can hold a
-- different role in each org they belong to. Also decouples "superadmin"
-- from org_id entirely (it was bolted onto users.role + a nullable org_id in
-- the Superadmin Portal migration) - a superadmin can now also hold real
-- memberships, logging into an org normally as themselves in addition to
-- using the portal's impersonate feature for any other org.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS org_memberships (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_org_id ON org_memberships(org_id);

-- Same defense-in-depth reasoning as organizations/users (20260730100000) -
-- not the load-bearing control, since the backend's secret key bypasses this
-- regardless.
ALTER TABLE org_memberships ENABLE ROW LEVEL SECURITY;

-- Backfill: today's direct org_id/role/is_active columns become real
-- membership rows before they're dropped below. Superadmin rows are excluded
-- (they never had a real org - see the users_org_id_required_unless_superadmin
-- constraint being dropped in this same migration).
INSERT INTO org_memberships (user_id, org_id, role, is_active, created_at)
SELECT id, org_id, role, is_active, created_at
FROM users
WHERE role <> 'superadmin' AND org_id IS NOT NULL
ON CONFLICT (user_id, org_id) DO NOTHING;

UPDATE users SET is_superadmin = true WHERE role = 'superadmin';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_id_required_unless_superadmin;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP COLUMN IF EXISTS org_id;
ALTER TABLE users DROP COLUMN IF EXISTS role;
ALTER TABLE users DROP COLUMN IF EXISTS is_active;

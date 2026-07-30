-- Superadmin Portal (see Superadmin Portal plan following on from
-- ORGANIZATIONS_USERS_PLAN.md). Adds a platform-level `superadmin` role - a
-- user account not scoped to any single business org, so it can create new
-- organizations and configure any org's Shopify/PostEx credentials during
-- onboarding. org_id becomes nullable, but only for superadmins: the second
-- constraint below enforces that pairing at the DB level rather than trusting
-- app code alone, since a raw SQL edit could otherwise silently violate it.
ALTER TABLE users ALTER COLUMN org_id DROP NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'staff', 'superadmin'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_id_required_unless_superadmin;
ALTER TABLE users ADD CONSTRAINT users_org_id_required_unless_superadmin
    CHECK ((role = 'superadmin' AND org_id IS NULL) OR (role <> 'superadmin' AND org_id IS NOT NULL));

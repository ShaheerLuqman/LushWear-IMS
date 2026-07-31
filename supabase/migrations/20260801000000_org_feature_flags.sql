-- Feature Access plan: per-org toggles controlling which top-level app
-- sections (Shopify order management, Finance) an org's users can see and
-- use. Purely additive - existing orgs default to both features enabled, so
-- nothing changes for them until a superadmin explicitly disables one via
-- the Superadmin Portal. New feature keys get appended as new sections ship
-- (see backend/app/features.py's ALL_FEATURES).

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS enabled_features TEXT[] NOT NULL DEFAULT ARRAY['orders', 'finance'];

-- Adds a display name to users - identity was email-only before this, with
-- no human-readable name anywhere in the app (sidebar, user lists). Nullable
-- default so existing rows aren't broken; new identities (bootstrap,
-- add-user, create-org-admin) require one going forward via app-level
-- validation (NonBlankStr), not a DB constraint.

ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';

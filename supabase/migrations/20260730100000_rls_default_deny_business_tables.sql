-- Org-scoping cutover, part 4 (ORGANIZATIONS_USERS_PLAN.md Phase 2). Enables
-- RLS on every business table with NO policies - default-deny for the anon/
-- authenticated roles.
--
-- This is defense-in-depth hygiene, NOT the load-bearing access control:
-- backend/app/database.py always connects with the Supabase secret/service-
-- role key, which bypasses RLS entirely regardless of what's enabled here.
-- The actual enforcement is app.org_scope.org_table() (see that module's
-- docstring) plus tests/test_org_scope_lint.py, which fails the build if any
-- route/service bypasses it. This migration only protects against a future
-- accidental use of the anon/publishable key reading these tables directly.
ALTER TABLE products                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_sheet_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledgers                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_daily_balances  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_balances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_entry_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_status              ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                    ENABLE ROW LEVEL SECURITY;
-- org_integration_settings doesn't exist yet at this point in migration order -
-- its RLS is enabled in 20260730110000_org_integration_settings_table.sql instead.

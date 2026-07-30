-- Cleanup (ORGANIZATIONS_USERS_PLAN.md Phase 4). The single shared app-PIN was
-- retired in Phase 2 (routes/app_pin.py's /verify and /setup returned 410, then
-- the whole route was removed in Phase 4) once every login went through
-- email+password (routes/auth.py) instead. Drop its now-unused tables/function.
DROP FUNCTION IF EXISTS record_pin_lockout_failure(TEXT, INT, INT);
DROP TABLE IF EXISTS pin_lockouts;
DROP TABLE IF EXISTS app_pin;

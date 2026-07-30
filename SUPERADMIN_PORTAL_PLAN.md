# Superadmin Portal — Implementation Plan

**Status: ✅ implemented (backend + frontend), migration not yet applied to the real Supabase DB.**

## Context

`ORGANIZATIONS_USERS_PLAN.md`'s 4 phases (multi-tenancy, per-org users/roles, per-org Shopify/PostEx credentials, PIN retirement) are fully implemented and applied. That plan explicitly deferred one thing as out-of-scope: **"Full Admin Portal UI (cross-org superadmin screens) — creating new organizations stays a manual/internal operation for now."**

Before this, there was genuinely no supported way to onboard org #2: `POST /auth/bootstrap` only ever works once (blocked by the `system_bootstrap` singleton after LushWear's setup), and there was no user role that isn't scoped to exactly one org.

Confirmed with the user:
- **Auth model**: a new `superadmin` role on a real user account (not a shared secret/token, not piggybacking on the existing LushWear admin).
- **Scope**: create an org + its first admin user in one step, list orgs, and configure any org's Shopify/PostEx integration credentials during onboarding.
- **UI location**: a separate standalone page, not part of the main business-facing frontend.
- **Also confirmed**: the superadmin needs to be able to open an individual org's actual business app (orders/products/cashbook, etc.) for support/debugging — a "View as org" action.
- **Also confirmed**: while impersonating, the superadmin can switch directly to a different org from within the main app, without returning to the portal tab each time.
- **Explicitly deferred (separate decision)**: real business users belonging to more than one organization is out of scope for this pass — see `TODO.md`'s "Real multi-org user membership" item.

## Key design decisions

- `users.org_id` is nullable, but only for `role='superadmin'` — a DB-level CHECK constraint enforces the pairing, not just app-code discipline.
- `Role` (JWT/admin-portal, includes `"superadmin"`) and `OrgRole` (org-scoped user management, `admin`/`staff` only) are deliberately separate Pydantic types — widening the wrong one would let an org admin grant themselves `superadmin` via the existing `POST/PUT /users` routes.
- No public bootstrap endpoint for the first superadmin — a one-off management script (`backend/scripts/create_superadmin.py`) instead, since this is a rare, high-privilege operation with an operator (not an end user) on the other end.
- RLS is a non-issue (`users`/`organizations` already have it enabled, defense-in-depth only; the backend's service-role key bypasses it regardless, same as everywhere else).
- The real security boundary is the server-side role check + password, not the portal page being a separate URL.
- **"View as org"** mints a short-lived (1 hour) token via `POST /admin/organizations/{org_id}/impersonate`, with `sub` set to the superadmin's own id (stays attributable) and an `impersonating: true` claim.
- **Switching orgs mid-impersonation** reuses the same impersonation token rather than juggling two tokens in one browser tab: a new `require_superadmin_or_impersonating` dependency allows `GET /admin/organizations` and the impersonate route to be called either by a real superadmin token or by an already-impersonating one (since an impersonating token could only ever have been minted by a real superadmin to begin with). Every other `/admin/*` route (create org, integration-settings) stays strictly superadmin-only.
- Emergent, not special-cased: `GET /auth/me` looks up by `sub`, so while impersonating it still returns the superadmin's real identity (`role="superadmin"`) rather than the impersonated org-admin role — this correctly keeps the main app's Users/Integrations panels hidden during impersonation (they gate on a live `role === "admin"` lookup), funneling org administration through the one portal.

## What was built

**Backend**:
- Migration `supabase/migrations/20260730130000_add_superadmin_role.sql` (mirrored in `supabase_schema.sql`) — `org_id` nullable + the two CHECK constraints.
- `backend/app/models.py` — `OrgRole`/widened `Role`, `SuperadminOrgCreate`, `OrganizationWithAdmin`, `AccountPublic` (needed so `GET /auth/me` can represent a superadmin's `org_id=None` row, which `UserPublic`'s org-scoped shape can't).
- `backend/app/auth.py` — `create_token()` gained `ttl_hours`/`impersonating` params; new `require_superadmin_or_impersonating` dependency.
- `backend/app/org_settings.py` — extracted `to_public_shape()` so both the self-service and superadmin integration-settings routes share it.
- `backend/app/routes/admin_portal.py` (new) — `GET /organizations`, `POST /organizations`, `POST /organizations/{id}/impersonate`, `GET`/`PUT /organizations/{id}/integration-settings`, with the two-tier authorization split above.
- `backend/scripts/create_superadmin.py` (new) — one-off CLI to create the first superadmin.
- `backend/tests/test_admin_portal.py` (new, 10 tests) — including explicit coverage of the authorization asymmetry between a plain admin token, an impersonating token, and a real superadmin token.

**Frontend**:
- `frontend/admin.html` + `frontend/js/admin.js` (new) — standalone portal page: login, org list, create-org form, integration-settings panel per org, "View as org" button.
- `frontend/js/app-core.js` — `consumeImpersonationToken()` (reads `#impersonate=<token>` on load, mirroring the existing `applyStartupDeepLink()` pattern), `decodeTokenPayload()`, `initImpersonationBanner()` (shows a banner + org switcher in the main app only while impersonating).

## Verification

- **Automated**: 206/206 backend tests passing (196 pre-existing + 10 new).
- **Manual smoke test done**: backend boots cleanly, all 5 `/api/admin/*` routes registered, correctly 401 without a token.
- **Not yet done**:
  - Apply `20260730130000_add_superadmin_role.sql` to the real Supabase DB (repeat the local-Postgres-copy verification used for the earlier org-scoping migration before doing so).
  - Run `create_superadmin.py` to create the first real superadmin.
  - Full end-to-end click-through: create a second org via the portal, confirm it starts empty, configure its integrations, use "View as org" and the in-app switcher.

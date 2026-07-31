# Multi-Org User Membership — Implementation Plan

**Status: ✅ implemented (backend + frontend), migration not yet applied to the real Supabase DB.**

## Context

Before this, one `users` row = one email = exactly one org (`users.org_id`/`users.role` were direct columns), and the Superadmin Portal's `superadmin` role was bolted onto that same `role` column with `org_id` made nullable just for that one value. This shipped to let a real person belong to more than one organization (e.g. someone who owns/manages multiple client businesses) and switch between them — the thing deferred when the Superadmin Portal shipped (`TODO.md`'s former "Real multi-org user membership" item).

Confirmed with the user:
- **Adding an existing email to a new org grants instant membership** — no invite/accept step.
- **Login stays a single API call, no picker screen.** Defaults to the last-used org (client-side, `localStorage`) or the first membership on a fresh login; a sidebar switcher handles moving between orgs afterward.
- **`superadmin` became a pure identity-level flag** (`users.is_superadmin`), fully decoupled from org membership — superseding the Superadmin Portal's original `role='superadmin'` + nullable-`org_id` design. A superadmin can now also hold genuine memberships (log into an org normally as themselves) in addition to using the portal's impersonate feature for any other org.

## Key design decisions

- **Identity/membership split.** `users` is now pure identity (`id`, `email`, `password_hash`, `is_superadmin`, timestamps) — no more `org_id`/`role`/`is_active`. `org_memberships` (`user_id`, `org_id`, `role` CHECK admin/staff, `is_active`, `created_at`, composite PK) is the actual source of org access — one row per (person, org) pair, so the same identity can hold a different role in each org.
- **`is_active` lives on the membership, not the identity** — deactivating someone in Org A doesn't touch their access to Org B.
- **JWT shape barely changed.** A token still carries `org_id`/`role` for the *current* session's org context, plus a top-level `is_superadmin` claim independent of that context. `get_org_id`, `require_role("admin")`, and `org_scope.py` were untouched — they only ever cared about "this session's current org/role."
- **Two new endpoints mirror the Superadmin Portal's existing ones**:
  - `GET /auth/my-organizations` — orgs the caller has an active membership in (vs. `GET /admin/organizations`, which lists *every* org for superadmins).
  - `POST /auth/switch-org` — verifies an active membership before minting a token for it (`impersonating` stays false — this is a real session), vs. `POST /admin/organizations/{id}/impersonate`, which bypasses the membership check entirely.
- **The sidebar switcher was generalized, not rebuilt.** `initOrgSwitcher()` branches on `impersonating`: true → `/admin/organizations` + `/impersonate` (superadmin, shows "Exit"); false → `/auth/my-organizations` + `/auth/switch-org` (real member, no "Exit", hidden entirely if there's only one org to begin with).
- **Instant silent grant shares one helper**, `backend/app/memberships.py`'s `get_or_create_identity()`/`add_membership()`, used by both `routes/users.py` (add a user to my org) and `routes/admin_portal.py` (create org + first admin) — an email that already exists elsewhere gets a membership, not a rejected duplicate.

## What was built

**Backend**:
- Migration `supabase/migrations/20260730140000_org_memberships_table.sql` (mirrored in `supabase_schema.sql`) — adds `users.is_superadmin`, creates `org_memberships`, backfills existing `org_id`/`role`/`is_active` into it, then drops those columns from `users`.
- `backend/app/memberships.py` (new) — `get_or_create_identity()`, `add_membership()`.
- `backend/app/auth.py` — `create_token()` gained `is_superadmin`; new `require_superadmin` dependency; `require_superadmin_or_impersonating` now checks `is_superadmin` instead of `role == "superadmin"`.
- `backend/app/models.py` — `OrgRole` is now the only role type (no more wide `Role` including `"superadmin"`); `UserCreate.password` optional; `AccountPublic` rebuilt from identity + token claims (not a static DB row); new `MyOrganization`, `SwitchOrgBody`.
- `backend/app/routes/auth.py` — `/login` resolves active memberships (mints against the first one, or `org_id=None` for a pure superadmin); `/bootstrap` creates identity + membership as two inserts; `/me` blends identity with the token's current org/role; new `GET /auth/my-organizations`, `POST /auth/switch-org`.
- `backend/app/routes/users.py` — rewritten against `org_memberships` joined with `users.email`; `create_user` uses the shared identity/membership helpers; the "last active admin" guard now checks membership rows.
- `backend/app/routes/admin_portal.py` — `require_role("superadmin")` → `require_superadmin`; `create_organization` reuses the shared helpers (instant grant applies here too).
- `backend/scripts/create_superadmin.py` — simplified to just `is_superadmin=True`, no `org_id`/`role`.
- Tests: `test_admin_portal.py` fixtures moved to `is_superadmin`; `test_auth.py` gained login (0/1/N memberships, superadmin-with-no-memberships), `/auth/my-organizations`, `/auth/switch-org` coverage; new `test_users_routes.py` (9 tests) covering instant-grant-to-existing-email and the per-membership last-admin guard.

**Frontend**:
- `frontend/js/app-core.js` — `resolveSuperadminHomeOrgToken()` kept for the pure-superadmin case; new `switchToLastUsedOrgIfDifferent()` for anyone who logs in with an existing membership; `initImpersonationBanner()` replaced by `initOrgSwitcher()` (same sidebar nav item + popup menu, now shown for *any* multi-org session, not just impersonation - drops "Exit" when the session isn't actually impersonating).
- `frontend/js/auth-users.js` + `index.html` — Settings > Users' "Add user" password field is now optional, with a hint that a blank password means the email already has an account elsewhere.
- `frontend/js/admin.js` — portal access check moved from `me.role === 'superadmin'` to `me.is_superadmin === true`.

## Verification

- **Automated**: 220/220 backend tests passing (211 pre-existing + 9 new in `test_users_routes.py`).
- **Not yet done**:
  - Apply `20260730140000_org_memberships_table.sql` to the real Supabase DB — repeat the local-Postgres-copy verification used for previous migrations first, since this one drops columns off the live `users` table (unlike the Superadmin Portal's purely-additive migration).
  - Full end-to-end click-through: grant a second membership to one identity across two orgs via Settings > Users, log in as that person, confirm the sidebar switcher shows both real orgs with no "Exit" option, switch between them, and confirm deactivating them in one org doesn't affect the other; confirm a superadmin who is also a real member of an org can log in normally into it (not just via impersonation).

# Organizations, Users & Roles — Implementation Plan

## Context

LushWear-IMS is currently gated by a single shared app-wide PIN (`backend/app/routes/app_pin.py`) with no concept of individual users — every caller who knows the PIN gets an identical JWT (`{sub: "app"}`) and identical access. The business plans to onboard additional client companies onto this same app instance, each as its own **Organization** with its own **Users** and **roles**, with data fully isolated between organizations. `auth.py`'s own docstring and `TODO.md` already earmark this as the next step ("do it before you have a second user, not after").

Confirmed with the user: this is **true multi-tenancy** (not just multiple staff logins for one business) — LushWear becomes org #1, and more client orgs will be created over time, each with multiple users. Auth stays the **existing lightweight custom JWT** in `auth.py` (not a migration to Supabase Auth) — extended with real claims.

Because a second org is expected to onboard soon after this ships, **org-scoping must be correct from day one**, not deferred as a "phase 2 someday." The plan below sequences the work so nothing half-migrated is left exposed.

## Key architectural decisions

- **Multi-tenancy**: every business table gets an `org_id`. Rollout starts with exactly one org (LushWear), seeded via a one-time bootstrap; more orgs are added later as a manual/internal operation (full multi-org admin UI is out of scope here — separate "Admin Portal" backlog item).
- **Auth**: extend `auth.py`'s existing JWT rather than adopting Supabase Auth. New claim shape: `{sub: user_id, org_id, role, iat, exp}`. `require_auth`'s signature and its wiring in `main.py` (`dependencies=[Depends(require_auth)]` per-router) do **not** change — only what's inside the token and what routes do with the returned payload.
- **Username = email address.** Globally unique in practice, no org-selector needed on the login form, and sets up password-reset-by-email later with no schema change.
- **RLS is not the real enforcement boundary.** `backend/app/database.py` always connects with the Supabase **secret/service-role key**, which bypasses RLS entirely — confirmed no RLS is even enabled today despite `BACKEND.md` claiming otherwise. RLS gets enabled anyway (cheap, correct hygiene, protects a future accidental anon-key use), but the **real** enforcement is a single required chokepoint every business-table query must go through, backed by a lint check — not 80+ hand-added `.eq("org_id", ...)` calls trusted to all be correct forever.
- **PIN is retired, not run long-term in parallel.** PIN-issued tokens carry no `org_id` claim. If `/app-pin/verify`/`/app-pin/setup` stayed live through org-scoping going live, they'd become an undocumented backdoor into org #1. They get disabled at the **start** of the org-scoping phase, not deferred to final cleanup.
- **Per-org third-party credentials.** `SHOPIFY_STORE_URL`/`SHOPIFY_ADMIN_API_TOKEN`/`SHOPIFY_API_VERSION`/`POSTEX_MERCHANT_TOKEN` are currently global env vars (`backend/app/config.py`'s `Settings`), read inline in 3 places: `app/shopify.py`, `app/services/shopify_orders.py`, and 2 call sites in `app/routes/orders.py`. Once org #2 exists these must become per-org DB rows, not shared env vars — otherwise a second org's "Sync from Shopify" button would pull **LushWear's** store into their own data. Encrypted at rest via a new `SETTINGS_ENCRYPTION_KEY` env var (same fail-fast-in-prod pattern as `AUTH_SECRET`) — these are real third-party secrets belonging to external clients (a leaked Shopify token exposes a client's whole store), not just this app's own credentials, so they get a higher bar than the app's own password hashes.

## Phase 1 — Foundation (new auth substrate; PIN still live) — ✅ implemented, migrations not yet applied

**Not yet done: run the 3 new migrations against the real Supabase DB** (this backend has no direct Postgres driver, only the REST client, so this can't be applied from the codebase itself) - `20260730040000_organizations_and_users_tables.sql`, `20260730050000_login_lockouts_table.sql`, `20260730060000_system_bootstrap_table.sql`.

**New migrations** (`supabase/migrations/`, mirrored into `supabase_schema.sql` per this repo's convention):
- `organizations` (`id UUID PK`, `name`, `created_at`)
- `users` (`id UUID PK`, `org_id FK -> organizations`, `email UNIQUE NOT NULL`, `password_hash`, `role TEXT CHECK IN ('admin','staff')`, `is_active BOOLEAN DEFAULT true`, `created_at`, `updated_at`)
- `login_lockouts` — same shape/pattern as today's `pin_lockouts` (atomic `SELECT ... FOR UPDATE` RPC, copy `record_pin_lockout_failure`'s pattern into `record_login_lockout_failure`), keyed by `email`. Also confirm/add a `@limiter.limit(...)` on `POST /auth/login` (slowapi) so there's an IP-side backstop in addition to the email-keyed lockout — an email-only lock lets anyone who knows a real address (e.g. a public support inbox) lock that account out for free.
- `system_bootstrap` — singleton row (`id TEXT PK DEFAULT 'default'`, `completed_at`), same pattern as `app_pin`'s single `id='default'` row. Used to make the one-time bootstrap race-free: `INSERT ... ON CONFLICT DO NOTHING`, proceed only if the insert actually affected a row (avoids a TOCTOU race from a plain "SELECT COUNT(*) FROM users" check).

**`backend/app/models.py`**: add `Organization`, `OrganizationCreate`, `User`, `UserCreate`, `UserPublic` (no `password_hash`), `UserUpdate` (role/is_active), `LoginBody`, `BootstrapBody`.

**`backend/app/auth.py`**:
- `create_token(user_id, org_id, role)` → new claim shape.
- `require_auth` keeps its current signature/return shape (decoded payload dict) — `main.py`'s wiring is untouched.
- New `require_role(*roles)` dependency factory for admin-gated routes.
- Generalize the bcrypt hash/verify helpers currently in `app_pin.py` (`_hash_pin`/`_verify_pin`) for reuse on user passwords.

**`backend/app/routes/auth.py`** (new, public router):
- `GET /auth/status` — mirrors today's PIN "configured" check, but "does any user exist yet."
- `POST /auth/bootstrap` — creates the first org + first admin user. Race-free via the `system_bootstrap` singleton insert. In production (`APP_ENV=production`), additionally require a `BOOTSTRAP_TOKEN` header — mirrors `main.py`'s existing fail-fast pattern for must-not-ship-half-configured concerns (`AUTH_SECRET`, `ALLOWED_ORIGINS` checks) — so this permanently-mounted endpoint isn't a live unauthenticated org-creation hole after the one time it's used.
- `POST /auth/login` — email+password, lockout via `login_lockouts`.
- `GET /auth/me` — current user's profile from the token, for the frontend's logged-in-as indicator.

**`backend/app/routes/users.py`** (new, `require_role("admin")`): list/create/update-role/deactivate users, scoped to the caller's own `org_id`.

**`backend/app/main.py`**: mount `auth.router` (public, like `app_pin.router` today) and `users.router` (protected + role-gated). `app_pin.router` stays mounted through this phase — it's disabled in Phase 2, not here.

**Tests**: login success/failure/lockout (mirrors `backend/tests/test_app_pin_lockout.py`'s structure), bootstrap race behavior, `require_role` gating.

## Phase 2 — Org-scoping cutover (the correctness-critical phase)

1. **Disable PIN login first, as step one of this phase**: `/app-pin/verify` and `/app-pin/setup` return `410 Gone` (or are removed outright). Already-issued PIN tokens simply age out within their existing 7-day TTL — no need to force-revoke.

2. **One chokepoint, not 80+ scattered call sites.** Add a small helper (e.g. `backend/app/org_scope.py`) that every business-table read/write goes through instead of calling `get_supabase().table(...)` directly — it takes the caller's `org_id` and applies the filter/stamp in one place. Back it with a lint check (grep/AST-based test that fails if any route or service file calls `.table(<business-table-name>)` directly, bypassing the wrapper). **This wrapper + lint is the actual enforcement mechanism** — treat the RLS policies below as hygiene, not as the thing actually protecting cross-org data.

3. Add `org_id UUID NOT NULL REFERENCES organizations(id)` (nullable → backfill to the LushWear org → `NOT NULL` → index) to: `products`, `variants`, `orders`, `load_sheet_logs`, `ledgers`, `cashbook_entries`, `cashbook_daily_balances`, `ledger_balances`, `cashbook_entry_audit_log`, **and `sync_status`** (it's a singleton row today; without `org_id` one org's sync would clobber another's `last_synced_at`/lock state).

4. **`orders.order_number` uniqueness fix.** It's currently a single-column globally-`UNIQUE INTEGER` — once a second org syncs its own Shopify store, its order numbers can collide with org #1's. Migration: drop the single-column `UNIQUE`, add `UNIQUE(org_id, order_number)`. Update `backend/app/services/shopify_sync.py`'s upsert (`on_conflict="order_number"` → `on_conflict="org_id,order_number"`), thread `org_id` into every row dict it builds. Do a dedicated grep for `order_number` lookups **outside** `orders.py` (e.g. cashbook/ledger reconciliation via `idx_cashbook_entries_folio_order_number`) and add an `org_id` filter to those too — don't assume the route-file call-site sweep in step 6 already covers this service file or these secondary lookups.

5. Update the 3 month-summary RPCs (`get_month_summary_totals`, `get_month_summary_periods`, `get_month_summary_carrier_health`) to take a new `p_org_id` param and filter on it.

6. Sweep `products.py`, `orders.py`, `cashbook.py`, `ledger.py` (82 `supabase.table(` call sites total: orders 42, products 24, cashbook 11, ledger 5) so every read filters by `org_id` and every create/insert stamps it, via the Phase 2.2 wrapper.

7. Enable RLS with default-deny policies on all business tables now that `org_id` exists — cheap defense-in-depth. Document explicitly (migration comment, matching this repo's existing commenting convention) that this is **not** the load-bearing control, since the secret key bypasses it regardless.

8. **Test updates**: `backend/tests/conftest.py`'s `require_auth` override needs `org_id`/`role` added to the fake payload. Add an assertion-capturing fake (records `.table()`/`.upsert()` call args) specifically for the `shopify_sync` on_conflict change — the current `FakeQuery.__getattr__` silently accepts any args, so a wrong/missing `on_conflict` target would pass a green test suite today.

9. **Per-org Shopify/PostEx credentials.** Add `org_integration_settings` (`org_id PK/FK -> organizations`, `shopify_store_url`, `shopify_access_token` encrypted, `shopify_api_version` nullable per-org override — falls back to a shared default if unset, it isn't sensitive so no need to force every org to set it, `postex_merchant_token` encrypted, `updated_at`). Add `app/org_settings.py` with `get_org_integration_settings(org_id)` (fetch + decrypt via `SETTINGS_ENCRYPTION_KEY`) as the **only** place these credentials are read — same chokepoint principle as `org_scope.py` above, not a second set of scattered reads. Refactor the 3 existing inline-`settings.*` read sites (`app/shopify.py`, `app/services/shopify_orders.py`, `app/routes/orders.py`'s 2 PostEx call sites) to receive the calling org's credentials as parameters instead. Remove `main.py`'s prod boot-time check on `settings.shopify_store_url` — there's no longer a single "the" store to validate at boot; validation moves to sync-time, per org. Backfill LushWear's row from today's env vars as part of this rollout (one-time — the new admin Settings > Integrations UI in Phase 3 is the natural way to enter it once).

## Phase 3 — Frontend

- Replace the PIN fields in `runPinGate()` (`frontend/js/app-core.js`) with email+password, reusing its existing first-run-vs-returning conditional structure — now driven by `GET /auth/status` ("any users exist") instead of the PIN "configured" flag. First-run shows an org+admin bootstrap form instead of PIN setup.
- `setAuthToken`/`getAuthToken`/`clearAuthToken` (`frontend/js/data-api.js`) are unchanged — still just a JWT string in sessionStorage.
- Add a "logged in as {email} ({role})" indicator (Settings or header), sourced from `GET /auth/me`.
- Settings: "Change PIN" → "Change password"; add an admin-only "Users" section (list/invite/change role/deactivate within the org), hidden for `staff` — reuse the same show/hide-by-state pattern `applyEditLockState()` already uses.
- Add an admin-only "Integrations" section (Shopify store URL/token, PostEx merchant token) next to Users — lets an org admin configure their own org's credentials without a developer hand-editing the DB every time a new client onboards.
- **Leave `editLocked`/`lockApp()`/`applyEditLockState()` alone.** Reuse `lockApp()`'s clear-token-and-reshow-gate flow as-is for the new login gate. `editLocked` stays a separate, manual, session-only toggle, not tied to role in this plan — it's a natural future hook for role-based default read-only, explicitly not solved now.

## Phase 4 — Cleanup

- Drop `app_pin`/`pin_lockouts` tables, `app_pin.py`, `test_app_pin_lockout.py`, once Phases 2–3 are verified live.
- Update `backend/BACKEND.md`'s "Authentication model" section and `TODO.md` (remove the "Organizations & Users" item; note that "Revisit cashbook audit trail scope" and "Role-based access to columns" are now unblocked, without necessarily implementing them here).

## Explicitly out of scope (separate existing TODO items)

- Full Admin Portal UI (cross-org superadmin screens) — creating new organizations stays a manual/internal operation for now.
- "Role-based access to columns" (column-level RBAC enforcement).
- "Per-user view persistence", "Live user count", "Activity logging/audit trail" beyond the `user_id`/`org_id` this plan structurally adds.
- Wiring PostgREST's own JWT verification (`pgrst.jwt_secret`) to make RLS itself load-bearing — a bigger architectural change (would require routing some calls through the anon key + forwarded user JWT instead of always the secret key). Deferred in favor of the chokepoint+lint mitigation in Phase 2.2; worth revisiting later as additional hardening, not required now.

## Verification

- **Automated**: new pytest coverage for login success/failure/lockout, bootstrap race behavior, `require_role` gating; updated `conftest.py` fixture shape; the new assertion-capturing fake for the `shopify_sync` on_conflict regression; re-run existing suites (`test_routes.py`, `test_sync_integration.py`) to confirm `org_id` threading doesn't change behavior for the single-org case.
- **Manual, end-to-end**: run bootstrap fresh to create org #1 (LushWear) + its first admin; log in; create a second org + user (manually, per the "out of scope" note above); confirm each org's product/order/ledger lists start empty and never show the other org's data; decide and test what happens to any still-unexpired PIN token once `/app-pin/*` returns 410 (should simply stop being mintable — existing tokens' fate is a deliberate choice, not an accident).
- **Shopify sync specifically**: verify sync behaves correctly for two orgs whose Shopify stores produce colliding order numbers, against the new `UNIQUE(org_id, order_number)` constraint — this was flagged as the most concrete "would silently break in production" risk during review.
- **Per-org credentials**: configure two orgs with distinct Shopify/PostEx credentials and confirm each syncs only its own store — a wrong credential lookup here would silently import one client's orders into another's account.

# TODO

Open, non-urgent work items for LushWear IMS. Completed database hardening
(indexes, Secret key, RLS, `updated_at` trigger, `order_status` / `advance_status`
CHECK constraints, data cleanup) is recorded in
[`backend/DATABASE.md`](backend/DATABASE.md). App-layer improvements (breaking up
`orders.py`, error handling, tests, CORS, etc.) are tracked in
[`backend/BACKEND.md`](backend/BACKEND.md) §4.

---

## Database

### 1. Direct frontend reads via publishable key (`FOR SELECT` policies)

RLS is enabled on all tables with **no policies**, so the public/publishable path
is fully closed today. When the frontend needs to read data directly (e.g. order
details) instead of going through the backend:

- Ship the **Publishable** key (`sb_publishable_…`, already in
  `settings.SUPABASE_PUBLISHABLE_KEY`) to the browser.
- Add a **narrow, read-only** policy per exposed table:

  ```sql
  CREATE POLICY "anon can read orders"
      ON orders FOR SELECT
      TO anon              -- confirm the exact role the publishable key maps to
      USING (true);
  ```

Rules that keep this safe:
- **`FOR SELECT` only** — all writes stay behind the backend + PIN/JWT. Never add
  an `INSERT/UPDATE/DELETE` or blanket `FOR ALL` policy for the browser role.
- **One policy per exposed table.** Leave `cashbook_entries`, `ledgers`,
  `app_pin`, and `cashbook_daily_balances` with **no** anon policy — the browser
  must never read financials or the PIN hash directly.
- **`USING (true)` exposes every row.** With a single shared identity there is no
  per-user filtering, so anyone with the publishable key can read *all* orders. If
  order rows hold data you would not want enumerated (customer names, amounts,
  tracking), expose a **view with only safe columns** and point the frontend at
  the view instead of the raw table.
- Later, when users/orgs/RBAC arrive (see [`backend/BACKEND.md`](backend/BACKEND.md)
  §4.4), replace `USING (true)` with policies keyed on the authenticated user/JWT
  claims.

### 2. Adopt versioned migrations

`supabase_schema.sql` is a single hand-edited file, so there's no guarantee it
matches the live database. Move to **Supabase migrations** (or Alembic) so the
live schema is reproducible, diffable, and reviewable. Do this alongside the
broader app-layer hardening in [`backend/BACKEND.md`](backend/BACKEND.md) §4.

> **Settled — do not "fix" these.** Recurring schema questions that were
> investigated and deliberately closed (rationale in
> [`backend/DATABASE.md`](backend/DATABASE.md) §2): `order_number` stays `VARCHAR`
> (the `NNNN-R` replacement convention needs it); `order_status` stays open text
> (live courier codes CNA/ICA/RFD); orders ↔ cashbook and JSONB line-item ids stay
> soft links, not FKs; money stays `float` at the API boundary, not `Decimal`.

---

## Sync performance & concurrency

### 3. Speed up the Shopify order sync

`/api/orders/sync-shopify` currently takes ~20s: 22 sequential Shopify pages
(250 orders each, ~1s per page) for the last 30 days, then reconciling ~1,280
Shopify orders against the full `orders` table.

Ideas to investigate:
- [ ] **Stop refetching 30 days every run.** Persist the last successful sync time
      and use `updated_at_min` so a routine run pulls only what changed. This is
      likely the single biggest win — most of those 1,280 orders are unchanged
      (a recent run reported `created=1, skipped=1279`).
- [ ] **Fetch pages concurrently.** Shopify cursor pagination is sequential by
      nature (each page's `page_info` comes from the previous response), so this
      only helps if the window can be split into parallel date ranges.
- [ ] **Stop loading every existing order into memory.** The reconciliation builds
      a map of all ~10k orders; fetching only the order numbers present in the
      Shopify payload would cut both the query and the memory.
- [ ] **Skip the full advance-status recompute.** `recompute_advance_statuses` runs
      over all orders at the end of every sync; scope it to the orders actually
      touched.
- [ ] Measure first — log per-phase timings (fetch / reconcile / write) before
      optimising, so the effort goes where the time actually is.

### 4. Concurrency guard for sync jobs (deferred — decide after #3)

Two overlapping `/sync-shopify` calls can interleave: the sync reads an order,
decides what changed (the freeze-after-fulfilled rules), then writes. A second run
reading the same stale snapshot can overwrite the first run's decision with one
computed from rules that no longer applied. Same exposure in `sync-shopify-force`,
`fix-voided-totals`, `recalculate-totals`, the PostEx CSV upload, and the two
product jobs.

**Deliberately deferred:** a shorter sync (#3) narrows the collision window, and
may make the guard unnecessary. Revisit once #3 lands.

If it is still needed, the design was worked out and prototyped:
- **`pg_advisory_lock` does not work here.** Advisory locks are held by a database
  connection; PostgREST serves each HTTP request from a pool, so the lock would not
  survive between calls. Verified — RPC works, advisory locks are unreachable.
- Use a **`sync_locks` table** (one row per job) claimed atomically via
  `INSERT ... ON CONFLICT (job) DO UPDATE ... WHERE expires_at < NOW()`. The
  conditional update runs under a row lock, so exactly one caller can win; a
  "check then claim" would race.
- Give each claim a **TTL** (~900s) so a crashed run self-heals instead of blocking
  the job permanently, plus a `finally` release for ordinary errors.
- Apply as a one-line `@single_run("job:name")` decorator per endpoint. `sync-shopify`
  and `sync-shopify-force` must share a lock name — they write the same rows.
- Busy caller gets **409**, not corruption.

### 5. Transactional multi-writes (narrower than BACKEND.md §4.1 suggests)

**Not needed for the sync paths.** They already use batched
`upsert(batch, on_conflict=...)`, and each batch is a single SQL statement, so
Postgres wraps it in an implicit transaction — 1,000 orders all land or none do.
The remaining per-row writes (`fix-voided-totals`, `recalculate-totals`, PostEx
CSV) are **independent**: updating order A does not depend on order B, so a partial
failure leaves *fewer rows updated*, not *inconsistent* rows. All three are
idempotent — re-running finishes the job. Partial ≠ corrupt.

**There is a real gap, but elsewhere:** two places write a record and then perform a
*dependent* follow-up, so a failure between them leaves genuinely inconsistent state.

- [ ] **Cashbook entry + balance recalculation** (`routes/cashbook.py`, create /
      update / delete). The entry is inserted, then `_recalculate_balances_from_date`
      runs. If the recalculation fails, the entry exists but
      `cashbook_daily_balances` does not reflect it — and unlike the sync, nothing
      re-runs automatically to heal it. `/cashbook/recalculate-all` is the manual
      repair, if you know to call it.
      Options: (a) accept it — the window is narrow and a repair endpoint exists;
      (b) derive balances on read instead of storing them, removing the class of
      bug; (c) one Postgres function doing insert + recalc atomically. (c) is the
      only place the original §4.1 idea genuinely pays off.
- [ ] **Sync's `piece_received` reset loop** — a read-then-write per replacement
      parent, after the upserts. A partial failure leaves some parents on "Done"
      that should be "Pending". Minor: the next sync corrects it.

Wrapping the *sync* in transactions would mean moving reconciliation into Postgres
functions — pushing business logic into SQL and out of the tested Python. Not worth
it. Revisit if D1 extracts the sync into a service.

---

## Cleanup / migration

### 6. Drop the legacy `orders.items` column

`orders.items` (the old `TEXT[]` of `"Name - Variant"` strings) was replaced by the
structured `orders.line_items` (JSONB). During the transition both are written in
parallel and readers fall back to `items` when `line_items` is absent. Once
`line_items` is verified in production, remove the legacy field entirely.

**Do this only after** confirming every order has `line_items` populated and the
app has been running on it without issues for a while.

Steps:
- [ ] Stop writing `items` in the Shopify sync paths (`backend/app/routes/orders.py`:
      main sync, `sync-shopify-force`, and `create-replacement`).
- [ ] Remove the legacy fallback branches that read `items`:
  - `_order_line_rows()` (the `# Legacy fallback` block) in `backend/app/routes/orders.py`
  - the `items`-based branches in `recalculate-order-costs` (`backend/app/routes/products.py`)
  - the frontend Items column fallback in `frontend/renderer.js` (`params.data.items` branch)
- [ ] Drop the model field: `items` on `OrderBase` / `Order` / `OrderUpdate` in
      `backend/app/models.py`.
- [ ] Drop the column from the DB and the canonical schema:
      `ALTER TABLE orders DROP COLUMN items;` and remove `items TEXT[]` from
      `supabase_schema.sql`.

---

# Feature backlog (frontend / UX)

Planned frontend and UX features. Backend-touching features (orgs/users, admin
portal, caching, notifications API, AI chatbot, audit log, etc.) live in
[`backend/BACKEND.md`](backend/BACKEND.md) §6; full-stack items appear in both,
one line each.

## Frontend / UX

- [ ] **Improved responsiveness & mobile view** — make the app usable on smaller
      screens.
- [ ] **Better column filtering** — replace the current column filter with a more
      usable mechanism.
- [ ] **Per-user view persistence** — remember each user's column widths / layout
      (cookies or user prefs; ties into Organizations & Users).
- [ ] **Dark & light theme** — theme toggle with persisted preference.
- [ ] **Keyboard shortcuts / keybinds** — add shortcuts for common actions.
- [ ] **De-duplicate the net-profit formula** — `total - (delivery + tax + cost)`
      (with the returned/`-delivery` and delivered-only rules) is repeated in the
      `net_profit` valueGetter, again inside `profit_percent`, and in the footer
      aggregation (`frontend/renderer.js` ~1443, ~1515, ~1544, ~1783-1835).
      Extract one `computeNetProfit(row)` helper and call it from all three so the
      definition can't drift. Keep per-row profit/receivable **computed in the
      browser** (valueGetters recalc instantly on inline edits and cost nothing);
      period totals stay backend-side in `month-summary`. Note: the frontend helper
      and the backend `month-summary` profit calc must stay in agreement — comment
      each pointing at the other.

### Full-stack (UI half; backend half in [`backend/BACKEND.md`](backend/BACKEND.md) §6)

- [ ] **Admin Portal (UI)** — screens to manage organizations, users, and roles.
- [ ] **Live user count** — display currently-active users in the admin portal.
- [ ] **Notifications section** — UI to view notifications.
- [ ] **Carrier health in Monthly Summary** — per-carrier delivered/total parcel
      percentage display.
- [ ] **Sync-from-Shopify last-updated time** — show when the last sync ran.
- [ ] **Per-order last-fetched time** — show when each order's delivery status was
      last refreshed.
- [ ] **Server status indicator** — show "offline" on a health-check failure or
      network outage.

## Misc

- [ ] **Pick an app name** — decide on a suitable product name.

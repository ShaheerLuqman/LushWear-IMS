# TODO

Open, non-urgent work items for LushWear IMS. Completed database hardening
(indexes, Secret key, RLS, `updated_at` trigger, `order_status` / `advance_status`
CHECK constraints, data cleanup) is recorded in
[`backend/DATABASE.md`](backend/DATABASE.md). App-layer improvements (breaking up
`orders.py`, error handling, tests, CORS, etc.) are tracked in
[`backend/BACKEND.md`](backend/BACKEND.md) §4. Cashbook/ledger work items live in
[`CASHBOOK_IMPROVEMENTS.md`](CASHBOOK_IMPROVEMENTS.md).

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

**Done, 2026-07-23.** Was ~20-70s depending on scope (22 sequential Shopify
pages for a 30-day window, then reconciling against the full `orders` table).
Now ~6-15s. Per-phase timing is logged on every run
(`[sync-shopify] timing: ...` in `backend/app/routes/orders.py`) so regressions
are visible instead of guessed at.

What landed, against the original ideas:
- [x] **Fetch pages concurrently.** `_fetch_shopify_orders_in_range` splits the
      window into 4 date-range partitions and fetches them with `asyncio.gather`.
      Cursor pagination is still sequential *within* one partition, but the 4
      partitions' cursor chains overlap. Measured ~5.3x faster than one
      whole-range sequential fetch for the same order count (22 requests → 11,
      because narrower bounded ranges also return denser pages from Shopify).
      Tried 8 partitions too — sometimes faster, but one trial spiked to 20s from
      hitting Shopify's per-shop rate-limit bucket (`x-shopify-shop-api-call-limit`)
      and eating the 429-retry backoff. Kept at 4; the added 429 retry/backoff
      itself (`app/shopify.py: fetch_all`) is a genuine gap-fill — it didn't
      exist before and any 429 used to abort the whole sync.
- [x] **Stop loading every existing order into memory.** `existing_orders_all` is
      now scoped to only the order numbers Shopify actually returned, fetched via
      chunked `.in_()` queries (200 per chunk) run **concurrently**, each on its
      own Supabase client (a shared client's connection crashes under concurrent
      threads — verified).
- [x] **Skip the full advance-status recompute.** `recompute_advance_statuses` is
      now called with `order_numbers=shopify_order_numbers` instead of unscoped;
      its own chunked reads and per-row updates were also parallelized the same
      way (`backend/app/advance_status.py`).
- [x] Measure first — done via the timing log mentioned above; it's what
      surfaced that local DB reads (not the Shopify fetch) were the biggest cost
      before this work, and after these changes surfaced the Shopify fetch as the
      next-biggest (now rate-limit-bound, not code-bound).
- [ ] **Stop refetching 30 days every run** (persist last sync time, use
      `updated_at_min`) — **not implemented as originally proposed.** Solved the
      same problem differently instead: the sync is now scoped to whatever period
      is selected in the UI (a specific accounting period, or the last 1000
      orders for "All orders") rather than always pulling a fixed 30-day window —
      see `GET/POST /api/orders/sync-shopify?month=&year=`. This didn't need a
      persisted timestamp and composes with the partitioning above. A true
      `updated_at_min` incremental sync would need to reconsider the
      freeze-after-fulfilled reconciliation rules (an order outside the synced
      window could still need its `order_status` frozen) — not revisited since
      the period-scoping already closed the original ~20-70s complaint.

### 4. Concurrency guard for sync jobs (deferred — decide after #3)

Two overlapping `/sync-shopify` calls can interleave: the sync reads an order,
decides what changed (the freeze-after-fulfilled rules), then writes. A second run
reading the same stale snapshot can overwrite the first run's decision with one
computed from rules that no longer applied. Same exposure in `sync-shopify-force`,
`fix-voided-totals`, `recalculate-totals`, the PostEx CSV upload, and the two
product jobs.

**Deliberately deferred:** a shorter sync (#3) narrows the collision window, and
may make the guard unnecessary. Revisit once #3 lands.

**#3 landed 2026-07-23** (full sync down to ~6-15s from ~20-70s) — this is now
ready to revisit per the note above, but not picked up yet. Still an open
decision, not an open bug: re-evaluate whether the narrower window makes the
guard unnecessary, or implement the `sync_locks` design below.

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

- [x] **Cashbook entry + balance recalculation** — **Done, 2026-07-20.** Was:
      `routes/cashbook.py` recalculated `cashbook_daily_balances` in app code after
      every entry create/update/delete; anything that touched `cashbook_entries`
      outside those routes (Supabase table editor, raw SQL delete) left balances
      stale with no self-heal — `/cashbook/recalculate-all` even short-circuited to
      a no-op once `cashbook_entries` was empty, so it couldn't fix the exact "I
      cleared everything" case that triggered this.
      Fixed by moving recalculation into the database: `recalc_cashbook_daily_balances()`
      plus an `AFTER INSERT OR UPDATE OR DELETE` row trigger and an `AFTER TRUNCATE`
      statement trigger on `cashbook_entries` (`supabase_schema.sql`, "Triggers"
      section). Fires for every writer, not just the API. Verified live with a
      smoke test (insert across 3 days, backdated edit, delete) — cascades and
      self-cleans correctly. The app-layer functions (`_recalculate_daily_balance`,
      `_recalculate_balances_from_date`) and their call sites were removed from
      `cashbook.py`.
      Rejected: compute-on-read (option (b) from the original writeup) — a DB
      trigger was just as cheap to add here and keeps `cashbook_daily_balances` as
      a queryable table (`/daily-balance/{date}` needed no changes), whereas
      compute-on-read would've required rewriting it around a window-function
      query. Revisit only if the trigger itself becomes a measured bottleneck.
      Cleanup: removed `GET /cashbook/daily-balances` (unfiltered list, zero
      callers) and `POST /cashbook/recalculate-all` (manual repair hook, also zero
      callers — the trigger fires for every writer now, including restores/bulk
      loads unless they explicitly disable triggers). Both are cheap to rebuild if
      ever actually needed; the DB function `recalc_cashbook_daily_balances()`
      itself stays (the trigger calls it) so a manual-repair endpoint could be
      re-added as a thin wrapper around it.
- [x] **Sync's `piece_received` reset loop** — **Resolved as a side effect of
      §3's sync speedup, 2026-07-23.** Was a read-then-write *per replacement
      parent* (N separate select+update pairs), so a crash partway left some
      parents on "Done" that should be "Pending". Now one `.in_("order_number",
      ...)` select for all flagged parents, then one `.in_("id", ids_to_reset)`
      update for all of them (`backend/app/routes/orders.py`, around
      `original_orders_to_reset_piece_received`). The update is a single SQL
      statement, so Postgres wraps it in an implicit transaction — it's all-or-
      nothing now, not partial. (The read→write gap itself still exists in
      principle — a concurrent write could land between the select and the
      update — but that's the general concurrency question §4 covers, not the
      partial-failure-on-crash gap this item was about.)

Wrapping the *sync* in transactions would mean moving reconciliation into Postgres
functions — pushing business logic into SQL and out of the tested Python. Not worth
it. Revisit if D1 extracts the sync into a service.

---

## Cleanup / migration

### 6. Drop the legacy `orders.items` column

**Done, 2026-07-23.** Was the old `TEXT[]` of `"Name - Variant"` strings,
replaced by structured `orders.line_items` (JSONB).

Precondition check first: audited all 10,475 orders. Zero rely on the `items`
fallback (no order has `items` populated while `line_items` is empty — the
1,251 orders missing `line_items` have *no* item data in either column, an
unrelated pre-existing gap). Safe to remove with no data loss.

Turned out bigger than the checklist below suggests: `items` wasn't just a
display fallback, it was also the **input to cost-price calculation**
(`calculate_cost_from_items`, matching flat item names against the products
table to compute `cost_price` when Shopify doesn't supply one) in both the main
sync and `sync-shopify-force` — two separate near-duplicate copies, neither
listed here originally. Rebuilt as one shared `_cost_from_line_items()`
(`backend/app/routes/orders.py`) reading structured `line_items` instead.
Verified it reproduces the old flat-list calculation exactly across 2,529 real
orders spanning a full year (0 mismatches) before switching over — this touches
real cost/profit numbers, so it was checked against production data first, not
just unit-tested.

Also found and fixed one more undocumented fallback: `invoice.py`'s PDF
generation had a *second*, nested `items` fallback that was already dead code
before this change (it read dict-shaped items via `.get()`, but `items` held
plain strings — it only became reachable, and only in tests, once the first
fallback in `_order_line_rows` was removed). Removed rather than "fixed", per
the same reasoning as `has_changed()` below.

What landed, against the original checklist:
- [x] Stop writing `items` in the Shopify sync paths (main sync,
      `sync-shopify-force`, `create-replacement`).
- [x] Remove the legacy fallback branches that read `items`:
  - `_order_line_rows()` in `backend/app/services/pdf/packaging_list.py` (moved
    here in an earlier refactor — the checklist's `orders.py` reference was
    stale) - also removed the now-dead `_split_item_name` helper.
  - the `items`-based branches in `recalculate-order-costs`
    (`backend/app/routes/products.py`).
  - the frontend Items column fallback in `frontend/renderer.js`
    (`params.data.items` branch).
  - **Not on the original list:** `invoice.py`'s nested fallback (see above),
    and `has_changed()`'s `"items"` field comparison in `orders.py` - that one
    was *already* dead code independent of this change (its value always got
    stringified by `normalize_value()` before the list-comparison branch could
    ever see it), so it was deleted as a no-op rather than "fixed" into new,
    unreviewed behavior. The one working consumer, `items_changed` (drives
    cost-price recalculation on unfulfilled orders), was rebuilt against
    `line_items` via a small `_line_items_signature()` helper.
- [x] Drop the model field: `items` on `OrderBase` / `OrderUpdate` in
      `backend/app/models.py`.
- [x] Drop the column from the DB and the canonical schema: added
      `ALTER TABLE orders DROP COLUMN IF EXISTS items;` to `supabase_schema.sql`
      and removed `items TEXT[]` from the table definition. **Not yet run
      against the live database** - schema changes are applied manually, per
      standing preference in this project.
- Verification: full backend test suite (119 tests) passes; live end-to-end
  run of both `sync-shopify` and `GET /orders/` against production data
  confirmed correct behavior (no false-positive updates, correct cost figures,
  no missing-field errors) after the change.

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
- [x] **De-duplicate the net-profit formula** — **Done, 2026-07-23.** Extracted
      `computeNetProfit(row)` (`frontend/renderer.js`, just above `initOrdersGrid`)
      and pointed the `net_profit` valueGetter, `profit_percent` valueGetter, and
      the selected-rows footer aggregation at it instead of each repeating
      `total - (delivery + tax + cost)` (with the returned/`-delivery` and
      delivered-only rules) independently. Verified the extracted function returns
      identical output to the three original inline copies across delivered/
      returned/unfulfilled/cancelled/no-delivery-charge cases before switching over.
      `receivable` was left alone (different formula, includes `advance_amount`;
      out of scope). Per-row profit/receivable stay computed in the browser as
      before; period totals stay backend-side in `month-summary`. Added a comment
      on each side (`computeNetProfit` in renderer.js, and `net_profit` in
      `routes/orders.py`'s month-summary route) pointing at the other, per the note
      below.

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

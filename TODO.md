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

## Ledgers

### 7. Optimize cashbook before extending the ledger model

Do this first. The full-history refetch on every cashbook mutation (item under
**Frontend / UX** below — `updateCashInHand()`, `frontend/renderer.js:4639`) is
the ledger code path that #8 and #9 would both build on. Adding more ledger
surface area before fixing the N-refetch behavior means the new code inherits
the same performance problem.

### 8. Create a ledger inline from the cashbook entry form

Today creating a ledger means leaving the cashbook entry flow, going to the
Ledgers view, and using `createLedgerModal`. Add a "+ New ledger" option to the
ledger `<select>`s inside `cashbookEntryForm` (`frontend/index.html` ~334-366)
and the replacement-order advance form (~396-418) that opens the create-ledger
modal inline and, on save, selects the new ledger without losing the rest of
the in-progress entry.

### 9. Replace ledger `section` with `nature`

Ledgers currently carry a free-text `section` (Bank/Expense/Vendors/Sales/
Investors — `backend/app/models.py:194`, `frontend/index.html` ~308-315).
Replace it with a `nature` field; the two most prominent values should be
**Vendor Payable** and **Vendor Receivable** — a per-ledger classification,
distinct from the per-order receivable reconciliation already in
`orders.py`/`renderer.js` (see [`backend/BACKEND.md`](backend/BACKEND.md)).

- [ ] Decide the full `nature` value set (Vendor Payable, Vendor Receivable,
      and whatever the existing Bank/Expense/Sales/Investors sections map to).
- [ ] Migrate `ledgers.section` → `ledgers.nature` in `supabase_schema.sql` and
      backfill existing rows.
- [ ] Update `Ledger`/`LedgerCreate`/`LedgerUpdate` in `backend/app/models.py`
      and the routes in `backend/app/routes/ledger.py`.
- [ ] Update the create/edit ledger `<select>` options and any section-based
      grouping/filtering in `frontend/renderer.js` / `frontend/index.html`.
- [ ] Check `backend/DATABASE.md` / `backend/BACKEND.md` for references to
      `section` that need updating.

### 10. Re-examine the Bank section's inverted debit/credit and balance sign

Customer has again asked to "invert" how `Bank`-section ledgers behave. Worth
scrutinizing before touching it again — this has already been flipped twice:

- Commit "Invert debit and credit for bank" (Feb 19) swapped which raw field
  the Debit/Credit columns show for Bank ledgers only
  (`renderLedgerDetailGrid`, `frontend/renderer.js` ~5038-5044: Debit shows
  `incoming`, Credit shows `outgoing`; every other section is the reverse).
- A later commit ("changes") also flipped the running-balance sign for Bank to
  `outgoing - incoming`, both in `renderLedgerDetailGrid` (~5058) and in
  `updateCashInHand()` (~4702-4706), to match.

Standard bookkeeping treats a bank ledger like any other asset/cash account:
Debit (incoming/deposit) increases the balance, Credit (outgoing/withdrawal)
decreases it, so balance = **incoming − outgoing** — exactly the formula every
non-Bank section already uses. Tracing how entries get created (an `IN:` bulk
entry or the Incoming side of `cashbookEntryForm` books an *inflow* to the
named ledger), `incoming` really does mean "money deposited," so the current
`outgoing − incoming` sign for Bank produces the *negative* of actual cash
held — it doesn't match the "your own books" convention, and it doesn't match
the alternative "bank statement" convention either (that one only swaps which
label a movement sits under, it never negates the balance itself).

Before changing anything, pin down which of the two independent flips the
customer actually means:
- [ ] If they mean the **balance sign** (`outgoing - incoming` →
      `incoming - outgoing` for Bank) — this looks like the one worth
      restoring; it would make Bank match every other section and fix what
      currently reads as an inverted cash balance.
- [ ] If they mean the **Debit/Credit column swap** — that's a labeling/
      statement-format preference, not a correctness issue; confirm intent
      before reverting since it doesn't have an obviously "right" answer.

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
- [ ] **`updateCashInHand()` re-fetches full ledger history on every cashbook
      mutation** (`frontend/renderer.js:4639`). For every Bank-section ledger it
      calls `GET /ledgers/{id}/entries` with no date filter — the entire
      transaction history, every time — then sums a running balance client-side.
      It runs on every `reloadCashbookForCurrentDate()` call, which fires after
      *each* individual create/update/delete, so deleting N entries in a row
      re-fetches all Bank ledgers' full history N times over. Confirmed live via
      backend logs: cleaning up 7 test entries fired the 5-ledger fetch 7 times.
      Two fixes, increasing effort:
      (a) cheap: only refetch the one Bank ledger the changed entry's `folio`
      belongs to, not all of them — no backend change;
      (b) more correct: move the running-balance computation server-side (one
      aggregate query per ledger, same pattern as the cashbook daily-balance
      trigger work) so the browser stops downloading full transaction histories
      at all. Not urgent — revisit when ledger history volume makes it visible.
- [ ] **Folio dropdown doesn't highlight the currently-selected ledger** —
      `.folio-dropdown-option.selected` (`frontend/styles.css` ~3023) is meant to
      highlight the row matching the cell's current folio when the dropdown
      reopens, but it isn't showing up visibly in practice. The `l.id ===
      currentFolio` check it depends on (`renderOptions()` in
      `createFolioCellRenderer`, `frontend/renderer.js` ~2181-2204) mirrors the
      comparison used a few lines earlier to compute `displayText`, which does
      work, so the match itself isn't obviously broken. `currentFolio` is a
      `const` captured once when the cell renderer function runs (~2112) —
      worth checking whether it goes stale relative to `params.data.folio`
      across dropdown reopens without a full cell re-render, before assuming
      it's a pure CSS issue.

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

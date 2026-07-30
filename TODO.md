# TODO

Open, non-urgent work items for LushWear IMS. Completed database hardening
(indexes, Secret key, RLS, `updated_at` trigger, `order_status` / `advance_status`
CHECK constraints, data cleanup) is recorded in
[`backend/DATABASE.md`](backend/DATABASE.md). Backend hardening/feature work
lives here now too (`backend/BACKEND.md` stays descriptive, not a task list).
Cashbook/ledger work items live in
[`CASHBOOK_IMPROVEMENTS.md`](CASHBOOK_IMPROVEMENTS.md).

---

## Database

> **Settled — do not "fix" these.** Recurring schema questions that were
> investigated and deliberately closed (rationale in
> [`backend/DATABASE.md`](backend/DATABASE.md) §2): `order_status` stays open text
> (live courier codes CNA/ICA/RFD); orders ↔ cashbook and JSONB line-item ids stay
> soft links, not FKs; money stays `float` at the API boundary, not `Decimal`.
>
> `order_number` is now `INTEGER`, not `VARCHAR`
> ([`20260728010000_order_number_to_integer.sql`](supabase/migrations/20260728010000_order_number_to_integer.sql)).
> It was kept as `VARCHAR` only because `create_replacement_order` wrote
> `"NNNN-R"` into it; that endpoint (and its UI) has been removed — replacements
> are tracked solely via Shopify's `NNNN-R` tag → numeric `replacement_of_order_no`,
> never via `order_number` itself. `get_all_orders`'s numeric re-sort has since
> moved into Postgres (`.order("order_number", desc=True)`, `order_number` being
> a real `INTEGER` now).

---

## Backend hardening

- [x] **Sync performance** — **Done, 2026-07-30.** A recent run had reported
      `created=1, skipped=1279` — almost all the work was re-processing unchanged
      orders. `services/shopify_sync.py`'s sync is now incremental: it resumes
      from `sync_status.last_synced_at` instead of always re-fetching a fixed
      `SHOPIFY_SYNC_WINDOW_DAYS`-day window, and filters Shopify's Orders API on
      `updated_at` rather than `created_at` (`_fetch_shopify_orders_in_range`) -
      which is also a correctness fix, not just a speedup: the old `created_at`
      window could never catch a status change (e.g. a late return) on an order
      created more than `SHOPIFY_SYNC_WINDOW_DAYS` days ago. The checkpoint is
      recorded as the sync's *start* time, not its end time, to avoid a race
      where a Shopify update landing mid-sync would fall in the gap and never
      get picked up.
- [x] **Remaining untyped `response_model=dict`** — **Done, 2026-07-30.** All 8
      `response_model=dict` routes now have a real model:
      `DeleteCashbookEntryResult`, `DeleteLedgerResult`, `FixVoidedTotalsResult`,
      `ForceSyncOrdersResult`, `RecalculateTotalsResult`, `LoadSheetLogResult`
      (all local to their route file), plus `create_order` and `create_product`
      turned out to already return full entities and now use the existing
      `Order`/`ProductWithVariants` models instead of a fresh one. Also typed
      `POST /orders/sync-shopify` (`SyncShopifyOrdersResult`, in
      `services/shopify_sync.py`) and `GET /products/{id}` (`ProductWithVariants`)
      — both returned dicts with no `response_model` at all, an even more
      untyped case than the 8 that prompted this. Found and fixed a real bug
      doing this: `fix_voided_order_totals`'s "no candidates" early return was
      missing 3 fields (`eligible_candidates_count`, `fetch_batch_size`,
      `updated_order_numbers`) that its main return always includes — under a
      strict `response_model` this path would have 500'd. None of these 10
      endpoints had any test coverage before this, so a shape mismatch would
      only have surfaced as a production `ResponseValidationError`; added
      route-level tests for all of them in `tests/test_routes.py`.

---

## Frontend code health

- [ ] **Split `initForms()`** (511 lines, `frontend/js/sync-summary.js`) — a flat
      sequence of independent `addEventListener` blocks that would split cleanly
      per feature area. Left over from the `renderer.js` split.

### Discussion: is AG Grid still the right table library?

Not a decision to make now — capture the trade-offs before anyone reaches for a
rewrite, and revisit if one of the pain points below actually bites.

**What we use today:** AG Grid Community 31.0.2, loaded from jsDelivr (no build
step, no npm dependency). 5 grids: orders, products, cashbook in/out, ledger
detail. We lean on a fair amount of its surface — 12 `cellRenderer`s, 10
`valueGetter`s, 27 `valueFormatter`s, 8 `cellEditor`s, `pinnedBottomRowData` for
the selected-rows footer, `getRowId` for row-level updates after a sync,
`onCellValueChanged` for inline saves, and ~20 `filterParams` blocks including
the custom date-range filter. Orders loads up to 1000 rows at a time
(`RECENT_ORDERS_LIMIT`), so virtualised rendering is doing real work.

**Why it might be worth reconsidering:**
- ~65 rules in `styles.css` exist purely to restyle AG Grid internals (icons,
  header layout, popups, paging), and they fight the vendor stylesheet — the
  filter/sort icon work and the `:is(.ag-theme-alpine, .ag-theme-alpine-dark)`
  rewrite for dark mode are both symptoms of that.
- Community edition omits things we may eventually want (row grouping,
  server-side row model, Excel export with styling — we hand-roll xlsx today).
- Enterprise is per-developer paid, so those features aren't a cheap upgrade.

**Why replacing it is probably not worth it:**
- Inline editing + custom cell editors + pinned footer + per-column filters +
  virtualisation is a lot to reimplement or re-wire, and it touches the single
  most-used screen in the app.
- The alternatives trade one set of constraints for another: TanStack Table is
  headless (we'd own all rendering and styling, which is most of what we already
  dislike doing), a component-kit table like Ant Design's `<a-table>` (what
  `kcp-frontend` uses) assumes you've adopted that whole UI kit and Vue, and
  Handsontable/vxe-table are licensed or Vue-first.
- We have no build step. Most modern options assume npm + bundler, which is a
  bigger change than the grid swap itself.

**If it comes up, the questions to answer first:** what specifically is hurting
(styling friction? a missing feature? bundle size?), and would a targeted fix —
e.g. dropping our CSS overrides in favour of AG Grid's theming API — solve it
without a migration.

---

# Feature backlog

Planned features across the stack. Full-stack items note both halves, one line
each, under "Full-stack" below.

## Frontend / UX

- [x] **Mobile view** — **Done, 2026-07-25.** Deliberately *not* a separate phone
      layout: the grids keep full-size columns and scroll horizontally, since the
      product is for big screens and shrinking cells to fit would make the data
      unreadable. What changed instead (`styles.css` "Responsive / mobile"):
      `sizeColumnsToFit()` is skipped below 820px via `sizeGridColumns()` (it was
      squeezing ~2100px of orders columns into the viewport); nav becomes an
      off-canvas drawer with a hamburger + scrim, since hover-to-expand does
      nothing on touch; the toolbar wraps to its own scrollable row; modals go
      full-bleed bottom-sheet; inputs go to 16px to stop iOS focus-zoom;
      `100dvh` + `env(safe-area-inset-*)` for address bars and notches.
- [ ] **Better column filtering** — replace the current column filter with a more
      usable mechanism.
- [ ] **Per-user view persistence** — remember each user's column widths / layout
      (cookies or user prefs; ties into Organizations & Users).
- [ ] **Keyboard shortcuts / keybinds** — add shortcuts for common actions.

### Full-stack

- [ ] **Admin Portal** — UI: screens to manage organizations, users, and roles.
      API: endpoints to manage them (see "Backend" below).
- [ ] **Live user count** — UI: display currently-active users in the admin
      portal. API: track/expose that count.
- [ ] **Notifications** — UI: section to view notifications. API: endpoints +
      storage for them.
- [ ] **Carrier health in Monthly Summary** — UI: per-carrier delivered/total
      parcel percentage display. API: extend the `month-summary` endpoints in
      `orders.py`.
- [ ] **Sync-from-Shopify last-updated time** — show when the last sync ran.
      Backend already exposes this (`GET /orders/sync-status` ->
      `last_synced_at`/`in_progress`); frontend wiring only.
- [ ] **Per-order last-fetched time** — show when each order's delivery status was
      last refreshed.
- [ ] **Server status indicator** — show "offline" on a health-check failure or
      network outage. Backend already has this (`GET /ready`, a real Supabase
      connectivity check, distinct from `/health`); frontend wiring only.

## Backend

### Auth & multi-tenancy
- [ ] **Organizations & Users** — real org/user accounts (replaces the single
      shared PIN). Prerequisite for RBAC, admin portal, and per-user views.
      Extends `auth.py` (add `user_id`/`role` JWT claims, per-role
      dependencies), `models.py`, schema, and RLS policies keyed on the JWT.
      Do it before you have a second user, not after.
- [ ] **Revisit cashbook audit trail scope once Users lands** — today
      `cashbook_entry_audit_log` (2026-07-21) only records *deletions*
      (`supabase_schema.sql` triggers), not creates/updates, and has no
      "who" field since there's no per-user identity yet. Decided at the
      time: full change history isn't worth it without attribution — a
      log saying "amount changed from X to Y" is much less useful if it
      can't say who changed it, and edits are recoverable (re-edit to fix)
      while deletes aren't (data is just gone), which is why delete-only
      was the deliberate cut point rather than full CRUD tracking. Once
      real user accounts exist, re-examine whether full update/create
      history (with attribution) becomes worth adding — see
      `CASHBOOK_IMPROVEMENTS.md` for the cashbook/ledger context.
- [ ] **Role-based access to columns** — enforce per-role column visibility/edit
      server-side (depends on Organizations & Users).

### Performance
- [ ] **Caching** — cache hot reads (e.g. products, ledgers) to cut Supabase
      round-trips.

### Data & reporting
- [ ] **Shopify webhooks for real-time order ingestion** — replace/augment the
      manual sync button with `orders/create` / `orders/updated` / `orders/fulfilled`
      webhooks (HMAC-verified) that trigger reconciliation for the affected order
      via `services/shopify_orders.py`'s single-order fetch, instead of waiting for
      a full poll. Webhook delivery isn't guaranteed, so keep the manual button
      and/or a periodic fallback sync alongside it — this is a trigger for
      `sync_shopify_orders`'s reconciliation logic, not a replacement for it.

### New capabilities
- [ ] **AI chatbot** — natural-language querying of the data (API/agent layer).

### Observability
- [ ] **Activity logging / audit trail** — store and track user activity via logs.
      Structured per-request logging already exists (`main.py`'s request-id +
      timing middleware); this would add actual attribution, which needs Users
      to mean anything.

## Misc

- [ ] **Pick an app name** — decide on a suitable product name.

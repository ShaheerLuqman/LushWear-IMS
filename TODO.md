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

> **Settled — do not "fix" these.** Recurring schema questions that were
> investigated and deliberately closed (rationale in
> [`backend/DATABASE.md`](backend/DATABASE.md) §2): `order_number` stays `VARCHAR`
> (the `NNNN-R` replacement convention needs it); `order_status` stays open text
> (live courier codes CNA/ICA/RFD); orders ↔ cashbook and JSONB line-item ids stay
> soft links, not FKs; money stays `float` at the API boundary, not `Decimal`.

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

# Feature backlog (frontend / UX)

Planned frontend and UX features. Backend-touching features (orgs/users, admin
portal, caching, notifications API, AI chatbot, audit log, etc.) live in
[`backend/BACKEND.md`](backend/BACKEND.md) §6; full-stack items appear in both,
one line each.

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

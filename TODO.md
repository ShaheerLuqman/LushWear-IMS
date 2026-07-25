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

---

# Feature backlog (frontend / UX)

Planned frontend and UX features. Backend-touching features (orgs/users, admin
portal, caching, notifications API, AI chatbot, audit log, etc.) live in
[`backend/BACKEND.md`](backend/BACKEND.md) §6; full-stack items appear in both,
one line each.

## Frontend / UX

- [ ] **Mobile view** — the app is usable down to ~768px after the 2026-07-25
      responsive pass (see `styles.css` "Responsive" section: toolbar buttons drop
      their shared fixed width then cap, two-column modal forms collapse, header
      title/period label hide, stats grid goes single-column). Below ~768px the
      orders header still scrolls horizontally and the AG Grid tables are
      inherently wide — a real phone layout needs a different approach (card list
      instead of grid, or a dedicated mobile view), not more breakpoints.
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

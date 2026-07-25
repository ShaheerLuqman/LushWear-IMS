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

Findings from a review of `frontend/` (2026-07-25). Minor issues found in that
review were fixed on the spot; these are the ones big enough to need their own
change.

### ~~1. Extract an API helper for the duplicated fetch blocks~~ — done, 2026-07-25

`renderer.js` repeated the same shape ~48 times: `await fetch(...)`, check
`response.ok`, parse the error body, pull `.detail`, throw, then `catch` and
`showToast`. Added three helpers to `utils.js`:

- `apiRequest(path, {fallback, ...fetchOpts})` — prefixes `API_BASE`, throws a
  normalised `Error` on non-2xx, returns the raw `Response` (for `.blob()` and
  header reads).
- `apiJson(path, {body, ...})` — same, plus JSON body serialisation and parsed
  JSON back. Returns `null` on 204.
- `apiErrorMessage(body, fallback)` — pulls a displayable message out of
  FastAPI's `{detail}`, handling string detail, 422 validation arrays, and
  missing/unparseable bodies.

**38 call sites converted** (29 `apiJson`, 9 `apiRequest`). Also deleted
`formatApiErrorDetail`, a near-duplicate of `apiErrorMessage` used by the PIN
gate.

Fixed a real bug along the way: on a 422 the old code showed the raw validation
array — `recalculate-order-costs` did `JSON.stringify(detail)` and others
`.join(' ')` over objects, printing `[object Object]`. `apiErrorMessage` maps
those to their `msg` fields.

**9 raw `fetch` calls remain deliberately** — they branch on specific status
codes (PIN gate's 503/401, order-by-number's 404), read the body on both success
*and* failure (PostEx CSV upload), or intentionally don't throw
(`returned-delivery-charges-sum`, `fetchLoadSheetRiderNames`).

### 2. Split `renderer.js` (7.3k lines)

Two functions dominate: `initOrdersGrid()` at **925 lines** and `initForms()` at
**519**. `initOrdersGrid` is mostly one giant `columnDefs` array with inline
renderers/getters; the column defs and cell renderers could move to their own
module with no behaviour change. `initForms` is a flat sequence of independent
`addEventListener` blocks that splits cleanly per feature area.

Natural seams: orders grid/columns, cashbook, ledgers, products, PDF/export
actions, delivery status. There is no build step or module system today, so this
needs either `<script type="module">` + imports or plain multiple `<script>` tags
with an agreed load order — decide that first.

### ~~3. Reconcile the duplicated CSS blocks~~ — done, 2026-07-25

`styles.css` had defined `.modal`, `.modal-content`, `.modal-header`,
`.modal-body`, `.modal-close`, and `.btn-danger` twice each (~line 1235 vs
~1610), with the later block silently winning on every conflict — so modals
rendered with block B's layout while block A's `border` and `animation: modalIn`
partially applied on top. Merged into one definition per selector (76 lines
removed), keeping the values that were actually in effect. Verified by extracting
the effective last-wins declarations for all 10 affected selectors before and
after: identical except a redundant `background-color` alongside an equal
`background`. `.btn-danger`'s first definition was fully dead (every property
overridden), so removing it was a no-op.

Then unified the two opening conventions on **`.active`** (was 16 sites vs 3
using `style.display`). Converted the 3 stragglers — delivery status, delivery
status report, PostEx amount mismatches — including removing their inline
`style="display: none;"`, which would have beaten the stylesheet. With one
convention, `.modal.active` no longer needs its own `z-index` bump; the base
`10000` plus two deliberate per-modal overrides (`#createLedgerModal.active`
10011, `#deliveryStatusModal.active` 10020, which opens *over* the report modal)
is the whole stacking story.

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

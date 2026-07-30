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

# Feature backlog

Planned features across the stack. Full-stack items note both halves, one line
each, under "Full-stack" below.

## Frontend / UX

- [ ] **Better column filtering** — replace the current column filter with a more
      usable mechanism.
- [ ] **Per-user view persistence** — remember each user's column widths / layout
      (cookies or user prefs; ties into Organizations & Users).
- [ ] **Keyboard shortcuts / keybinds** — add shortcuts for common actions.

### Full-stack

- [ ] **Admin Portal** — UI: screens to manage organizations, users, and roles.
      API: endpoints to manage them (see "Backend" below).
- [ ] **Notifications** — UI: section to view notifications. API: endpoints +
      storage for them.

## Backend

### Auth & multi-tenancy
- [ ] **Organizations & Users** — real org/user accounts (replaces the single
      shared PIN), true multi-tenancy (LushWear is org #1, more client orgs
      join later). Prerequisite for RBAC, admin portal, and per-user views.
      Do it before you have a second user, not after. Full phased plan (schema,
      auth.py claim changes, org-scoping cutover, frontend) in
      [`ORGANIZATIONS_USERS_PLAN.md`](ORGANIZATIONS_USERS_PLAN.md).
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

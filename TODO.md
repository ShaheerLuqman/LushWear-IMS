# TODO

Open, non-urgent work items for LushWear IMS. Completed database hardening
(indexes, Secret key, RLS, `updated_at` trigger, `order_status` / `advance_status`
CHECK constraints, data cleanup) is recorded in
[`backend/DATABASE.md`](backend/DATABASE.md). Backend hardening/feature work
lives here now too (`backend/BACKEND.md` stays descriptive, not a task list).
Transactions/ledger work items live in
[`CASHBOOK_IMPROVEMENTS.md`](CASHBOOK_IMPROVEMENTS.md).

---

## Database

> **Settled — do not "fix" these.** Recurring schema questions that were
> investigated and deliberately closed (rationale in
> [`backend/DATABASE.md`](backend/DATABASE.md) §2): `order_status` stays open text
> (live courier codes CNA/ICA/RFD); orders ↔ transactions and JSONB line-item ids stay
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
      (cookies or user prefs, keyed by the now-real per-user accounts).
- [ ] **Keyboard shortcuts / keybinds** — add shortcuts for common actions.

### Full-stack

- [ ] **Notifications** — UI: section to view notifications. API: endpoints +
      storage for them.

## Backend

### Auth & multi-tenancy
- [ ] **Revisit transaction audit trail scope now that Users has landed** — today
      `transaction_entry_audit_log` (2026-07-21) only records *deletions*
      (`supabase_schema.sql` triggers), not creates/updates, and has no
      "who" field since there was no per-user identity when it was built.
      Decided at the time: full change history isn't worth it without
      attribution — a log saying "amount changed from X to Y" is much less
      useful if it can't say who changed it, and edits are recoverable
      (re-edit to fix) while deletes aren't (data is just gone), which is why
      delete-only was the deliberate cut point rather than full CRUD tracking.
      Now that real user accounts exist (`users.id`), re-examine whether full
      update/create history (with attribution) becomes worth adding — see
      `CASHBOOK_IMPROVEMENTS.md` for the transactions/ledger context.
- [ ] **Role-based access to columns** — enforce per-role column visibility/edit
      server-side. Unblocked now that real per-org roles (`org_memberships.role`)
      exist.

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

### Couriers
- [ ] **Couriers Next delivery status is stale via `TrackOrder.php`** — the
      endpoint `_fetch_couriersnext_status` calls (`orders.py`) only echoes the
      raw sub-vendor (Trax) checkpoint feed and can sit stuck on "in transit"
      after the parcel is actually delivered. Confirmed for tracking
      `202370601123`: `TrackOrder.php` still showed "Parcel in Transit to
      Destination" while both the public tracking page
      (`portal.couriersnext.com/track-details.php`) and the documented
      `CurrentStatus.php` endpoint (no auth required — see
      `CouriersNext-API-V1.0.pdf`) already showed "Delivered". **First step:
      ask the Couriers Next team why `TrackOrder.php` lags/never reflects
      post-handoff statuses** before changing anything — want to understand if
      this is expected behavior, a bug on their end, or if there's a better
      endpoint/webhook we're missing. If it turns out `CurrentStatus.php` is
      the right fix, the plan is to merge its single status into
      `status_history` as one more entry (both endpoints use the same
      `YYYY-MM-DD HH:MM:SS` format) rather than deriving `order_status` from it
      directly, so `_derive_order_status_from_latest`'s existing
      backward-search over history keeps working unchanged and non-terminal
      current-statuses stay a no-op.

### New capabilities
- [ ] **AI chatbot** — natural-language querying of the data (API/agent layer).

### Observability
- [ ] **Activity logging / audit trail** — store and track user activity via logs.
      Structured per-request logging already exists (`main.py`'s request-id +
      timing middleware); this would add actual attribution, which needs Users
      to mean anything.

## Misc

- [ ] **Pick an app name** — decide on a suitable product name.

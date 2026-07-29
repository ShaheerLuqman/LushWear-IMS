# LushWear IMS — Backend

A technical overview of the backend as it exists today, followed by a
production-oriented review: what's implemented, where the risks are, and how to
improve it. Written for the current state of the `webapp-migration` branch.

> **Recent changes (this hardening pass):**
> - Backend now authenticates to Supabase with the **Secret** key
>   (`SUPABASE_SECRET_KEY`); the **Publishable** key is available for future
>   direct-frontend reads.
> - **RLS enabled** on all tables (no policies — public path closed).
> - Database constraints/indexes/trigger added and **verified live** — see
>   [`DATABASE.md`](DATABASE.md). This supersedes parts of §4.1 below, which are
>   annotated inline where done.
> - Orders now carry structured **`line_items`** (JSONB) alongside the legacy
>   `items` string array (the legacy column is slated for removal — see
>   [`TODO.md`](../TODO.md)).

---

## 1. What this backend is

A **FastAPI** service that powers the LushWear Inventory Management System. It is
a thin-but-busy API layer sitting between:

- a **Vercel-hosted frontend** (static),
- **Supabase** (Postgres) as the system of record,
- **Shopify Admin API** (product/order source of truth), and
- **PostEx** (courier — CSV upload + delivery-status lookups).

It also generates PDFs server-side (invoices, packaging lists, load sheets) with
ReportLab, and is deployed as a **Docker container on Northflank** (binds the
platform-provided `$PORT`).

### Tech stack

| Concern | Choice |
|---|---|
| Web framework | FastAPI + Uvicorn (`[standard]`) |
| Data access | `supabase-py` client (PostgREST over HTTP) |
| Validation | Pydantic v2 |
| Auth | Single shared PIN → signed JWT (HS256) |
| PDF | ReportLab, openpyxl (template), pypdf, Pillow |
| HTTP client | httpx (async) for Shopify/PostEx |
| Deploy | Docker on Northflank |

---

## 2. How it's currently structured

```
backend/
├── Dockerfile              # Northflank; runs the test suite as a deploy gate
├── requirements.txt        # runtime deps (pinned)
├── requirements-dev.txt    # + pytest; never ships in the runtime image
├── pytest.ini
├── README.md               # Deploy + run notes
├── .env                    # local secrets (untracked)
├── tests/                  # 123 tests, hermetic (Supabase faked)
└── app/
    ├── main.py             # app factory, CORS, router wiring, auth + error handler
    ├── config.py           # Settings from env (Supabase + Shopify)
    ├── database.py         # lazy singleton Supabase client
    ├── auth.py             # JWT issue/verify (require_auth dependency)
    ├── models.py           # Pydantic schemas (products/orders/cashbook/ledger)
    ├── logging_config.py   # console logging; quiets httpx per-request URLs
    ├── advance_status.py   # advance reconciliation logic
    ├── money.py            # round-half-up money helper
    ├── ordering.py         # order sort keys (VARCHAR order_number, recency)
    ├── db_utils.py         # fetch_all(): Supabase offset pagination
    ├── shopify.py          # Shopify cursor pagination + client config
    ├── paths.py            # ASSETS_DIR
    ├── timezones.py        # PKT_TIMEZONE
    ├── order_pdf.py        # order-number extraction from PDFs
    ├── assets/             # logos + invoice.json (shipper defaults)
    ├── services/
    │   ├── postex.py           # PostEx CSV parsing            (158)
    │   ├── shopify_orders.py   # single-order Shopify fetch     (95)
    │   ├── shopify_sync.py     # full orders sync (fetch/reconcile/persist) (1004)
    │   └── pdf/
    │       ├── invoice.py          # invoice shaping + render  (424)
    │       ├── load_sheet.py       # rider manifest            (229)
    │       └── packaging_list.py   # aggregation + render      (230)
    └── routes/
        ├── app_pin.py      # PIN status/verify/setup/change (+ lockout)
        ├── products.py     # products + variants + Shopify product sync   (671)
        ├── orders.py       # orders, Shopify sync, summaries             (2451)
        ├── cashbook.py     # cashbook entries + daily balances            (298)
        └── ledger.py       # ledgers (entries derived from cashbook)      (129)
```

### Request lifecycle

1. `main.py` builds the app, adds **CORS**, and mounts routers under `/api`.
2. Every business router (`products`, `orders`, `cashbook`, `ledger`) is mounted
   with a global `Depends(require_auth)` — so all of `/api/*` requires a valid
   Bearer token **except** the `/api/app-pin/*` router, which is open (it's the
   login gate).
3. `require_auth` decodes an HS256 JWT signed with `AUTH_SECRET`.
4. Handlers call `get_supabase()` (a lazily-initialised module-global client) and
   talk to Postgres through PostgREST.

### Authentication model

- The whole app is behind **one shared PIN** (see `routes/app_pin.py`).
- PIN is bcrypt-hashed (cost 8) and stored in an `app_pin` table (single row,
  id `"default"`).
- On successful verify/setup the client gets a **7-day JWT**. There are no user
  accounts, roles, or orgs — `auth.py` explicitly notes this is a stepping stone
  toward users/orgs/RBAC.
- Brute-force protection is an **in-memory, per-IP lockout** (5 attempts / 15 min).

### Data model

`products` → `variants` (1-N), `orders` (with JSONB `line_items` + legacy `items`
string array), `cashbook_entries` → `cashbook_daily_balances`, `ledgers`,
`app_pin`, `load_sheet_logs`. There is no ORM; tables/columns are referenced by
string name. The canonical schema lives in [`supabase_schema.sql`](../supabase_schema.sql)
and is documented (with the deliberate soft-link/`order_status` design choices) in
[`DATABASE.md`](DATABASE.md). Adopting versioned migrations is still open
([`TODO.md`](../TODO.md)).

### The heavy pieces

- **`orders.py` Shopify sync** (~800 LOC in one function): paginates the Shopify
  Orders API (last 30 days), then reconciles each order against the DB with a
  large tree of "freeze this field once status leaves unfulfilled" rules
  (courier, tracking, totals, advance, cost, items, line_items). This is the most
  complex and business-critical code in the repo.
- **Advance reconciliation** (`advance_status.py`): cross-checks Shopify advance
  vs. cashbook order-advance credits and stamps a 1–5 status on each order.
- **PDF generation** (`services/pdf/`): invoices, packaging lists, and load sheets.
  The invoice enriches each order with a live Shopify lookup, falling back to the
  DB row when Shopify is unavailable.
- **PostEx CSV ingest** (`services/postex.py`): fuzzy column-name mapping, tolerant
  number parsing (incl. `2.63E+13` tracking numbers mangled by Excel), receivable
  vs. net-amount reconciliation.

---

## 3. Honest assessment

**What's genuinely good**
- Clear separation of routers by domain; Pydantic models are well-organised.
- Auth is small but thoughtfully designed as an extension point (JWT claims,
  single `require_auth` dependency) rather than something you'll have to rip out.
- CORS is env-driven, secrets are gitignored, PIN uses bcrypt + lockout — the
  security basics were taken seriously for a solo/small deployment.
- The Shopify/PostEx edge-case handling reflects real operational knowledge
  (removed line items, voided orders, replacement `NNNN-R` orders, PKT period
  boundaries). This is hard-won domain logic.

**Where it will hurt at production scale** — detailed below.

---

## 4. Optimization & production-readiness recommendations

Ordered roughly by impact-to-effort.

### 4.1 Correctness & data integrity (highest priority)

- **Wrap multi-write operations in transactions.** *(Mostly done — see §7
  "Resolved".)* The genuine per-row write loops (CSV upload,
  `recompute_advance_statuses`) are now single batched `upsert`s, so each is one
  atomic Postgres statement instead of N independent PostgREST round trips. The
  sync's own `orders` upserts were already batched/idempotent (`on_conflict`,
  chunked at 1000) — see §7 "Deferred elsewhere" for why that residual gap
  (partial failure between chunks on a very large sync) is accepted rather than
  wrapped in a transactional RPC.

### 4.3 Performance

- **Push filtering/sorting/aggregation into Postgres.** `products` variant
  grouping is done (`select("*, variants(*)")` embed, no more fetching both
  full tables and grouping in Python). `get_month_summary_list` now uses the
  `get_month_summary_periods` RPC (see §7 "Resolved") instead of fetching every
  order's dates and bucketing in Python. Still open: `get_all_orders`'s numeric
  re-sort (attempted via a generated column, reverted at the time — the
  `create_replacement_order` "-R" path has since been removed, see §7, so this
  is worth retrying) and `get_month_summary_detail`'s aggregation (sums/counts
  over a period's orders), which still happens in Python.
- **Batch the per-row updates.** *(Done.)* The CSV upload
  (`upload_postex_csv`) and `recompute_advance_statuses` (shared by the sync and
  every cashbook write) now do a single batched `upsert` each, matching
  `batch_update_cost_prices`'s pattern.
- **Offload PDF generation.** ReportLab in the request path blocks a worker and
  can be slow for large batches. Consider a background task/queue and stream the
  result, or at least cap batch sizes.

### 4.4 Auth & multi-tenancy

- The **in-memory lockout and dev-fallback JWT secret break on multi-instance /
  restart.** For real production: set `AUTH_SECRET` always (a startup check that
  refuses to boot without it in prod), and move lockout state to Supabase/Redis
  so it survives restarts and works across replicas.
- **Client IP for lockout is `request.client.host`** — behind the Northflank/Vercel
  proxies this is often the proxy IP, so one blocked attacker can lock everyone out
  (or everyone shares one bucket). Read `X-Forwarded-For` (trusted-proxy aware).
- Plan the **users/orgs/RBAC** migration the code already anticipates: add
  `user_id`/`role` claims, per-role dependencies, and RLS policies keyed on the
  JWT. Do it before you have a second user, not after.

### 4.5 Observability & operations

- **Add request-id middleware, timing metrics, and Sentry** (or equivalent) for
  error tracking. A `/health` exists — add a `/ready` that actually checks
  Supabase connectivity.
- **Rate-limit the whole API**, not just PIN verify (e.g. slowapi), especially
  the expensive sync/PDF endpoints.

### 4.6 Config & deploy hygiene

- **Enable Dependabot** (or equivalent) for dependency updates.

---

## 5. Status

The de-risking pass is complete: DB constraints/indexes/RLS ([`DATABASE.md`](DATABASE.md)),
prod-gated config in `main.py`, structured logging with generic error responses,
Stages A–C, the PDF/CSV extractions, and a 123-test suite that gates both CI and
the Docker build.

**§7 is the live plan** — it lists only what is left. The users/orgs/RBAC
migration lives in §6.

---

## 6. Feature backlog (backend-touching)

Planned features that require backend work. Full-stack items note their frontend
counterpart, which is tracked in [`../TODO.md`](../TODO.md). §4 above covers
technical/hardening improvements; this section is product features. One line each;
expand into a spec when picked up.

### Platform: Auth & multi-tenancy
- [ ] **Organizations & Users** — real org/user accounts (replaces the single
      shared PIN). Prerequisite for RBAC, admin portal, and per-user views.
      Extends `auth.py`, `models.py`, schema, and RLS policies (see §4.4).
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
- [ ] **Admin Portal (API)** — endpoints to manage organizations, users, and
      roles (UI in TODO.md).
- [ ] **Role-based access to columns** — enforce per-role column visibility/edit
      server-side (depends on Organizations & Users).
- [ ] **Live user count** — track/expose currently-active users for the admin
      portal.

### Performance
- [ ] **Caching** — cache hot reads (e.g. products, ledgers) to cut Supabase
      round-trips.

### Data & reporting
- [ ] **Carrier health in Monthly Summary** — per-carrier delivered/total parcel
      percentage; extend the `month-summary` endpoints in `orders.py`.
- [ ] **Shopify webhooks for real-time order ingestion** — replace/augment the
      manual sync button with `orders/create` / `orders/updated` / `orders/fulfilled`
      webhooks (HMAC-verified) that trigger reconciliation for the affected order
      via `services/shopify_orders.py`'s single-order fetch, instead of waiting for
      a full poll. Webhook delivery isn't guaranteed, so keep the manual button
      and/or a periodic fallback sync alongside it — this is a trigger for
      `sync_shopify_orders`'s reconciliation logic, not a replacement for it.
- [ ] **Notifications** — endpoints + storage for notifications (UI in TODO.md).

### New capabilities
- [ ] **AI chatbot** — natural-language querying of the data (API/agent layer).

### Observability
- [ ] **Activity logging / audit trail** — store and track user activity via logs
      (pairs with the structured-logging work in §4.5).

---

## 7. Improvement plan — remaining work

Current sizes: `orders.py` 2451 (was 4280), `products.py` 671, `cashbook.py` 298,
`ledger.py` 129, plus `services/` at ~2,100 lines across six modules.

> **Sync performance** ([`../TODO.md`](../TODO.md) §3) is probably worth doing next:
> a recent run reported `created=1, skipped=1279` — almost all the work was
> re-processing unchanged orders. Making the sync incremental would both speed it
> up and shrink the surface of future changes to `services/shopify_sync.py`.

### Resolved

**Wrap multi-write operations in transactions** (§4.1) — audited every
multi-write path (sync, CSV upload, cashbook) before changing anything, since
BACKEND.md/TODO.md's own notes on this were partly stale (see below). Findings:
the sync's `orders` upserts (`services/shopify_sync.py`) and the
cashbook-balance writes (`recalc_cashbook_daily_balances`/`recalc_ledger_balance`
triggers, `supabase_schema.sql`) were already atomic single statements — no
change needed there. Two genuine one-`UPDATE`/`PATCH`-per-row loops remained:
- `upload_postex_csv` (`routes/orders.py`) issued one `.update().eq("id", ...)`
  per matched CSV row. Now builds one payload list and does a single batched
  `upsert(..., on_conflict="id")` (chunked at 1000, same as the sync), matching
  `batch_update_cost_prices`'s existing pattern.
- `recompute_advance_statuses` (`app/advance_status.py`) did the per-row write
  via a `ThreadPoolExecutor` over individual `client.table("orders").update()`
  calls — the most-repeated per-row write in the codebase, since it's called
  from both the sync (`shopify_sync.py`) and every cashbook create/update/delete
  (`routes/cashbook.py`'s `_safe_recompute_advance_statuses`). Now the same
  batched-`upsert` treatment, using the passed-in `supabase` client directly
  (no more per-call `create_client`/threads for the write side; the concurrent
  `create_client` reads for large scoped chunks are unchanged).

Deliberately **not** merged into one transaction with the cashbook write that
triggers it: `_safe_recompute_advance_statuses` already documents that a
recompute failure must not fail the cashbook write ("a failure here shouldn't
fail the cashbook write that triggered it") — wrapping both in one Postgres
transaction would reverse that intentional decoupling. No direct
`psycopg`/SQLAlchemy connection was needed for any of this — batching into a
single `upsert` is already one atomic Postgres statement per call, which was
the actual gap (many independent statements), not a lack of transaction
support in PostgREST.

Bundled in, per the original task: **`month-summary`'s Postgres pushdown**
(§4.3). `get_month_summary_list` (`routes/orders.py`) fetched
`order_receiving_date`/`created_at` for every order and bucketed them into
(month, year) reporting periods in Python. Replaced with
`get_month_summary_periods()`, a new Postgres function
(`supabase/migrations/20260730000000_get_month_summary_periods_function.sql`,
mirrored into `supabase_schema.sql`) that does the same day-based period
bucketing in SQL and returns the distinct periods directly; the route now
calls it via `.rpc("get_month_summary_periods")` — the first `.rpc()` call
anywhere in this codebase. `get_month_summary_detail`'s heavier aggregation
(sums/counts per period) was explicitly out of scope and still runs in Python
(§4.3).

Note on stale docs found during the audit: this section's old wording ("sync
and CSV upload issue many independent PostgREST calls") predated the sync's
move to batched upserts, and `../TODO.md` §4 (referenced by "Deferred
elsewhere" below) no longer exists in `TODO.md` — the concurrency-guard/
transactional-multi-writes design notes it once held are gone; what's below is
reconstructed from the current code, not that section.

**`order_number` is now `INTEGER`**, not `VARCHAR(20)`

**`order_number` is now `INTEGER`**, not `VARCHAR(20)`
(`supabase/migrations/20260728010000_order_number_to_integer.sql`). It was kept
as `VARCHAR` only because the manual `create_replacement_order` endpoint wrote
`"NNNN-R"` into it; that endpoint (and its "Create Replacement" / "Delete
Replacement Order" UI) has been removed. Replacement orders are now tracked
exclusively via Shopify's `NNNN-R` tag convention (`services/shopify_sync.py`),
which only ever sets the numeric `replacement_of_order_no` column, never
`order_number` itself. The `-R` suffix shown next to a replacement order in the
grid (`orders-columns.js`) is display-only, derived from
`replacement_of_order_no`. `OrderBase.order_number`/`OrderUpdate.order_number`
in `models.py` were updated from `str` to `int` to match (FastAPI's
`response_model=List[Order]` on `get_all_orders` validates every response, and
Pydantic v2 does not coerce `int` → `str`, so the model had to change in the
same commit as the migration, not after).

**Still open**: `get_all_orders`'s numeric re-sort (§4.3) currently sorts in
Python (`_order_recency_key`/`_order_number_sort_key` in `ordering.py`) — now
that the column is a real `INTEGER`, this can move into the Postgres query
(`.order("order_number")`) instead, removing the Python sort pass.

### Remaining §4 items not yet addressed

- [ ] **Sentry** (or equivalent) for error tracking — structured logging and generic
      error responses are in place, but nothing aggregates exceptions (§4.5).
- [ ] **`/ready`** endpoint that actually checks Supabase connectivity — also
      serves as the online/offline health signal the frontend can poll (§4.5).
- [ ] **Request-id middleware and timing metrics** — only `CORSMiddleware` is
      registered today; no per-request id or latency instrumentation (§4.5).
- [ ] **Rate-limit the API** beyond PIN verify, especially sync/PDF endpoints (§4.5).
- [ ] **Externalise the PIN lockout state** — it is in-memory, so it resets on
      redeploy and does not work across replicas (§4.4).
- [ ] **Trusted-proxy `X-Forwarded-For` handling** for the lockout's client IP (§4.4).
- [ ] **API versioning** (`/api/v1/...`) before external consumers depend on it (§4.7).
- [ ] **Client-facing pagination** on list endpoints (§4.7). Partly addressed:
      `GET /orders/` now requires a `month`/`year` period instead of returning
      up to 10k rows; cashbook and products still return the full set.
- [ ] **Remaining untyped `response_model=dict`** (9 left) are operation results —
      sync stats, `{"status": "deleted"}`, load-sheet logs — not entities. Typing
      them would mean inventing models for ad-hoc payloads; left as `dict`
      deliberately.

### Deferred elsewhere

**Concurrency guard** (old D4) was investigated — notably that
`pg_advisory_lock` is unusable through PostgREST. The orders sync itself is now
covered via a conditional-`UPDATE` lock on `sync_status`'s `in_progress` column
(claimed via `UPDATE ... WHERE in_progress = false`, race-free since Postgres
serializes concurrent UPDATEs on one row). (This used to point at `../TODO.md`
§4 for the full design/findings; that section no longer exists in `TODO.md` —
see the stale-docs note under "Resolved" above.) **Transactional multi-writes**
(old D5) is resolved above — the sync's batched `orders` upserts and the
cashbook-balance triggers were already atomic; the actual per-row gaps (CSV
upload, `recompute_advance_statuses`) are now batched too.

---

*This document describes the backend as of the `webapp-migration` branch. Line
counts and file layout will drift — treat section 2 as a snapshot.*

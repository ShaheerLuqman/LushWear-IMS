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
  vs. cashbook order-advance inflows and stamps a 1–5 status on each order.
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

- **Wrap multi-write operations in transactions.** *(Still open.)* Sync and CSV
  upload issue many independent PostgREST calls. A failure halfway through
  leaves the DB partially updated with no rollback.
  PostgREST can't do interactive transactions, so move multi-step mutations into
  **Postgres functions (RPC)** or a **direct `psycopg`/SQLAlchemy connection** for
  the write-heavy paths. At minimum, keep the sync idempotent and restartable.

### 4.3 Performance

- **Push filtering/sorting/aggregation into Postgres.** `products` variant
  grouping is done (`select("*, variants(*)")` embed, no more fetching both
  full tables and grouping in Python). Still open: `get_all_orders`'s numeric
  re-sort (attempted via a generated column, reverted at the time — the
  `create_replacement_order` "-R" path has since been removed, see §7, so this
  is worth retrying) and month summaries, which still fetch pages and sort/sum
  in Python.
- **Batch the per-row updates.** The CSV upload and parts of sync still issue
  one `UPDATE` per row in a Python loop (`batch_update_cost_prices` now does a
  single batched `upsert`, apply the same elsewhere).
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

### Next up: §4.1

- [ ] **Wrap multi-write operations in transactions** — sync and CSV upload
      issue many independent PostgREST calls; a failure halfway through leaves
      the DB partially updated with no rollback. PostgREST
      can't do interactive transactions, so move multi-step mutations into
      **Postgres functions (RPC)** or a **direct `psycopg`/SQLAlchemy connection**
      for the write-heavy paths. At minimum, keep the sync idempotent and
      restartable. Bundled in: **`month-summary`'s Postgres pushdown** (§4.3) —
      it needs the same RPC plumbing (`get_month_summary_list` fetches every
      order's date columns to bucket them in Python; no schema change needed,
      the bucketing logic just moves into the function).

### Deferred separately

**`get_all_orders`'s numeric re-sort** (§4.3) — attempted via a generated
`order_number_numeric` column, reverted at the time because the manual
`create_replacement_order` endpoint wrote `"NNNN-R"` into `order_number`
(`VARCHAR(20) UNIQUE`), which blocked converting the column to `INTEGER`.
That endpoint (and its "Create Replacement" / "Delete Replacement Order" UI)
has been removed — replacement orders are tracked exclusively via Shopify's
`NNNN-R` tag convention (`services/shopify_sync.py`), which only ever sets the
numeric `replacement_of_order_no` column, never `order_number` itself. The
`-R` suffix shown next to a replacement order in the grid (`orders-columns.js`)
is display-only, derived from `replacement_of_order_no`. This unblocks
converting `order_number` to `INTEGER` via a migration, which would also let
the numeric re-sort happen in Postgres instead of Python.

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

**Concurrency guard** (old D4) was investigated and moved to
[`../TODO.md`](../TODO.md) §4 with its full design and findings — notably that
`pg_advisory_lock` is unusable through PostgREST. The orders sync itself is now
covered via a conditional-`UPDATE` lock on `sync_status`'s `in_progress` column
(claimed via `UPDATE ... WHERE in_progress = false`, race-free since Postgres
serializes concurrent UPDATEs on one row); `../TODO.md` §4 is about the remaining
CSV-upload write sequences. **Transactional multi-writes** (old D5)
remains deferred there too — the sync's batched upserts are already atomic so the
real transactional gap is in the cashbook, not the sync.

---

*This document describes the backend as of the `webapp-migration` branch. Line
counts and file layout will drift — treat section 2 as a snapshot.*

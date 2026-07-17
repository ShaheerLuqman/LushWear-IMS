# LushWear IMS — Backend

A technical overview of the backend as it exists today, followed by a
production-oriented review: what's implemented, where the risks are, and how to
improve it. Written for the current state of the `webapp-migration` branch.

---

## 1. What this backend is

A **FastAPI** service that powers the LushWear Inventory Management System. It is
a thin-but-busy API layer sitting between:

- a **Vercel-hosted frontend** (static),
- **Supabase** (Postgres) as the system of record,
- **Shopify Admin API** (product/order source of truth), and
- **PostEx** (courier — CSV upload + delivery-status lookups).

It also generates PDFs server-side (invoices, packaging lists, load sheets) with
ReportLab, and is deployed as a **Hugging Face Docker Space** on port `7860`.

### Tech stack

| Concern | Choice |
|---|---|
| Web framework | FastAPI + Uvicorn (`[standard]`) |
| Data access | `supabase-py` client (PostgREST over HTTP) |
| Validation | Pydantic v2 |
| Auth | Single shared PIN → signed JWT (HS256) |
| PDF | ReportLab, openpyxl (template), pypdf, Pillow |
| HTTP client | httpx (async) for Shopify/PostEx |
| Deploy | Docker on Hugging Face Spaces |

---

## 2. How it's currently structured

```
backend/
├── Dockerfile              # HF Space, uvicorn on $PORT (7860 fallback)
├── requirements.txt
├── README.md               # HF Space front-matter + run notes
├── .env                    # local secrets (untracked)
└── app/
    ├── main.py             # app factory, CORS, router wiring, auth gate
    ├── config.py           # Settings from env (Supabase + Shopify)
    ├── database.py         # lazy singleton Supabase client
    ├── auth.py             # JWT issue/verify (require_auth dependency)
    ├── models.py           # Pydantic schemas (products/orders/cashbook/ledger)
    ├── advance_status.py   # advance reconciliation logic
    ├── order_pdf.py        # order-number extraction from PDFs
    └── routes/
        ├── app_pin.py      # PIN status/verify/setup/change (+ lockout)
        ├── products.py     # products + variants + Shopify product sync   (769 LOC)
        ├── orders.py       # orders, Shopify sync, CSV, PDFs, summaries  (4232 LOC)
        ├── cashbook.py     # cashbook entries + daily balances            (333 LOC)
        └── ledger.py       # ledgers (entries derived from cashbook)
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

### Data model (inferred from queries)

`products` → `variants` (1-N), `orders` (with JSONB `line_items` + legacy `items`
string array), `cashbook_entries` → `cashbook_daily_balances`, `ledgers`,
`app_pin`, `load_sheet_logs`. There is no ORM and no migrations dir in this repo —
schema lives in Supabase and is referenced by string table/column names.

### The heavy pieces

- **`orders.py` Shopify sync** (~800 LOC in one function): paginates the Shopify
  Orders API (last 30 days), then reconciles each order against the DB with a
  large tree of "freeze this field once status leaves unfulfilled" rules
  (courier, tracking, totals, advance, cost, items, line_items). This is the most
  complex and business-critical code in the repo.
- **Advance reconciliation** (`advance_status.py`): cross-checks Shopify advance
  vs. cashbook order-advance inflows and stamps a 1–5 status on each order.
- **PDF generation**: invoices, packaging lists, and load sheets built inline in
  request handlers.
- **PostEx CSV ingest**: fuzzy column-name mapping, tolerant number parsing
  (incl. `2.63E+13` tracking numbers), receivable vs. net-amount reconciliation.

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

- **Wrap multi-write operations in transactions.** Sync, CSV upload, and
  replacement creation issue many independent PostgREST calls. A failure halfway
  through leaves the DB partially updated with no rollback. PostgREST can't do
  interactive transactions, so move multi-step mutations into **Postgres
  functions (RPC)** or a **direct `psycopg`/SQLAlchemy connection** for the
  write-heavy paths. At minimum, make the sync idempotent (it mostly is) and
  restartable.
- **Enforce invariants in the database, not just the app.** Add `CHECK`
  constraints (`amount > 0`, `entry_type in ('inflow','outflow')`), foreign keys
  (`cashbook_entries.folio → ledgers.id`, `variants.product_id → products.id`),
  and `NOT NULL`s. Today `ledger` delete manually checks for references because
  there's no FK doing it.
- **Turn on Supabase Row Level Security** and stop relying on the service key
  from the app as the only gate. Even with a single identity, RLS is your
  defence-in-depth if the key leaks.
- **Concurrency on sync.** Two overlapping `/sync-shopify` calls will race on the
  same rows. Add an advisory lock (Postgres `pg_advisory_lock`) or a simple
  "sync in progress" flag so the endpoint can't run concurrently.

### 4.2 Break up `orders.py`

4232 lines in one file, with a single ~800-line sync function, is the biggest
maintainability liability.

- Extract a `services/shopify_sync.py` (fetch → normalize → reconcile → persist),
  `services/pdf/` (invoice/packaging/load-sheet builders), and
  `services/postex.py` (CSV parsing/reconciliation). Keep route handlers thin:
  parse request → call service → return.
- Pull the repeated **Shopify cursor-pagination loop** (duplicated in
  `products.py` and `orders.py`) into one helper.
- Unit-test the pure functions (`_order_total_from_fulfillments`,
  `compute_advance_status`, tax precedence, `normalize_order_number`,
  `parse_tracking_number_14`) — they're pure and full of edge cases, which is
  exactly what regressions love. **There are currently no tests.**

### 4.3 Performance

- **Push filtering/sorting/aggregation into Postgres.** Several endpoints fetch
  *all* rows in 1000-row pages and then sort/sum in Python (e.g. `get_all_orders`
  numeric re-sort, `products` variant grouping, month summaries). As data grows
  this is O(N) memory and latency per request. Move to:
  - a computed/generated column or an indexed expression for numeric order sort,
  - SQL `GROUP BY` / views for month summaries and daily balances,
  - `select` only the columns you need (some queries already do; make it the rule).
- **Batch the per-row updates.** `batch_update_cost_prices`, the CSV upload, and
  parts of sync issue one `UPDATE` per row in a Python loop. Use `upsert` with a
  single batched payload (the sync's insert path already does this — apply it
  everywhere).
- **Add indexes** on the hot filter/sort columns: `orders(order_receiving_date)`,
  `orders(order_number)`, `orders(order_status)`, `cashbook_entries(entry_date)`,
  `cashbook_entries(folio, order_number)`, `variants(product_id)`.
- **Offload PDF generation.** ReportLab in the request path blocks a worker and
  can be slow for large batches. Consider a background task/queue and stream the
  result, or at least cap batch sizes.

### 4.4 Auth & multi-tenancy

- The **in-memory lockout and dev-fallback JWT secret break on multi-instance /
  restart.** For real production: set `AUTH_SECRET` always (a startup check that
  refuses to boot without it in prod), and move lockout state to Supabase/Redis
  so it survives restarts and works across replicas.
- **Client IP for lockout is `request.client.host`** — behind HF/Vercel proxies
  this is often the proxy IP, so one blocked attacker can lock everyone out (or
  everyone shares one bucket). Read `X-Forwarded-For` (trusted-proxy aware).
- Plan the **users/orgs/RBAC** migration the code already anticipates: add
  `user_id`/`role` claims, per-role dependencies, and RLS policies keyed on the
  JWT. Do it before you have a second user, not after.

### 4.5 Observability & operations

- **Replace `print()` with structured logging** (`logging` + JSON formatter).
  There are `print(...)` calls in sync/recalc paths; they're invisible in
  production and unsearchable.
- **Don't leak internals in error responses.** Many handlers do
  `raise HTTPException(500, detail=str(e))`, which returns raw exception text
  (and in a couple of places the full Shopify URL/token-adjacent context) to the
  client. Log the detail, return a generic message + correlation id.
- **Add request-id middleware, timing metrics, and Sentry** (or equivalent) for
  error tracking. A `/health` exists — add a `/ready` that actually checks
  Supabase connectivity.
- **Rate-limit the whole API**, not just PIN verify (e.g. slowapi), especially
  the expensive sync/PDF endpoints.

### 4.6 Config & deploy hygiene

- **Remove the `/debug/routes` endpoint** (or gate it behind auth + a debug
  flag). It enumerates the full route table publicly.
- The `SHOPIFY_STORE_URL` **default is a real staging store** in `config.py`.
  Defaults for external integrations should be empty and fail loudly, not point
  somewhere real.
- **Pin dependencies** (currently all `>=`). Use a lockfile (`pip-tools`/`uv`/
  Poetry) so builds are reproducible; add Dependabot.
- **Dockerfile**: run as a non-root user, add a `HEALTHCHECK`, and consider a
  multi-worker Uvicorn/Gunicorn setup (`--workers`) — but note that multi-worker
  breaks the in-memory lockout (see 4.4) until that state is externalized.
- **`ALLOWED_ORIGINS` defaults to `*` with `allow_credentials=True`.** That
  combination is invalid per the CORS spec and browsers reject it; make prod
  require an explicit origin list and fail if it's `*` while credentials are on.

### 4.7 API design

- **Version the API** (`/api/v1/...`) before external consumers depend on it.
- **Consistent response models.** Many endpoints declare `response_model=List[dict]`
  / `dict`, which throws away FastAPI's schema/validation benefits. Return the
  actual Pydantic models so OpenAPI docs and client generation are accurate.
- **Pagination on list endpoints** returned to the client (orders, cashbook)
  instead of always returning the full set.

---

## 5. Suggested near-term roadmap

**Phase 1 — de-risk (1–2 weeks)**
1. Add DB constraints, FKs, and indexes; enable RLS.
2. Require `AUTH_SECRET` in prod; fix CORS `*`+credentials; remove `/debug/routes`.
3. Structured logging + generic error responses + Sentry.

**Phase 2 — harden the hot paths (2–4 weeks)**
4. Extract `shopify_sync`, `pdf`, and `postex` services out of `orders.py`.
5. Add unit tests for the pure/edge-case functions; add an integration test for sync.
6. Guard concurrent sync (advisory lock); batch the per-row updates.

**Phase 3 — scale (as needed)**
7. Move heavy aggregation into SQL views/RPC; add client-facing pagination.
8. Background-queue PDF generation.
9. Externalize lockout state; introduce users/orgs/RBAC + per-role auth.

---

*This document describes the backend as of the `webapp-migration` branch. Line
counts and file layout will drift — treat section 2 as a snapshot.*

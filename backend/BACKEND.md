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
├── Dockerfile              # Northflank, uvicorn on $PORT (7860 local fallback)
├── requirements.txt
├── README.md               # Deploy + run notes
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

- ✅ **DONE — Enforce invariants in the database.** FKs
  (`variants → products`, `cashbook_entries.folio → ledgers`), `CHECK`s
  (`amount > 0`, `entry_type`, `piece_received`, `order_status` non-blank,
  `advance_status BETWEEN 1 AND 5`), and an `updated_at` trigger are in place and
  verified live. See [`DATABASE.md`](DATABASE.md). (The soft links
  `orders ↔ cashbook_entries` and JSONB line-item ids are intentionally *not* FKs
  — documented there.)
- ✅ **DONE — Supabase Row Level Security** is enabled on all tables; the backend
  uses the Secret key (bypasses RLS), the public/publishable path is closed.
- **Wrap multi-write operations in transactions.** *(Still open.)* Sync, CSV
  upload, and replacement creation issue many independent PostgREST calls. A
  failure halfway through leaves the DB partially updated with no rollback.
  PostgREST can't do interactive transactions, so move multi-step mutations into
  **Postgres functions (RPC)** or a **direct `psycopg`/SQLAlchemy connection** for
  the write-heavy paths. At minimum, keep the sync idempotent and restartable.
- **Concurrency on sync.** *(Still open.)* Two overlapping `/sync-shopify` calls
  will race on the same rows. Add an advisory lock (Postgres `pg_advisory_lock`)
  or a "sync in progress" flag so the endpoint can't run concurrently.

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
- ✅ **DONE — indexes** on the hot filter/sort columns (`orders(order_receiving_date)`,
  `orders(replacement_of_order_no)`, `cashbook_entries(folio, order_number)`, plus
  the pre-existing ones) are applied. See [`DATABASE.md`](DATABASE.md).
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
1. ✅ ~~Add DB constraints, FKs, and indexes; enable RLS.~~ **Done** — see
   [`DATABASE.md`](DATABASE.md).
2. ✅ ~~Require `AUTH_SECRET` in prod; fix CORS `*`+credentials; remove
   `/debug/routes`.~~ **Done** — `APP_ENV` gates prod strictness in `main.py`.
3. ✅ ~~Structured logging + generic error responses.~~ **Done** — global
   exception handler + `logging_config.py`; all `str(e)` leaks and `print()` calls
   removed. (Sentry still optional/open.)

Phase 1 is complete. §7 below breaks the remaining work into ordered steps.

**Phase 2 — harden the hot paths (2–4 weeks)**
4. Extract `shopify_sync`, `pdf`, and `postex` services out of `orders.py`.
5. Add unit tests for the pure/edge-case functions; add an integration test for sync.
6. Guard concurrent sync (advisory lock); batch the per-row updates.

**Phase 3 — scale (as needed)**
7. Move heavy aggregation into SQL views/RPC; add client-facing pagination.
8. Background-queue PDF generation.
9. Externalize lockout state; introduce users/orgs/RBAC + per-role auth.

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
- [ ] **Admin Portal (API)** — endpoints to manage organizations, users, and
      roles (UI in TODO.md).
- [ ] **Role-based access to columns** — enforce per-role column visibility/edit
      server-side (depends on Organizations & Users).
- [ ] **Live user count** — track/expose currently-active users for the admin
      portal.

### Performance
- [ ] **Caching** — cache hot reads (e.g. products, ledgers) to cut Supabase
      round-trips.
- [ ] **Optimize the delivery-status fetch** — reduce latency / batch the
      per-order courier lookups.

### Data & reporting
- [ ] **Carrier health in Monthly Summary** — per-carrier delivered/total parcel
      percentage; extend the `month-summary` endpoints in `orders.py`.
- [ ] **Sync-from-Shopify last-updated time** — persist and expose when the last
      sync ran.
- [ ] **Per-order last-fetched time** — persist and expose when each order's
      delivery status was last refreshed.
- [ ] **Server status / health** — a health signal the frontend can poll to show
      online/offline (relates to the `/ready` idea in §4.5).
- [ ] **Notifications** — endpoints + storage for notifications (UI in TODO.md).

### New capabilities
- [ ] **AI chatbot** — natural-language querying of the data (API/agent layer).

### Observability
- [ ] **Activity logging / audit trail** — store and track user activity via logs
      (pairs with the structured-logging work in §4.5).

### Fixes
- [ ] **Order recalculation: account for discount codes** — factor discount codes
      into recalculation (see `PRICE_REDUCTION_DISCOUNT_CODES` and commit
      `65ed0ce`; clarify intended cost/total behavior).

### Engineering / quality
- [ ] **Test suite** — stand up automated tests (start with the pure functions in
      §4.2) and make it policy to add tests covering each new issue/fix so
      regressions don't recur.

---

## 7. Step-by-step improvement plan

Ordered so that **no step changes business logic until Stage D**. Each stage is
independently shippable and reviewable. Current sizes: `orders.py` 4280,
`products.py` 799, `cashbook.py` 296, `ledger.py` 128.

### Stage A — zero-risk hygiene (no behavior change at all)

Mechanical changes a reviewer can verify by inspection.

- [ ] **A1. Replace the 6 bare `except:` clauses** with `except Exception:` (or
      the specific type). Bare `except` also swallows `KeyboardInterrupt`/
      `SystemExit`. Locations: `orders.py` (542, 568, 829, 832, 1053),
      `products.py` (393).
- [ ] **A2. Replace 25 `datetime.utcnow()` calls** with
      `datetime.now(timezone.utc)`. `utcnow()` is deprecated in 3.12+ and returns
      a naive datetime, which is a latent timezone bug.
      (`orders.py` ×18, `products.py` ×7.)
- [ ] **A3. Remove unused imports / dead code** across the routers.
- [ ] **A4. Pin dependencies** in `requirements.txt` (currently all `>=`); add a
      lockfile so builds are reproducible.

**Verify:** app imports, `/health` responds, one endpoint per router returns the
same payload as before.

### Stage B — deduplicate (identical behavior, less code)

Same inputs → same outputs; only the call path changes.

- [ ] **B1. Extract the Shopify cursor-pagination loop.** The Link-header/
      `page_info` parsing is duplicated near-identically in `orders.py` and
      `products.py` (~17 matching markers each). Pull into one helper
      (e.g. `app/shopify.py: paginate(url, headers)`), used by both syncs.
- [ ] **B2. Extract the Supabase offset-pagination loop.** 13 hand-rolled
      `while True: … .range(offset, offset+N-1)` loops (`orders.py` ×10,
      `products.py` ×1, `advance_status.py` ×2). One
      `fetch_all(query_factory, page_size)` helper replaces them all.
- [ ] **B3. Centralize the Shopify client/config** (store-URL normalization,
      headers, API version) — currently rebuilt inline in both sync functions.

**Verify:** run both syncs against Shopify and diff the resulting rows/counts
against a pre-change run.

### Stage C — typing & API contract (no runtime behavior change)

- [ ] **C1. Replace `response_model=List[dict]` / `dict`** (25 occurrences) with
      the real Pydantic models so OpenAPI docs and validation are accurate.
      Do this **per router**, smallest first: `ledger` (6) → `cashbook` (7) →
      `products` (4) → `orders` (8).
- [ ] **C2. Tighten `models.py`** — `Field` constraints (`amount > 0`, `qty >= 1`),
      `Enum`/`Literal` for `entry_type` / `piece_received`, and Pydantic v2
      `ConfigDict` instead of the deprecated `class Config`.
- [ ] **C3. Consider `Decimal` for money fields** to match the DB's `DECIMAL`
      columns and remove float-rounding tolerance checks.

> ⚠️ C1–C2 can **surface** existing bad data as validation errors (that's the
> point, but it changes responses). Roll out one router at a time and watch logs.

### Stage D — structural refactor (touches business logic — do last, after tests)

**Do not start until Stage E tests exist for the pure functions.**

- [ ] **D1. Extract `services/shopify_sync.py`** from `orders.py` (fetch →
      normalize → reconcile → persist). The ~800-line sync function is the most
      business-critical code in the repo.
- [ ] **D2. Extract `services/pdf/`** (invoice, packaging list, load sheet) and
      `services/postex.py` (CSV parsing/reconciliation).
- [ ] **D3. Thin the route handlers** to: parse request → call service → return.
- [ ] **D4. Guard concurrent sync** (`pg_advisory_lock` or a sync-in-progress
      flag) and batch the per-row updates.
- [ ] **D5. Wrap multi-write operations** (sync, CSV upload) in Postgres
      functions/RPC so a mid-run failure rolls back (see §4.1).

### Stage E — tests (start before Stage D)

- [ ] **E1. Unit-test the pure functions** — `compute_advance_status`,
      `_order_total_from_fulfillments`, `_compute_shopify_tax`,
      `_order_number_sort_key`, `normalize_order_number`,
      `parse_tracking_number_14`, `_period_start_end`. All pure, all
      edge-case-heavy, no DB needed.
- [ ] **E2. Route smoke tests** with FastAPI `TestClient` + a mocked Supabase
      client (happy path + 400/404 per router).
- [ ] **E3. Integration test for the sync** against recorded Shopify fixtures
      (`sample_orders.json` / `sample_products.json` already exist).

### Recommended order

**A → B → E1 → C → E2/E3 → D.**

Stages A and B are pure cleanup and safe to do immediately. E1 is cheap and buys
the safety net that makes Stage D sane. C is low-risk but response-visible, so it
follows tests. D is the only stage that can change behavior — do it last, one
extraction at a time, with the sync verified against a known-good run.

---

*This document describes the backend as of the `webapp-migration` branch. Line
counts and file layout will drift — treat section 2 as a snapshot.*

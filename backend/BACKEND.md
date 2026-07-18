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
    │   └── pdf/
    │       ├── invoice.py          # invoice shaping + render  (424)
    │       ├── load_sheet.py       # rider manifest            (229)
    │       └── packaging_list.py   # aggregation + render      (230)
    └── routes/
        ├── app_pin.py      # PIN status/verify/setup/change (+ lockout)
        ├── products.py     # products + variants + Shopify product sync   (700)
        ├── orders.py       # orders, Shopify sync, summaries             (3037)
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

Was 4232 lines; now **3037** after the PDF and PostEx extractions.

- ✅ **DONE — `services/pdf/`** (invoice, packaging list, load sheet),
  `services/postex.py` (CSV), `services/shopify_orders.py` (single-order fetch),
  plus shared `ordering.py` / `paths.py` / `timezones.py` / `money.py`.
- ✅ **DONE — the duplicated Shopify cursor-pagination loop** is one helper
  (`app/shopify.py`), as is the Supabase offset loop (`app/db_utils.py`).
- ✅ **DONE — tests.** 123 of them, hermetic (Supabase faked), gating CI and the
  Docker build. Covers the pure functions listed here plus route wiring.
- **Still open:** `services/shopify_sync.py` — the ~800-line sync function, and the
  last large block in the file. See §7 (D1).

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

- ✅ **DONE — structured logging.** All 37 `print()` calls are `logger` calls;
  `logging_config.py` sets the format and silences httpx's per-request URL noise
  (which leaked query params and flooded the log during syncs).
- ✅ **DONE — no internal leaks in error responses.** A global exception handler
  logs the traceback and returns a generic 500. All 46 `detail=str(e)` leaks are
  gone; the only remaining `str(e)` are intentional 400-level validation messages.
- **Add request-id middleware, timing metrics, and Sentry** (or equivalent) for
  error tracking. A `/health` exists — add a `/ready` that actually checks
  Supabase connectivity.
- **Rate-limit the whole API**, not just PIN verify (e.g. slowapi), especially
  the expensive sync/PDF endpoints.

### 4.6 Config & deploy hygiene

- ✅ **DONE — `/debug/routes` and the interactive docs** are registered only
  outside production (`APP_ENV`).
- ✅ **DONE — dependencies pinned** to exact versions, with `requirements-dev.txt`
  adding only the test tooling so pytest never ships in the runtime image.
  (Dependabot still open.)
- ✅ **DONE — CORS.** Production refuses to boot on a wildcard origin; development
  keeps `*` but with credentials off, which is the only valid wildcard form.
  `AUTH_SECRET` is likewise required in production.
- The `SHOPIFY_STORE_URL` **default is a real staging store** in `config.py`.
  Defaults for external integrations should be empty and fail loudly, not point
  somewhere real.
- **Dockerfile**: run as a non-root user and add a `HEALTHCHECK`. A multi-worker
  Uvicorn/Gunicorn setup would break the in-memory PIN lockout (see 4.4) until that
  state is externalised. The build already runs the test suite as a deploy gate.

### 4.7 API design

- **Version the API** (`/api/v1/...`) before external consumers depend on it.
- ✅ **DONE (mostly) — response models.** Entity endpoints return real Pydantic
  models; the 12 remaining `dict` responses are operation results (sync stats,
  delete confirmations, load-sheet logs), left untyped deliberately.
- **Pagination on list endpoints.** Partly done: `GET /orders/` now returns the
  1,000 most recent by default (`limit` overridable) rather than all 10k. Cashbook
  and products still return the full set.

---

## 5. Status

The de-risking pass is complete: DB constraints/indexes/RLS ([`DATABASE.md`](DATABASE.md)),
prod-gated config in `main.py`, structured logging with generic error responses,
Stages A–C, the PDF/CSV extractions, and a 123-test suite that gates both CI and
the Docker build.

**§7 is the live plan** — it lists only what is left. Longer-horizon items
(SQL-side aggregation, background-queued PDFs, users/orgs/RBAC) live in §6.

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

## 7. Improvement plan — remaining work

✅ **Done:** Stage A (bare excepts, `utcnow()`, dead imports, pinned deps),
Stage B (Shopify + Supabase pagination deduplicated, Shopify client centralised),
Stage C (typed response models, `models.py` constraints/`Literal`s/`ConfigDict`),
Stage D2 (PDF + PostEx extractions), and Stage E1/E2 (123 tests, hermetic, gated
in CI and the Docker build).

Current sizes: `orders.py` 3037 (was 4280), `products.py` 700, `cashbook.py` 298,
`ledger.py` 129, plus `services/` at ~1,100 lines across five modules.

### D1 — extract `services/shopify_sync.py`

The ~800-line sync function is the largest remaining block and the most
business-critical code in the repo (fetch → normalize → reconcile → persist,
including the freeze-after-fulfilled rules, voided-order handling and `NNNN-R`
replacements).

- [ ] Extract it, then thin the route handler to: parse request → call service →
      return (the old **D3**).
- [ ] Verify by running a real sync and diffing `created/updated/skipped` plus the
      affected rows against a known-good run. **The test suite does not cover the
      reconciliation rules**, so a live diff is the safety net here, not pytest.

> Related, and probably worth doing first: **sync performance**
> ([`../TODO.md`](../TODO.md) §3). A recent run reported `created=1, skipped=1279`
> — almost all the work was re-processing unchanged orders. Making the sync
> incremental would both speed it up and shrink the surface D1 has to preserve.

### C3 — `Decimal` for money (investigated — deliberately not done)

Measured against live data: the worst float error across all 10,307 orders is
`1e-12`, **zero rows** would round to a different cent, and the total drift over
₨33.8M is `1.3e-7`. Meanwhile `Decimal` serialises to a JSON *string* by default,
which would break every `parseFloat` in the frontend.

Rounding at the boundary (`app/money.py`) removed the display artifacts without
that risk. Revisit only if money maths gains multiplication/division (tax rates,
percentage discounts, currency conversion), where errors actually compound —
then the pattern is `Decimal` internally, `float` at the API boundary.

### E3 — integration test for the sync

- [ ] Drive the reconciliation against the recorded fixtures
      (`app/routes/sample_orders.json` / `sample_products.json`) with a faked
      Supabase, asserting the created/updated/skipped decisions. This is the
      coverage gap that currently makes D1 riskier than it needs to be — worth
      doing **before** D1, not after.

### Remaining §4 items not yet addressed

- [ ] **Sentry** (or equivalent) for error tracking — structured logging and generic
      error responses are in place, but nothing aggregates exceptions (§4.5).
- [ ] **`/ready`** endpoint that actually checks Supabase connectivity (§4.5).
- [ ] **Rate-limit the API** beyond PIN verify, especially sync/PDF endpoints (§4.5).
- [ ] **Externalise the PIN lockout state** — it is in-memory, so it resets on
      redeploy and does not work across replicas (§4.4).
- [ ] **Trusted-proxy `X-Forwarded-For` handling** for the lockout's client IP (§4.4).
- [ ] **API versioning** (`/api/v1/...`) before external consumers depend on it (§4.7).
- [ ] **Client-facing pagination** on list endpoints (§4.7). Partly addressed:
      `GET /orders/` now defaults to the 1,000 most recent instead of all 10k.
- [ ] **Remaining untyped `response_model=dict`** (12 left) are operation results —
      sync stats, `{"status": "deleted"}`, load-sheet logs — not entities. Typing
      them would mean inventing models for ad-hoc payloads; left as `dict`
      deliberately.

### Deferred elsewhere

**Concurrency guard** (old D4) and **transactional multi-writes** (old D5) were
investigated and moved to [`../TODO.md`](../TODO.md) §4–5 with their full designs
and findings — notably that `pg_advisory_lock` is unusable through PostgREST, and
that the sync's batched upserts are already atomic so the real transactional gap is
in the cashbook, not the sync.

---

*This document describes the backend as of the `webapp-migration` branch. Line
counts and file layout will drift — treat section 2 as a snapshot.*

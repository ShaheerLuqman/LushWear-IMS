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
>   [`DATABASE.md`](DATABASE.md).
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
| Auth | Email+password (per-org users/roles) → signed JWT (HS256) |
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
    ├── models.py           # Pydantic schemas (products/orders/transactions/ledger)
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
        ├── auth.py         # status/login/bootstrap/me/change-password (+ lockout)
        ├── users.py        # per-org user management (admin-only)
        ├── org_settings.py # per-org Shopify/PostEx credentials (admin-only)
        ├── products.py     # products + variants + Shopify product sync   (671)
        ├── orders.py       # orders, Shopify sync, summaries             (2451)
        ├── transactions.py # transaction entries + daily balances         (348)
        └── ledger.py       # ledgers (entries derived from transactions)  (129)
```

### Request lifecycle

1. `main.py` builds the app, adds **CORS**, and mounts routers under `/api`.
2. Every business router (`products`, `orders`, `transactions`, `ledger`) is mounted
   with a global `Depends(require_auth)`; `users`/`org_settings` additionally
   require `Depends(require_role("admin"))` — so all of `/api/*` requires a
   valid Bearer token **except** the `/api/auth/*` router, which is open (it's
   the login/bootstrap gate itself).
3. `require_auth` decodes an HS256 JWT signed with `AUTH_SECRET`.
4. Handlers call `get_supabase()` (a lazily-initialised module-global client) and
   talk to Postgres through PostgREST.

### Authentication model

- Multi-tenant: `users` is pure identity (email/password, plus the
  platform-level `is_superadmin` flag); `org_memberships` is the actual source
  of org access, one row per (person, org) pair with its own `role` (`admin`
  or `staff`) and `is_active` — so the same person can belong to more than one
  organization, with a different role in each. Username is the user's email;
  password is bcrypt-hashed (cost 8).
- `POST /auth/login` issues a **7-day JWT** carrying `sub` (user id), `org_id`/
  `role` for the *current* session's org context, and `is_superadmin`
  (independent of org context). `require_auth` verifies the signature;
  `get_org_id` and `require_role(*roles)` (both in `auth.py`) read the
  current-session claims to scope business-table queries to the caller's org
  (see `org_scope.py`) and gate admin-only routes (`users.py`,
  `org_settings.py`). `GET /auth/my-organizations` / `POST /auth/switch-org`
  let a multi-org member discover and move between the orgs they belong to.
- First login for a brand-new deployment goes through `POST /auth/bootstrap`
  (creates the first org + first admin user, race-free via a `system_bootstrap`
  singleton row; requires a `BOOTSTRAP_TOKEN` header when `APP_ENV=prod`).
- Brute-force protection is a **Supabase-backed, per-email lockout**
  (`login_lockouts` table + `record_login_lockout_failure` RPC — survives
  restarts/redeploys and is shared across replicas), plus a per-IP rate limit
  on `POST /auth/login`.
- Per-org Shopify/PostEx credentials live in `org_integration_settings`,
  encrypted at rest (Fernet, `SETTINGS_ENCRYPTION_KEY`) — see
  `org_settings.py`. There's no longer a single global Shopify store; each org
  configures its own via `PUT /org-settings`.
- The previous single-shared-PIN model (`app_pin`/`pin_lockouts` tables,
  `routes/app_pin.py`) has been fully removed
  (see [`../ORGANIZATIONS_USERS_PLAN.md`](../ORGANIZATIONS_USERS_PLAN.md)).

### Data model

`organizations` ↔ `users` (M-N via `org_memberships`), every business table scoped by `org_id`:
`products` → `variants` (1-N), `orders` (with JSONB `line_items` + legacy `items`
string array), `transaction_entries` → `transaction_daily_balances`, `ledgers`,
`load_sheet_logs`, `org_integration_settings`. There is no ORM; tables/columns
are referenced by string name. The canonical schema lives in [`supabase_schema.sql`](../supabase_schema.sql)
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
  vs. transaction order-advance credits and stamps a 1–5 status on each order.
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
- CORS is env-driven, secrets are gitignored, passwords use bcrypt + lockout —
  the security basics were taken seriously for a solo/small deployment.
- The Shopify/PostEx edge-case handling reflects real operational knowledge
  (removed line items, voided orders, replacement `NNNN-R` orders, PKT period
  boundaries). This is hard-won domain logic.

**Open hardening/feature work is tracked in [`../TODO.md`](../TODO.md), not
here** — this file stays descriptive (what the backend is and how it's built),
not a task list.

---

## 4. Status

The de-risking pass is complete: DB constraints/indexes/RLS ([`DATABASE.md`](DATABASE.md)),
prod-gated config in `main.py`, structured logging with generic error responses,
Stages A–C, the PDF/CSV extractions, and a 123-test suite that gates both CI and
the Docker build. Current sizes: `orders.py` 2451 (was 4280), `products.py` 671,
`transactions.py` 348, `ledger.py` 129, plus `services/` at ~2,100 lines across six
modules.

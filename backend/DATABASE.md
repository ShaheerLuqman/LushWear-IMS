# LushWear IMS — Database

A review of the Supabase (Postgres) schema: what exists today, an honest
assessment of its quality, and prioritized, safe-to-apply improvements.

Source of truth for this doc: [`supabase_schema.sql`](../supabase_schema.sql).
Note this is a hand-maintained schema file, not versioned migrations — the live
database may have drifted from it (see §4.6).

---

## 1. Current schema (as written)

Postgres on Supabase, UUID primary keys (`uuid-ossp`), `TIMESTAMPTZ` everywhere.

| Table | Purpose | Key columns |
|---|---|---|
| `products` | One row per product | `shopify_product_id` UNIQUE, `name`, `price`/`cost_price` DECIMAL |
| `variants` | Sizes/colors per product | FK `product_id → products ON DELETE CASCADE`, `shopify_variant_id` UNIQUE |
| `orders` | Orders (Shopify-synced + manual) | `order_number` UNIQUE, `items` TEXT[], `line_items` JSONB, `delivery_status` JSONB |
| `load_sheet_logs` | Courier load-sheet records | `order_numbers` JSONB, `delivery_charge` |
| `app_pin` | Single-row app unlock PIN | `id='default'`, `pin_hash` (bcrypt) |
| `ledgers` | Accounts (vendors, expense heads…) | `name`, `section` |
| `cashbook_entries` | All cash transactions | FK `folio → ledgers ON DELETE RESTRICT`, `order_number` |
| `cashbook_daily_balances` | Per-day opening/closing balances | `balance_date` UNIQUE |

### Relationships

```
products ──1:N──> variants            (ON DELETE CASCADE)
ledgers  ──1:N──> cashbook_entries    (ON DELETE RESTRICT)  ← blocks ledger delete while entries exist
orders   ~~~~~~~  cashbook_entries    (soft link via order_number string; NOT a FK)
orders   ~~~~~~~  products/variants   (soft link via line_items JSONB ids; NOT a FK)
```

### What's already done well

The database is in **better shape than the application layer** and already
implements several things worth calling out:

- **Money is `DECIMAL`** (`DECIMAL(10,2)` on products/orders, `DECIMAL(12,2)` on
  cashbook) — not float. Storage precision is correct.
- **Referential integrity** with intentional delete behavior: `CASCADE` for
  variants (deleting a product removes its variants), `RESTRICT` for cashbook
  folio (can't delete a ledger that's still in use — this is what makes the
  ledger-delete endpoint safe).
- **`CHECK` constraints** already exist: `cashbook_entries.amount > 0`,
  `entry_type IN ('inflow','outflow')`, `orders.piece_received IN ('Pending','Done','Received')`.
- **`UNIQUE` keys** on `order_number`, `shopify_product_id`, `shopify_variant_id`,
  `balance_date` — these are what make the app's `upsert(on_conflict=...)` calls
  correct.
- A **reasonable index set** on most hot columns (names, shopify ids, cashbook
  date/type/folio/order_number).

**Bottom line:** the schema is solid and does not need a rewrite. The items below
are incremental hardening and a few real performance gaps — not fixes for a
broken design.

---

## 2. Improvements — prioritized

Legend: 🔴 high value / 🟡 worth doing / 🟢 hardening.

### 🔴 2.1 Missing indexes on real query paths

The application filters and sorts on these columns, but they are not indexed:

| Missing index | Why it matters |
|---|---|
| `orders(order_receiving_date)` | **Highest value.** Every month/period view in `orders.py` filters and paginates on this column. Currently a sequential scan on the largest table. |
| `cashbook_entries(folio, order_number)` composite | `advance_status.py` filters on exactly this pair to reconcile advances. A composite serves it far better than the two separate single-column indexes. |
| `orders(replacement_of_order_no)` | Looked up during Shopify sync to link `NNNN-R` replacement orders back to originals. |

Also: **`idx_orders_delivery_status` is a plain btree index on a JSONB column**,
which is effectively useless (btree can't search inside JSON). Either drop it or,
if you actually query inside the JSON, replace it with a `GIN` index.

### 🟡 2.2 Constrain `orders.order_status`

`piece_received` is constrained to an enum, but `order_status` is a free
`VARCHAR(50)`. The app only ever uses a fixed set
(`unfulfilled / fulfilled / cancelled / returned / delivered`), so a typo in code
or a manual SQL edit can silently write an invalid status. Add a `CHECK` (or a
Postgres enum type).

### 🟡 2.3 Bound `orders.advance_status`

It's a computed field that must be 1–5, but nothing enforces that. Add
`CHECK (advance_status BETWEEN 1 AND 5)`.

### 🟡 2.4 Auto-maintain `updated_at`

Every table has `updated_at`, but it is only correct because the **application**
passes `datetime.utcnow()` on every write. Any direct SQL update, or a code path
that forgets the field, leaves it stale. Add a `BEFORE UPDATE` trigger so the DB
maintains it regardless of the writer.

### 🔴 2.5 Row Level Security + direct frontend reads (planned)

**Current state:** RLS is **disabled on all tables**. This is safe *today* only
because the database is reached exclusively through the backend. It stops being
safe the moment a browser-facing key can hit the public REST API — which is
exactly the planned direction (fetching order details directly from the frontend).

#### The key model

Supabase exposes two access paths that must use two different keys:

| Path | Key (new system / legacy) | Reaches browser? | RLS applies? | Allowed to do |
|---|---|---|---|---|
| **Backend** (FastAPI) | **Secret** `sb_secret_…` / `service_role` | No — server only | **No (bypasses RLS)** | Everything |
| **Frontend** (browser) | **Publishable** `sb_publishable_…` / `anon` | Yes — safe to expose | **Yes** | Only what a policy explicitly allows |

> **Status:** the backend has been switched to the **Secret** key
> (`config.py` reads `SUPABASE_SECRET_KEY`, falling back to the legacy
> `SUPABASE_KEY`). The **Publishable** key is loaded into
> `settings.SUPABASE_PUBLISHABLE_KEY` for future frontend use but is not used by
> the backend. Prefer the new Publishable/Secret keys over the legacy anon/
> service_role JWTs — secret keys can be rotated individually if leaked.

Because the backend uses the Secret key (which ignores RLS), **enabling RLS will
not break the backend** — it only closes the public/publishable path.

#### Phased plan

**Phase A — close the public hole (safe to do now).**
Enable RLS on every table with **no policies**. Backend (Secret key) keeps full
access; the publishable/anon path gets nothing.

```sql
ALTER TABLE products                ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants                ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_sheet_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_pin                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledgers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_daily_balances ENABLE ROW LEVEL SECURITY;
```

Verify the app still works after this (it should — the backend bypasses RLS).

**Phase B — expose only what the frontend needs, read-only.**
When direct-from-frontend reads are built, ship the **Publishable** key to the
browser and add a narrow policy per table you expose. For order details:

```sql
-- Browser (publishable/anon) may READ orders — no inserts/updates/deletes.
CREATE POLICY "anon can read orders"
    ON orders FOR SELECT
    TO anon              -- confirm the exact role the publishable key maps to
    USING (true);
```

Rules that keep this safe:
- **`FOR SELECT` only.** All writes stay behind the backend + PIN/JWT. Never add
  an `INSERT/UPDATE/DELETE` (or blanket `FOR ALL`) policy for the browser role.
- **One policy per exposed table.** Leave `cashbook_entries`, `ledgers`,
  `app_pin`, and `cashbook_daily_balances` with **no** anon policy — the browser
  must never read financials or the PIN hash directly.
- **`USING (true)` exposes every row.** With a single shared identity there is no
  per-user filtering, so anyone with the publishable key can read *all* orders.
  If order rows contain data you would not want enumerated (customer names,
  amounts, tracking), expose a **view with only safe columns** instead of the raw
  `orders` table, and point the frontend at the view.

**Phase C (later) — real identities.** When users/orgs/RBAC arrive
(see [`BACKEND.md`](BACKEND.md) §4.4), replace `USING (true)` with policies keyed
on the authenticated user/JWT claims.

> **Do not** re-introduce the old `FOR ALL USING (true)` policy that a schema
> comment once suggested for `load_sheet_logs` — that re-opens the table to the
> publishable/anon key and defeats the purpose of enabling RLS.

### 🟢 2.6 Adopt versioned migrations

`supabase_schema.sql` is a single hand-edited file. There's no guarantee it
matches the live database (the schema even references companion files like
`cashbook_migration.sql` / `supabase_app_pin.sql` that aren't all present on
disk). Move to **Supabase migrations** (or Alembic) so the live schema is
reproducible, diffable, and reviewable.

### 🟢 2.7 Consider tightening the soft links

`orders.order_number` ↔ `cashbook_entries.order_number` and the product/variant
ids inside `orders.line_items` (JSONB) are **string/JSON references, not foreign
keys**, so the DB can't guarantee they point at anything real. This is a
deliberate trade-off (snapshots survive product deletion, replacement orders,
etc.) and probably correct to keep — but worth a periodic **data-quality check**
(a query that flags cashbook entries whose `order_number` matches no order) since
nothing enforces it.

---

## 3. Suggested SQL (all idempotent / safe to run)

```sql
-- 2.5 Enable RLS (Phase A) — safe once the backend uses the Secret key.
-- No policies = publishable/anon path gets nothing; backend (Secret) keeps full access.
ALTER TABLE products                ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants                ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_sheet_logs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_pin                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledgers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashbook_daily_balances ENABLE ROW LEVEL SECURITY;

-- 2.1 Indexes -------------------------------------------------------------
-- (Already applied to the live DB and to supabase_schema.sql; kept here for reference.)
CREATE INDEX IF NOT EXISTS idx_orders_order_receiving_date
    ON orders(order_receiving_date);

CREATE INDEX IF NOT EXISTS idx_orders_replacement_of_order_no
    ON orders(replacement_of_order_no);

CREATE INDEX IF NOT EXISTS idx_cashbook_entries_folio_order_number
    ON cashbook_entries(folio, order_number);

-- The JSONB btree index is not useful; drop it (or swap for GIN if you query into it)
DROP INDEX IF EXISTS idx_orders_delivery_status;
-- CREATE INDEX IF NOT EXISTS idx_orders_delivery_status_gin
--     ON orders USING GIN (delivery_status);

-- 2.2 order_status enum guard --------------------------------------------
ALTER TABLE orders
    ADD CONSTRAINT chk_orders_order_status
    CHECK (order_status IN ('unfulfilled','fulfilled','cancelled','returned','delivered'));
-- NOTE: run `SELECT DISTINCT order_status FROM orders;` first and reconcile any
-- values not in this list, or the ALTER will fail.

-- 2.3 advance_status bound -----------------------------------------------
ALTER TABLE orders
    ADD CONSTRAINT chk_orders_advance_status
    CHECK (advance_status BETWEEN 1 AND 5);

-- 2.4 updated_at trigger --------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to each table that has updated_at:
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'products','variants','orders','ledgers',
        'cashbook_entries','cashbook_daily_balances','app_pin'
    ] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;', t);
        EXECUTE format(
            'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at();', t);
    END LOOP;
END $$;

-- 2.7 Data-quality check (report-only, does not modify anything) ----------
-- Cashbook order-advance entries that reference a non-existent order:
SELECT ce.order_number, count(*)
FROM cashbook_entries ce
LEFT JOIN orders o ON o.order_number = ce.order_number
WHERE ce.order_number IS NOT NULL AND o.id IS NULL
GROUP BY ce.order_number;
```

> **Before applying `ADD CONSTRAINT`:** existing rows are validated immediately,
> so a single bad row makes the `ALTER` fail. Run the corresponding `SELECT
> DISTINCT` / range check first and clean up, or add the constraint `NOT VALID`
> and `VALIDATE CONSTRAINT` later.

---

## 4. Recommended order of work

1. ~~**Add the three missing indexes** (§2.1)~~ — ✅ **done** (applied to live DB
   and reflected in `supabase_schema.sql`).
2. ~~**Drop the useless JSONB btree index** + redundant folio index (§2.1)~~ —
   ✅ **done** in the schema file; run `DROP INDEX IF EXISTS
   idx_cashbook_entries_folio;` against the live DB to fully reconcile.
3. **Switch backend to the Secret key** (§2.5) — ✅ **done** in `config.py`; still
   need to set `SUPABASE_SECRET_KEY` in the Northflank environment/secrets before/at
   deploy.
4. **Enable RLS on all tables, no policies** (§2.5 Phase A) — safe now that the
   backend is on the Secret key; closes the public REST hole. **Do before shipping
   the publishable key anywhere.**
5. **Add the `order_status` and `advance_status` CHECKs** (§2.2, §2.3) after
   verifying existing data.
6. **Add the `updated_at` trigger** (§2.4).
7. **Add `FOR SELECT` publishable policies** (§2.5 Phase B) when the direct
   frontend read is built — consider a safe-columns view instead of the raw table.
8. **Adopt versioned migrations** (§2.6) alongside the broader app-layer hardening
   in [`BACKEND.md`](BACKEND.md) §4.

Steps 1–3 are complete. Step 4 (enable RLS) is the next security-critical action
and is safe to run today.

---

*Snapshot of the schema in `supabase_schema.sql`. Because that file is
hand-maintained, verify against the live database before applying constraints.*

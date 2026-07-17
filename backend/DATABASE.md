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

### 🟢 2.5 Turn on Row Level Security (defense-in-depth)

RLS appears to be off (the schema only mentions enabling it for `load_sheet_logs`
as a 500-error workaround). Today the Supabase service key is the **only** gate;
if it leaks, the database is fully exposed. Even with a single app identity,
enabling RLS with permissive policies keyed on the service role is a cheap safety
net, and it's the foundation for the future users/orgs model.

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
-- 2.1 Indexes -------------------------------------------------------------
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

1. **Add the three missing indexes** (§2.1) — pure win, zero risk, immediate
   latency improvement on order/period views and advance reconciliation.
2. **Drop the useless JSONB btree index** (§2.1).
3. **Add the `order_status` and `advance_status` CHECKs** (§2.2, §2.3) after
   verifying existing data.
4. **Add the `updated_at` trigger** (§2.4).
5. **Enable RLS** and **adopt migrations** (§2.5, §2.6) as part of the broader
   production hardening in [`BACKEND.md`](BACKEND.md) §4.

Items 1–4 are safe, high-value, and can ship today. Items 5–6 are process changes
best done alongside the app-layer work.

---

*Snapshot of the schema in `supabase_schema.sql`. Because that file is
hand-maintained, verify against the live database before applying constraints.*

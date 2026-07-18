# LushWear IMS — Database

A review of the Supabase (Postgres) schema: what exists today, an honest
assessment of its quality, and the design decisions behind it.

Source of truth for this doc: [`supabase_schema.sql`](../supabase_schema.sql).
Note this is a hand-maintained schema file, not versioned migrations — the live
database may have drifted from it (migrating to versioned migrations is tracked in
[`TODO.md`](../TODO.md)).

> **Progress so far:** performance indexes are applied; the backend uses the
> Supabase **Secret** key; **RLS is enabled on all tables** (no policies — the
> public path is closed); the `updated_at` trigger and the `order_status` /
> `advance_status` CHECK constraints are in place. Remaining work is in §4 /
> [`TODO.md`](../TODO.md).

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

**Bottom line:** the schema is solid and does not need a rewrite. The hardening
pass (indexes, RLS, constraints, trigger) is complete; the notes below explain the
deliberate design choices, and remaining work lives in [`TODO.md`](../TODO.md).

---

## 2. Design notes

> **`orders.order_number`** ↔ **`cashbook_entries.order_number`** and the
> product/variant ids inside **`orders.line_items`** (JSONB) are intentionally
> **soft links, not foreign keys.** Advances can be recorded for orders that
> aren't synced yet (or are outside the 30-day Shopify window), and line-item ids
> live in JSONB with snapshot `name`/`variant_title` so history survives product
> rename/delete. Hard FKs would reject these legitimate cases (and JSONB can't
> take a FK at all), so this is by design — not a gap.

> **`orders.order_status`** stays open `VARCHAR` on purpose — the live data holds
> courier-style codes (`CNA`, `ICA`, `RFD`) beyond the core lifecycle set, and
> more statuses are expected, so no whitelist/enum. A non-blank `CHECK` guards
> against empty/typo writes; the canonical "known status" list belongs in the
> **app layer** (a Pydantic `Enum`/`Literal` in `models.py`).

> **`orders.order_receiving_date` is `NOT NULL`** — it is the sole ordering key for
> every order listing. `order_number` can't be used (VARCHAR, so a DB sort is
> lexicographic: `"9999"` outranks `"11308"`, which returns the wrong rows once a
> LIMIT applies), and `created_at` can't be a fallback: bulk syncs stamp thousands
> of rows with an identical value (10,307 orders span only 494 distinct `created_at`
> values, one cluster holding 3,195), so it orders unstably and makes OFFSET
> pagination skip/duplicate rows. The column is 100% populated and all write paths
> fall back to "now", so the constraint is guaranteed by construction.

**Open work items** (direct-frontend publishable policies, versioned migrations)
are tracked in [`TODO.md`](../TODO.md).

---

## 3. Useful queries

```sql
-- Data-quality check (report-only, does not modify anything) --------------
-- Cashbook order-advance entries that reference a non-existent order:
SELECT ce.order_number, count(*)
FROM cashbook_entries ce
LEFT JOIN orders o ON o.order_number = ce.order_number
WHERE ce.order_number IS NOT NULL AND o.id IS NULL
GROUP BY ce.order_number;
```

---

## 4. Status

**Done:** performance indexes, backend on the Secret key (set in both local
`.env` and the Northflank environment), RLS enabled on all tables (no policies),
the `updated_at` trigger, and the `order_status` / `advance_status` CHECK
constraints.

**Remaining** (non-urgent, tracked in [`TODO.md`](../TODO.md)): direct-frontend
publishable `FOR SELECT` policies, and adopting versioned migrations.

---

*Snapshot of the schema in `supabase_schema.sql`. Because that file is
hand-maintained, verify against the live database before applying constraints.*

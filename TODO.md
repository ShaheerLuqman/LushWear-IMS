# TODO

Open, non-urgent work items for LushWear IMS. Completed database hardening
(indexes, Secret key, RLS, `updated_at` trigger, `order_status` / `advance_status`
CHECK constraints, data cleanup) is recorded in
[`backend/DATABASE.md`](backend/DATABASE.md). App-layer improvements (breaking up
`orders.py`, error handling, tests, CORS, etc.) are tracked in
[`backend/BACKEND.md`](backend/BACKEND.md) §4.

---

## Database

### 1. Direct frontend reads via publishable key (`FOR SELECT` policies)

RLS is enabled on all tables with **no policies**, so the public/publishable path
is fully closed today. When the frontend needs to read data directly (e.g. order
details) instead of going through the backend:

- Ship the **Publishable** key (`sb_publishable_…`, already in
  `settings.SUPABASE_PUBLISHABLE_KEY`) to the browser.
- Add a **narrow, read-only** policy per exposed table:

  ```sql
  CREATE POLICY "anon can read orders"
      ON orders FOR SELECT
      TO anon              -- confirm the exact role the publishable key maps to
      USING (true);
  ```

Rules that keep this safe:
- **`FOR SELECT` only** — all writes stay behind the backend + PIN/JWT. Never add
  an `INSERT/UPDATE/DELETE` or blanket `FOR ALL` policy for the browser role.
- **One policy per exposed table.** Leave `cashbook_entries`, `ledgers`,
  `app_pin`, and `cashbook_daily_balances` with **no** anon policy — the browser
  must never read financials or the PIN hash directly.
- **`USING (true)` exposes every row.** With a single shared identity there is no
  per-user filtering, so anyone with the publishable key can read *all* orders. If
  order rows hold data you would not want enumerated (customer names, amounts,
  tracking), expose a **view with only safe columns** and point the frontend at
  the view instead of the raw table.
- Later, when users/orgs/RBAC arrive (see [`backend/BACKEND.md`](backend/BACKEND.md)
  §4.4), replace `USING (true)` with policies keyed on the authenticated user/JWT
  claims.

### 2. Adopt versioned migrations

`supabase_schema.sql` is a single hand-edited file, so there's no guarantee it
matches the live database. Move to **Supabase migrations** (or Alembic) so the
live schema is reproducible, diffable, and reviewable. Do this alongside the
broader app-layer hardening in [`backend/BACKEND.md`](backend/BACKEND.md) §4.

---

## Cleanup / migration

### 3. Drop the legacy `orders.items` column

`orders.items` (the old `TEXT[]` of `"Name - Variant"` strings) was replaced by the
structured `orders.line_items` (JSONB). During the transition both are written in
parallel and readers fall back to `items` when `line_items` is absent. Once
`line_items` is verified in production, remove the legacy field entirely.

**Do this only after** confirming every order has `line_items` populated and the
app has been running on it without issues for a while.

Steps:
- [ ] Stop writing `items` in the Shopify sync paths (`backend/app/routes/orders.py`:
      main sync, `sync-shopify-force`, and `create-replacement`).
- [ ] Remove the legacy fallback branches that read `items`:
  - `_order_line_rows()` (the `# Legacy fallback` block) in `backend/app/routes/orders.py`
  - the `items`-based branches in `recalculate-order-costs` (`backend/app/routes/products.py`)
  - the frontend Items column fallback in `frontend/renderer.js` (`params.data.items` branch)
- [ ] Drop the model field: `items` on `OrderBase` / `Order` / `OrderUpdate` in
      `backend/app/models.py`.
- [ ] Drop the column from the DB and the canonical schema:
      `ALTER TABLE orders DROP COLUMN items;` and remove `items TEXT[]` from
      `supabase_schema.sql`.

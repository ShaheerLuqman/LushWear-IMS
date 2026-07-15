# TODO

## Drop the legacy `orders.items` column

`orders.items` (the old `TEXT[]` of `"Name - Variant"` strings) was replaced by the structured
`orders.line_items` (JSONB). During the transition both are written in parallel and readers fall
back to `items` when `line_items` is absent. Once `line_items` is verified in production, remove
the legacy field entirely.

**Do this only after** confirming every order has `line_items` populated and the app has been
running on it without issues for a while.

Steps:
- [ ] Stop writing `items` in the Shopify sync paths (`backend/app/routes/orders.py`: main sync,
      `sync-shopify-force`, and `create-replacement`).
- [ ] Remove the legacy fallback branches that read `items`:
  - `_order_line_rows()` (the `# Legacy fallback` block) in `backend/app/routes/orders.py`
  - the `items`-based branches in `recalculate-order-costs` (`backend/app/routes/products.py`)
  - the frontend Items column fallback in `frontend/renderer.js` (`params.data.items` branch)
- [ ] Drop the model field: `items` on `OrderBase` / `Order` / `OrderUpdate` in
      `backend/app/models.py`.
- [ ] Drop the column from the DB and the canonical schema:
      `ALTER TABLE orders DROP COLUMN items;` and remove `items TEXT[]` from `supabase_schema.sql`.

-- Addresses Shopify's inventory_levels/adjust.json (location + inventory item,
-- not variant) - needed to push a received/reverted bill's stock into Shopify
-- itself, not just this row. NULL for variants never synced from Shopify;
-- backfilled for existing rows the next time products are synced (see
-- variant_has_changed in routes/products.py).
ALTER TABLE shopify_variants ADD COLUMN IF NOT EXISTS inventory_item_id BIGINT;

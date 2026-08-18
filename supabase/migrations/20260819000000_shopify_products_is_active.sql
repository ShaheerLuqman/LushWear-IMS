-- Whether a product is still active on Shopify. Set by sync-shopify (routes/products.py):
-- true for products Shopify currently reports active, false for ones it no longer does
-- (archived/draft/deleted there) - the products list only shows is_active = true rows.
-- Existing rows default true since they were synced from an active Shopify product.

ALTER TABLE shopify_products ADD COLUMN IF NOT EXISTS is_active
    BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_products_is_active ON shopify_products(is_active);

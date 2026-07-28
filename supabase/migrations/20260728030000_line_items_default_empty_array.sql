-- orders.line_items could end up as literal NULL (as opposed to "[]") for orders
-- created through POST /orders/ without a line_items field in the request body -
-- OrderCreate defaulted it to None and model_dump() inserted that verbatim.
-- Shopify-synced orders never do this: extract_line_items() (shopify_sync.py)
-- always returns at least [].
--
-- Backfill existing NULLs and default the column so future manual inserts that
-- omit line_items land on [] instead of NULL.
UPDATE orders SET line_items = '[]'::jsonb WHERE line_items IS NULL;

ALTER TABLE orders
    ALTER COLUMN line_items SET DEFAULT '[]'::jsonb,
    ALTER COLUMN line_items SET NOT NULL;

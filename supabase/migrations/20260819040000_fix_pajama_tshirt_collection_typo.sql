-- 'Pajama Tshirt' was a stale/typo collection value on 26 products (likely from
-- before the Shopify collection was renamed to 'Pajama T-Shirt'). Product sync
-- only backfills `collection` when it's empty (see _resolve_collection in
-- app/routes/products.py), so it never self-corrects. shopify.KNOWN_COLLECTIONS
-- only recognizes 'Pajama T-Shirt', so these products were silently bucketed
-- as "Others" in the month-summary "Products Sold by Collection" breakdown.
UPDATE shopify_products
   SET collection = 'Pajama T-Shirt', updated_at = NOW()
 WHERE collection = 'Pajama Tshirt';

-- orders.replacement_of_order_no was VARCHAR(20), the same historical reason as
-- order_number (see 20260728010000_order_number_to_integer.sql). It always
-- holds either NULL or a pure digit string extracted from Shopify's "NNNN-R"
-- tag convention (services/shopify_sync.py), so it can follow order_number to
-- INTEGER too.
--
-- Guard first: fail loudly instead of silently truncating/corrupting data if any
-- non-NULL row has a non-numeric value.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM orders
        WHERE replacement_of_order_no IS NOT NULL
          AND replacement_of_order_no !~ '^\d+$'
    ) THEN
        RAISE EXCEPTION 'orders.replacement_of_order_no has non-numeric values; cannot convert to INTEGER';
    END IF;
END $$;

ALTER TABLE orders
    ALTER COLUMN replacement_of_order_no TYPE INTEGER USING replacement_of_order_no::integer;

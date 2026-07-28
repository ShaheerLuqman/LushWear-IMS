-- orders.order_number was VARCHAR(20) because the manual `create_replacement_order`
-- endpoint used to write "NNNN-R" into it. That endpoint (and its UI) has been
-- removed; replacement orders are tracked solely via Shopify's "NNNN-R" tag
-- convention, which sets the numeric `replacement_of_order_no` column and never
-- touches `order_number` itself. See backend/BACKEND.md §7.
--
-- Guard first: fail loudly instead of silently truncating/corrupting data if any
-- row somehow has a non-numeric order_number.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM orders WHERE order_number !~ '^\d+$') THEN
        RAISE EXCEPTION 'orders.order_number has non-numeric values; cannot convert to INTEGER';
    END IF;
END $$;

ALTER TABLE orders
    ALTER COLUMN order_number TYPE INTEGER USING order_number::integer;

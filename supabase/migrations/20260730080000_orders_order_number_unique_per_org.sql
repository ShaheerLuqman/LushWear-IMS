-- Org-scoping cutover, part 2 (ORGANIZATIONS_USERS_PLAN.md Phase 2). Depends
-- on 20260730070000 (orders.org_id must already exist and be backfilled).
--
-- orders.order_number was globally UNIQUE - fine for a single Shopify store,
-- but Shopify's order_number is shop-scoped and typically starts low/sequential,
-- so a second org's own store will produce colliding order_numbers with the
-- first org's. Moves uniqueness to (org_id, order_number) instead.
--
-- Finds the existing single-column UNIQUE constraint on order_number by
-- inspecting pg_constraint/information_schema rather than assuming its
-- default-generated name, in case it was ever created under a different name.
DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    SELECT tc.constraint_name INTO v_constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'orders'
      AND tc.constraint_type = 'UNIQUE'
    GROUP BY tc.constraint_name
    HAVING COUNT(*) = 1 AND bool_and(kcu.column_name = 'order_number');

    IF v_constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', v_constraint_name);
    END IF;
END $$;

ALTER TABLE orders ADD CONSTRAINT orders_org_id_order_number_key UNIQUE (org_id, order_number);

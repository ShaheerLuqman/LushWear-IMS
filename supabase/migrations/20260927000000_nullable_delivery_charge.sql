-- delivery_charge: NULL = not entered yet, 0 = entered as zero (e.g. the customer
-- paid a Local Delivery rider directly). NOT NULL DEFAULT 0 made the two
-- indistinguishable, which is why a known-zero charge was being entered as 1.
--
-- Every existing 0 becomes NULL: until now a 0 almost always meant "never
-- entered". Orders already marked with 1 are left alone.
--
-- Readers are NULL-safe already (SUM ignores NULLs, the bills view COALESCEs,
-- and `delivery_charge > 0` is false for NULL just as for 0). The writers that
-- used to turn NULL back into 0 on every Shopify sync ship with this change.
ALTER TABLE shopify_orders
    ALTER COLUMN delivery_charge DROP NOT NULL,
    ALTER COLUMN delivery_charge DROP DEFAULT;

UPDATE shopify_orders SET delivery_charge = NULL WHERE delivery_charge = 0;

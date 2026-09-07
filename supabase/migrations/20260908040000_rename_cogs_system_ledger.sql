-- ensure_system_ledger suffixed the system Cost of Goods Sold ledger to
-- "Cost of Goods Sold (2)" because an org already has a different, real
-- ledger named "Cost of Goods Sold" (idx_ledgers_org_id_name_lower blocked
-- the plain name). That ledger stays as-is; rename the system ledger to a
-- name that can't collide with it.
UPDATE finances_ledgers
   SET name = 'COGS'
 WHERE system_key = 'cost_of_goods_sold'
   AND name <> 'COGS';

-- Folds is_orders_ledger into system_key, so every "this account fills role X"
-- is stored one way.
--
-- There were two mechanisms for the same thing, with identical guarantees:
-- system_key (cash, opening_balance_equity, inventory, tax_on_purchases) and a
-- dedicated is_orders_ledger boolean. That was an accident of sequencing -
-- is_orders_ledger shipped in Phase 0, before system_key existed in Phase 1.
--
-- Keeping the boolean would have meant a column, an index, two model fields, a
-- guard helper and a checkbox for every future fixed ledger. As system_key, a
-- new role is a value: Phase 3's accounts_receivable and sales cost nothing
-- structurally.
--
-- It also closes a hole the boolean allowed: nothing stopped is_orders_ledger
-- being set on the Cash account, because the guard only checked that no OTHER
-- ledger held the role. One account can now hold only one role, by
-- construction (idx_ledgers_org_system_key).

-- Only where system_key is free: an account that is already the cash or
-- inventory account keeps that role rather than being silently repurposed.
UPDATE ledgers
   SET system_key = 'orders'
 WHERE is_orders_ledger IS TRUE
   AND system_key IS NULL;

-- Surface rather than swallow the collision above, so it can't pass unnoticed.
DO $$
DECLARE
    v_conflicts INT;
BEGIN
    SELECT COUNT(*) INTO v_conflicts
      FROM ledgers
     WHERE is_orders_ledger IS TRUE AND system_key <> 'orders';

    IF v_conflicts > 0 THEN
        RAISE WARNING
            '% ledger(s) were flagged as the Orders ledger but already held another system role; their existing role was kept. Assign the Orders role to a different ledger.',
            v_conflicts;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_ledgers_one_orders_ledger_per_org;
ALTER TABLE ledgers DROP COLUMN IF EXISTS is_orders_ledger;

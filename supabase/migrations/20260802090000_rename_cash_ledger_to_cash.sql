-- The cash system account is called "Cash".
--
-- It was seeded as "Cash in Hand", which is also the name of the headline figure
-- in the app header - and that figure is a *total*: this account plus every
-- ledger flagged include_in_cash_in_hand. One name for two different amounts.
--
-- The account is resolved by system_key everywhere (get_system_ledger_id,
-- ledgers.find(l => l.system_key === 'cash')), never by name, so this is purely
-- what it is labelled.

CREATE OR REPLACE FUNCTION trg_organizations_seed_system_ledgers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- ensure_system_ledger is create-or-return, so this never disturbs an
    -- account an org already has for the role.
    PERFORM ensure_system_ledger(NEW.id, 'cash', 'Cash', 'Asset', '1000', TRUE);
    PERFORM ensure_system_ledger(NEW.id, 'opening_balance_equity', 'Opening Balance Equity', 'Equity', '3900');
    -- Advances received before delivery are money held against goods still
    -- owed, so Orders is a liability rather than revenue.
    PERFORM ensure_system_ledger(NEW.id, 'orders', 'Orders', 'Liability', '2200');
    PERFORM ensure_system_ledger(NEW.id, 'inventory', 'Inventory', 'Asset', '1400');
    PERFORM ensure_system_ledger(NEW.id, 'tax_on_purchases', 'Tax on Purchases', 'Expense', '5900');
    RETURN NEW;
END;
$$;

-- Only orgs still on the seeded name, and only where "Cash" is free:
-- idx_ledgers_org_id_name_lower is a hard unique constraint, and an org that
-- already keeps its own account called "Cash" would fail the whole migration.
-- An org that renamed this account itself keeps its own choice.
DO $$
DECLARE
    l        RECORD;
    renamed  INT := 0;
    skipped  INT := 0;
BEGIN
    FOR l IN SELECT id, org_id FROM ledgers WHERE system_key = 'cash' AND lower(trim(name)) = 'cash in hand' LOOP
        IF EXISTS (
            SELECT 1 FROM ledgers
             WHERE org_id = l.org_id AND id <> l.id AND lower(trim(name)) = 'cash'
        ) THEN
            skipped := skipped + 1;
        ELSE
            UPDATE ledgers SET name = 'Cash' WHERE id = l.id;
            renamed := renamed + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'Cash account renamed for % organization(s); % skipped (name already taken).', renamed, skipped;
END $$;

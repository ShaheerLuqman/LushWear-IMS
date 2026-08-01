-- Tax on Purchases is no longer created with the organization.
--
-- It was seeded up front for every org, so a chart of accounts opened with an
-- Expense account nobody had used and most never would - bills are the only
-- thing that posts to it, and only when one carries tax.
--
-- Nothing is lost by dropping it from the seed: receive_bill still calls
-- ensure_system_ledger for the role when b.tax_amount > 0, which is create-or-
-- return, so the account appears the first time a taxed bill is received and
-- keeps its system_key from then on. An org that wants one sooner can just make
-- an ordinary Expense ledger.

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
    -- No tax_on_purchases: receive_bill creates it on the first taxed bill.
    RETURN NEW;
END;
$$;

-- Clear out the ones already seeded, keeping any that turned out to be used.
--
-- Deletion is attempted rather than pre-checked against each referencing table:
-- journal_lines and cashbook_entries are ON DELETE RESTRICT, so an account with
-- history raises foreign_key_violation and is kept. That covers a set opening
-- balance too - it posts a journal line of its own. ledger_balances cascades.
DO $$
DECLARE
    l        RECORD;
    removed  INT := 0;
    kept     INT := 0;
BEGIN
    FOR l IN SELECT id FROM ledgers WHERE system_key = 'tax_on_purchases' LOOP
        BEGIN
            DELETE FROM ledgers WHERE id = l.id;
            removed := removed + 1;
        EXCEPTION WHEN foreign_key_violation THEN
            kept := kept + 1;
        END;
    END LOOP;

    RAISE NOTICE 'Removed % unused Tax on Purchases account(s); kept % with postings.', removed, kept;
END $$;

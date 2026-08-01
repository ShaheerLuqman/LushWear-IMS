-- System ledgers are created with the organization and are no longer chosen by
-- the user.
--
-- Until now they were seeded by whichever migration first needed one, so a NEW
-- org got none of them, and the Orders ledger had to be picked by hand from a
-- role dropdown. Both are gone: a trigger on `organizations` creates all five,
-- and system_key is server-managed - the API no longer accepts it, and a ledger
-- holding one cannot be deleted.
--
-- The trigger sits on the table rather than in the org-creation route so it
-- fires for every writer - the API, the superadmin portal, a row inserted from
-- the SQL editor - matching how the balance and journal triggers are handled.

CREATE OR REPLACE FUNCTION trg_organizations_seed_system_ledgers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- ensure_system_ledger is create-or-return, so this is safe to re-run and
    -- never disturbs an account an org already has for the role.
    PERFORM ensure_system_ledger(NEW.id, 'cash', 'Cash in Hand', 'Asset', '1000', TRUE);
    PERFORM ensure_system_ledger(NEW.id, 'opening_balance_equity', 'Opening Balance Equity', 'Equity', '3900');
    -- Advances received before delivery are money held against goods still owed,
    -- so the Orders account is a liability rather than revenue. Only applied to
    -- orgs that don't already have one - an existing Orders ledger keeps its
    -- own Nature.
    PERFORM ensure_system_ledger(NEW.id, 'orders', 'Orders', 'Liability', '2200');
    PERFORM ensure_system_ledger(NEW.id, 'inventory', 'Inventory', 'Asset', '1400');
    PERFORM ensure_system_ledger(NEW.id, 'tax_on_purchases', 'Tax on Purchases', 'Expense', '5900');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_seed_system_ledgers ON organizations;
CREATE TRIGGER organizations_seed_system_ledgers
AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION trg_organizations_seed_system_ledgers();

-- Adopt an existing ledger literally named "Orders" before creating one.
--
-- Name matching is normally the wrong tool - it is what report_category was
-- rewritten to stop doing - but this is a one-time backfill, not a runtime
-- classifier, and the alternative is worse: an org that already keeps an
-- "Orders" ledger would get a second one called "Orders (2)", with the advance
-- flow pointing at the empty new account and the real history stranded on the
-- old one.
DO $$
DECLARE
    org      RECORD;
    v_id     UUID;
    adopted  INT := 0;
BEGIN
    FOR org IN SELECT id FROM organizations LOOP
        IF NOT EXISTS (
            SELECT 1 FROM ledgers WHERE org_id = org.id AND system_key = 'orders'
        ) THEN
            SELECT id INTO v_id
              FROM ledgers
             WHERE org_id = org.id
               AND lower(trim(name)) = 'orders'
               AND system_key IS NULL
             LIMIT 1;

            IF v_id IS NOT NULL THEN
                UPDATE ledgers SET system_key = 'orders' WHERE id = v_id;
                adopted := adopted + 1;
            END IF;
        END IF;
    END LOOP;

    IF adopted > 0 THEN
        RAISE NOTICE 'Adopted % existing "Orders" ledger(s) as the Orders system account.', adopted;
    END IF;
END $$;

-- Backfill every org that predates the trigger.
DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'cash', 'Cash in Hand', 'Asset', '1000', TRUE);
        PERFORM ensure_system_ledger(org.id, 'opening_balance_equity', 'Opening Balance Equity', 'Equity', '3900');
        PERFORM ensure_system_ledger(org.id, 'orders', 'Orders', 'Liability', '2200');
        PERFORM ensure_system_ledger(org.id, 'inventory', 'Inventory', 'Asset', '1400');
        PERFORM ensure_system_ledger(org.id, 'tax_on_purchases', 'Tax on Purchases', 'Expense', '5900');
    END LOOP;
END $$;

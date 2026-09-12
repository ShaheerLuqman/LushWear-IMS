-- Adds Sales Revenue and Sales Return as system ledgers, seeded on org
-- creation like the other system accounts.
CREATE OR REPLACE FUNCTION trg_organizations_seed_system_ledgers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM ensure_system_ledger(NEW.id, 'cash', 'Cash', 'Asset', '1000', TRUE);
    PERFORM ensure_system_ledger(NEW.id, 'opening_balance_equity', 'Opening Balance Equity', 'Equity', '3900');
    PERFORM ensure_system_ledger(NEW.id, 'orders', 'Orders', 'Liability', '2200');
    PERFORM ensure_system_ledger(NEW.id, 'inventory', 'Inventory', 'Asset', '1400');
    PERFORM ensure_system_ledger(NEW.id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000');
    PERFORM ensure_system_ledger(NEW.id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000');
    PERFORM ensure_system_ledger(NEW.id, 'sales_return', 'Sales Return', 'Revenue', '4100');
    RETURN NEW;
END;
$$;

-- Adopt existing "Sales Revenue" / "Sales Return" ledgers (e.g. lushwear's)
-- before creating new ones - same one-time name-match idiom as the Orders
-- adoption in 20260801150000_system_ledgers_on_org_creation.sql.
DO $$
DECLARE
    org  RECORD;
    v_id UUID;
BEGIN
    FOR org IN SELECT id FROM system_organizations LOOP
        IF NOT EXISTS (SELECT 1 FROM finances_ledgers WHERE org_id = org.id AND system_key = 'sales_revenue') THEN
            SELECT id INTO v_id FROM finances_ledgers
             WHERE org_id = org.id AND lower(trim(name)) = 'sales revenue' AND system_key IS NULL
             LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE finances_ledgers SET system_key = 'sales_revenue' WHERE id = v_id;
            END IF;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM finances_ledgers WHERE org_id = org.id AND system_key = 'sales_return') THEN
            SELECT id INTO v_id FROM finances_ledgers
             WHERE org_id = org.id AND lower(trim(name)) = 'sales return' AND system_key IS NULL
             LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE finances_ledgers SET system_key = 'sales_return' WHERE id = v_id;
            END IF;
        END IF;

        PERFORM ensure_system_ledger(org.id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000');
        PERFORM ensure_system_ledger(org.id, 'sales_return', 'Sales Return', 'Revenue', '4100');
    END LOOP;
END $$;

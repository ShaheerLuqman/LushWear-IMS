-- Courier receivable ledgers, seeded at org creation like every other system
-- ledger, instead of lazily the first time someone visits Settings > Couriers
-- and toggles one on (enable_courier_system_ledger, called from
-- backend/app/couriers.py). Until that toggle happened, resolve_courier_ledger
-- fell through to the shared courier_other account - so a fresh org uploading
-- a PostEx CSV before ever touching Settings had its whole receivable posted
-- to the wrong, shared ledger.
--
-- The four ids/labels/codes here are backend/app/couriers.py's own
-- COURIER_CATALOG - kept in sync by hand, same as this trigger already keeps
-- sales_return/delivery_charges/etc. in sync with what the posting functions
-- expect. Adding a 5th courier there needs one more line here too.
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
    PERFORM ensure_system_ledger(NEW.id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000');
    PERFORM ensure_system_ledger(NEW.id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000');
    PERFORM ensure_system_ledger(NEW.id, 'sales_return', 'Sales Return', 'Revenue', '4100');
    PERFORM ensure_system_ledger(NEW.id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100');
    PERFORM ensure_system_ledger(NEW.id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200');
    -- No tax_on_purchases: receive_bill creates it on the first taxed bill.
    PERFORM ensure_system_ledger(NEW.id, 'courier_postex', 'PostEx', 'Asset', '1150');
    PERFORM ensure_system_ledger(NEW.id, 'courier_couriers_next', 'Couriers Next', 'Asset', '1151');
    PERFORM ensure_system_ledger(NEW.id, 'courier_tcs', 'TCS', 'Asset', '1152');
    PERFORM ensure_system_ledger(NEW.id, 'courier_bykea', 'Bykea', 'Asset', '1153');
    RETURN NEW;
END;
$$;

-- Covers orgs that predate this migration.
DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM system_organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'courier_postex', 'PostEx', 'Asset', '1150');
        PERFORM ensure_system_ledger(org.id, 'courier_couriers_next', 'Couriers Next', 'Asset', '1151');
        PERFORM ensure_system_ledger(org.id, 'courier_tcs', 'TCS', 'Asset', '1152');
        PERFORM ensure_system_ledger(org.id, 'courier_bykea', 'Bykea', 'Asset', '1153');
    END LOOP;
END $$;

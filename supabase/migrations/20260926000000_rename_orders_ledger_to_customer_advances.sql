-- The "orders" system ledger only ever holds customer advances: received before
-- delivery, applied when the courier bill posts. "Customer Advances" says so; "Orders"
-- read as if it held order values. Only the name changes - every posting function
-- finds the account by system_key 'orders', which stays.

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
    -- owed, so Customer Advances is a liability rather than revenue.
    PERFORM ensure_system_ledger(NEW.id, 'orders', 'Customer Advances', 'Liability', '2200');
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

-- Only orgs still on the seeded name, and only where the new name is free:
-- idx_ledgers_org_id_name_lower is a hard unique constraint. An org that renamed
-- this account itself keeps its own choice.
UPDATE finances_ledgers l
   SET name = 'Customer Advances'
 WHERE l.system_key = 'orders'
   AND lower(trim(l.name)) = 'orders'
   AND NOT EXISTS (
       SELECT 1 FROM finances_ledgers o
        WHERE o.org_id = l.org_id AND o.id <> l.id AND lower(trim(o.name)) = 'customer advances'
   );

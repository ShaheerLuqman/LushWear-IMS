-- Courier ledgers are named "Courier <label>" ("PostEx" -> "Courier PostEx"), the
-- catch-all "Courier Receivables - Other" becomes "Courier Others", the Bykea courier
-- becomes the generic Local Delivery one (courier_local_delivery), and SCS gets a
-- ledger of its own (it is now in app/couriers.py's COURIER_CATALOG, so its fixed
-- delivery charge comes from Settings > Couriers instead of a hard-coded 180).
--
-- System ledger names are now locked (app/routes/ledger.py), so every system
-- ledger - not just the couriers' - is reset to its canonical name, including ones
-- an org renamed: a custom name would otherwise be frozen for good. Postings find
-- these accounts by system_key, so no posting changes.
--
-- Kept in sync by hand with SYSTEM_LEDGER_LABELS (app/ledger_roles.py) and
-- COURIER_LEDGER_LABELS (app/couriers.py).

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
    PERFORM ensure_system_ledger(NEW.id, 'courier_postex', 'Courier PostEx', 'Asset', '1150');
    PERFORM ensure_system_ledger(NEW.id, 'courier_couriers_next', 'Courier Couriers Next', 'Asset', '1151');
    PERFORM ensure_system_ledger(NEW.id, 'courier_tcs', 'Courier TCS', 'Asset', '1152');
    PERFORM ensure_system_ledger(NEW.id, 'courier_local_delivery', 'Courier Local Delivery', 'Asset', '1153');
    PERFORM ensure_system_ledger(NEW.id, 'courier_scs', 'Courier SCS', 'Asset', '1154');
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_courier_ledger(p_org_id UUID, p_courier VARCHAR)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id  UUID;
    v_key TEXT := lower(regexp_replace(COALESCE(p_courier, ''), '[^a-zA-Z0-9]', '', 'g'));
BEGIN
    IF v_key <> '' THEN
        SELECT id INTO v_id
          FROM finances_ledgers
         WHERE org_id = p_org_id
           AND system_key LIKE 'courier%'
           AND replace(system_key, '_', '') = 'courier' || v_key
         LIMIT 1;
        IF v_id IS NOT NULL THEN
            RETURN v_id;
        END IF;
    END IF;
    -- "Other", or a courier switched off in Settings, still ships real goods and
    -- still holds real COD - an unmapped name must not block the posting.
    RETURN ensure_system_ledger(p_org_id, 'courier_other', 'Courier Others', 'Asset', '1159');
END;
$$;

DO $$
DECLARE
    r RECORD;
BEGIN
    CREATE TEMP TABLE _canonical_ledger_names (system_key TEXT PRIMARY KEY, name TEXT NOT NULL) ON COMMIT DROP;
    INSERT INTO _canonical_ledger_names VALUES
        ('cash', 'Cash'),
        ('opening_balance_equity', 'Opening Balance Equity'),
        ('orders', 'Customer Advances'),
        ('inventory', 'Inventory'),
        ('cost_of_goods_sold', 'COGS'),
        ('sales_revenue', 'Sales Revenue'),
        ('sales_return', 'Sales Return'),
        ('delivery_charges', 'Delivery Charges'),
        ('withholding_tax', 'Withholding Tax'),
        ('tax_on_purchases', 'Tax on Purchases'),
        ('other_expenses', 'Other Expenses'),
        ('courier_postex', 'Courier PostEx'),
        ('courier_couriers_next', 'Courier Couriers Next'),
        ('courier_tcs', 'Courier TCS'),
        ('courier_local_delivery', 'Courier Local Delivery'),
        ('courier_scs', 'Courier SCS'),
        ('courier_other', 'Courier Others');

    -- Same account and entries, new role: resolve_courier_ledger matches the courier
    -- name "Local Delivery" to courier_local_delivery.
    UPDATE finances_ledgers SET system_key = 'courier_local_delivery' WHERE system_key = 'courier_bykea';

    -- Only where the name is free: idx_ledgers_org_id_name_lower is a hard unique
    -- constraint, and merging a user's same-named ledger is not this migration's call.
    UPDATE finances_ledgers l
       SET name = c.name
      FROM _canonical_ledger_names c
     WHERE l.system_key = c.system_key
       AND l.name <> c.name
       AND NOT EXISTS (
           SELECT 1 FROM finances_ledgers o
            WHERE o.org_id = l.org_id AND o.id <> l.id AND lower(o.name) = lower(c.name)
       );

    FOR r IN
        SELECT l.org_id, l.name, c.name AS canonical
          FROM finances_ledgers l
          JOIN _canonical_ledger_names c ON c.system_key = l.system_key
         WHERE l.name <> c.name
    LOOP
        RAISE NOTICE 'org %: system ledger "%" left unrenamed - another ledger already holds "%"',
            r.org_id, r.name, r.canonical;
    END LOOP;
END;
$$;

DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM system_organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'courier_scs', 'Courier SCS', 'Asset', '1154');
    END LOOP;
END;
$$;

-- Accounts, dates and documents Phase 5 needs before an order can post.
-- Revenue is recognised at DISPATCH (courier_pickup_date), so a return has to
-- unwind a full-value entry rather than never having posted one - see
-- FINANCE_ACCOUNTING_PLAN.md Phase 5.
--
-- cost_of_goods_sold, sales_revenue and sales_return already exist; only
-- delivery_charges and withholding_tax are new. sales_return is contra-revenue:
-- Revenue by nature, debit by normal balance, so net sales reads as
-- sales_revenue - sales_return and gross sales stays intact.
--
-- The two sales accounts are named here with the system_key they already carry in
-- the live database, where they were created by hand rather than by a migration.
-- Seeding them is what makes a new org match an existing one; ensure_system_ledger
-- returns the existing account rather than making a second.


-- ensure_system_ledger resolved a name clash with a numeric suffix but not a CODE
-- clash, and code is unique per org (idx_ledgers_org_code) - so seeding a system
-- account onto a number the org already keeps a hand-made ledger on aborted the whole
-- run. Walk to the next free number instead, and give up to a NULL code (which the
-- partial index allows any number of) if the code is not numeric.
CREATE OR REPLACE FUNCTION ensure_system_ledger(
    p_org_id UUID,
    p_system_key VARCHAR,
    p_name VARCHAR,
    p_type VARCHAR,
    p_code VARCHAR,
    p_is_cash_equivalent BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id     UUID;
    v_name   VARCHAR := p_name;
    v_code   VARCHAR := p_code;
    v_suffix INT := 1;
BEGIN
    SELECT id INTO v_id FROM finances_ledgers WHERE org_id = p_org_id AND system_key = p_system_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    WHILE EXISTS (
        SELECT 1 FROM finances_ledgers WHERE org_id = p_org_id AND lower(name) = lower(v_name)
    ) LOOP
        v_suffix := v_suffix + 1;
        v_name := p_name || ' (' || v_suffix || ')';
    END LOOP;

    WHILE v_code IS NOT NULL AND EXISTS (
        SELECT 1 FROM finances_ledgers WHERE org_id = p_org_id AND code = v_code
    ) LOOP
        v_code := CASE WHEN v_code ~ '^\d+$' THEN (v_code::INT + 1)::VARCHAR ELSE NULL END;
    END LOOP;

    INSERT INTO finances_ledgers (org_id, name, type, code, system_key, is_cash_equivalent, opening_balance)
    VALUES (p_org_id, v_name, p_type, v_code, p_system_key, p_is_cash_equivalent, 0)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;


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
    RETURN NEW;
END;
$$;

DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM system_organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'sales_revenue', 'Sales Revenue', 'Revenue', '4000');
        PERFORM ensure_system_ledger(org.id, 'sales_return', 'Sales Return', 'Revenue', '4100');
        PERFORM ensure_system_ledger(org.id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100');
        PERFORM ensure_system_ledger(org.id, 'withholding_tax', 'Withholding Tax', 'Expense', '5200');
    END LOOP;
END $$;


-- The date the return voucher posts on. Not derivable in SQL: which history entry
-- means "returned" is decided by _classify_status's text matching in
-- routes/orders.py, so this is written from Python wherever order_status is, and
-- backfilled by scripts/backfill_order_returned_at.py.
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;


-- One courier payout = one CPR = one deposit in the bank, and one settlement
-- voucher. Per-order cash postings would never reconcile against a bank statement.
--
-- folio is normalised (the "-API" suffix _folio_from_date adds to mark a
-- tracking-derived folio is stripped here) so one real CPR that was settled partly
-- from a CSV and partly from the API is still one payout. The suffix stays on the
-- order, where it records provenance.
CREATE TABLE IF NOT EXISTS finances_courier_payouts (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES system_organizations(id),
    courier     VARCHAR(100) NOT NULL,
    folio       VARCHAR(255) NOT NULL,
    payout_date DATE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finances_courier_payouts_org_courier_folio_key UNIQUE (org_id, courier, folio)
);

CREATE INDEX IF NOT EXISTS idx_finances_courier_payouts_org_date
    ON finances_courier_payouts (org_id, payout_date DESC);

ALTER TABLE finances_courier_payouts ENABLE ROW LEVEL SECURITY;

-- Membership on the order, like courier_bill_id: an order settles on exactly one
-- CPR. ON DELETE SET NULL so removing a payout unassigns rather than deletes.
ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS courier_payout_id UUID
    REFERENCES finances_courier_payouts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_courier_payout_id
    ON shopify_orders (courier_payout_id) WHERE courier_payout_id IS NOT NULL;

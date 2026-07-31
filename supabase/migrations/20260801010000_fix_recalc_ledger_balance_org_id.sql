-- Fixes a bug from 20260730070000_add_org_id_to_business_tables.sql: that
-- migration made ledger_balances.org_id NOT NULL but never updated
-- recalc_ledger_balance()'s INSERT to populate it (its own comment wrongly
-- claimed the function needed no change since it's scoped via p_ledger_id) -
-- every cashbook entry write since then has 500'd on
-- "null value in column org_id of relation ledger_balances violates
-- not-null constraint". org_id is derived from ledgers (p_ledger_id is
-- already unique to one org's ledger).

CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC(12, 2);
    v_org_id UUID;
BEGIN
    SELECT org_id INTO v_org_id FROM ledgers WHERE id = p_ledger_id;

    SELECT
        (SELECT opening_balance FROM ledgers WHERE id = p_ledger_id)
      + COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debit'), 0)
      - COALESCE(SUM(amount) FILTER (WHERE entry_type = 'credit'), 0)
    INTO v_balance
    FROM cashbook_entries
    WHERE folio = p_ledger_id;

    IF v_balance = 0 THEN
        DELETE FROM ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    INSERT INTO ledger_balances (ledger_id, org_id, balance, updated_at)
    VALUES (p_ledger_id, v_org_id, v_balance, NOW())
    ON CONFLICT (ledger_id) DO UPDATE SET
        balance    = EXCLUDED.balance,
        updated_at = NOW();
END;
$$;

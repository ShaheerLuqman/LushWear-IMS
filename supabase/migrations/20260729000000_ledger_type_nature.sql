-- Replaces the business-category ledger `type` (Bank, Expense, Payable Vendors,
-- Receivable Vendors, Sales, Investors) with standard accounting Nature
-- categories (Asset, Liability, Equity, Revenue, Expense). Nature drives
-- display grouping only — recalc_ledger_balance is consistent for every
-- ledger regardless of it:
-- New Balance = Previous Balance + Debit - Credit, where an outflow entry
-- debits the ledger (money paid to it) and an inflow entry credits it (money
-- received from it).
--
-- Assumes a clean start (no existing ledgers/entries to reconcile) — run
-- against an empty ledgers table.

ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_type_check;
ALTER TABLE ledgers ADD CONSTRAINT ledgers_type_check
    CHECK (type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense'));

CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC(12, 2);
BEGIN
    SELECT
        (SELECT opening_balance FROM ledgers WHERE id = p_ledger_id)
      + COALESCE(SUM(amount) FILTER (WHERE entry_type = 'outflow'), 0)
      - COALESCE(SUM(amount) FILTER (WHERE entry_type = 'inflow'), 0)
    INTO v_balance
    FROM cashbook_entries
    WHERE folio = p_ledger_id;

    IF v_balance = 0 THEN
        DELETE FROM ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    INSERT INTO ledger_balances (ledger_id, balance, updated_at)
    VALUES (p_ledger_id, v_balance, NOW())
    ON CONFLICT (ledger_id) DO UPDATE SET
        balance    = EXCLUDED.balance,
        updated_at = NOW();
END;
$$;

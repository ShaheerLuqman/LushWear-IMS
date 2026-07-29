-- Renames cashbook_entries.entry_type values from inflow/outflow to
-- credit/debit (inflow -> credit, outflow -> debit — matches the bulk-entry
-- parser's From/Cr = inflow, To/Dr = outflow convention and the ledger-posting
-- direction already used by recalc_ledger_balance), and renames
-- cashbook_daily_balances.total_inflow/total_outflow to total_credit/total_debit
-- to match. The frontend keeps user-facing "Incoming"/"Outgoing" wording and
-- translates at the API boundary.

UPDATE cashbook_entries SET entry_type = CASE entry_type
    WHEN 'inflow' THEN 'credit'
    WHEN 'outflow' THEN 'debit'
    ELSE entry_type
END
WHERE entry_type IN ('inflow', 'outflow');

UPDATE cashbook_entry_audit_log SET entry_type = CASE entry_type
    WHEN 'inflow' THEN 'credit'
    WHEN 'outflow' THEN 'debit'
    ELSE entry_type
END
WHERE entry_type IN ('inflow', 'outflow');

ALTER TABLE cashbook_entries DROP CONSTRAINT IF EXISTS cashbook_entries_entry_type_check;
ALTER TABLE cashbook_entries ADD CONSTRAINT cashbook_entries_entry_type_check
    CHECK (entry_type IN ('credit', 'debit'));

ALTER TABLE cashbook_daily_balances RENAME COLUMN total_inflow TO total_credit;
ALTER TABLE cashbook_daily_balances RENAME COLUMN total_outflow TO total_debit;

CREATE OR REPLACE FUNCTION recalc_cashbook_daily_balances(p_from_date DATE)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_opening NUMERIC(12, 2);
BEGIN
    SELECT closing_balance INTO v_opening
    FROM cashbook_daily_balances
    WHERE balance_date < p_from_date
    ORDER BY balance_date DESC
    LIMIT 1;

    v_opening := COALESCE(v_opening, 0);

    DELETE FROM cashbook_daily_balances
    WHERE balance_date >= p_from_date
      AND balance_date NOT IN (
          SELECT DISTINCT entry_date FROM cashbook_entries WHERE entry_date >= p_from_date
      );

    WITH day_totals AS (
        SELECT entry_date AS balance_date,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'credit'), 0) AS total_credit,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debit'), 0)  AS total_debit
        FROM cashbook_entries
        WHERE entry_date >= p_from_date
        GROUP BY entry_date
    ),
    running AS (
        SELECT balance_date,
               total_credit,
               total_debit,
               v_opening + SUM(total_credit - total_debit)
                   OVER (ORDER BY balance_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS closing_balance
        FROM day_totals
    )
    INSERT INTO cashbook_daily_balances
        (balance_date, opening_balance, total_credit, total_debit, closing_balance, updated_at)
    SELECT balance_date,
           closing_balance - total_credit + total_debit,
           total_credit,
           total_debit,
           closing_balance,
           NOW()
    FROM running
    ON CONFLICT (balance_date) DO UPDATE SET
        opening_balance = EXCLUDED.opening_balance,
        total_credit     = EXCLUDED.total_credit,
        total_debit      = EXCLUDED.total_debit,
        closing_balance  = EXCLUDED.closing_balance,
        updated_at       = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC(12, 2);
BEGIN
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

    INSERT INTO ledger_balances (ledger_id, balance, updated_at)
    VALUES (p_ledger_id, v_balance, NOW())
    ON CONFLICT (ledger_id) DO UPDATE SET
        balance    = EXCLUDED.balance,
        updated_at = NOW();
END;
$$;

-- Makes cashbook_daily_balances.total_debit/total_credit mean what their names
-- say from the *cash* account's point of view, and swaps the existing data to
-- match. See FINANCE_ACCOUNTING_PLAN.md §A2.
--
-- THE TWO PERSPECTIVES (the one thing to understand before touching this file):
--
--   cashbook_entries.entry_type is written from the FOLIO LEDGER's side.
--     'credit' = credit the folio ledger, so cash came IN   (a receipt)
--     'debit'  = debit the folio ledger,  so cash went OUT  (a payment)
--   That is why recalc_ledger_balance can apply entry_type directly:
--     ledger balance = opening + SUM(debit) - SUM(credit)
--
--   cashbook_daily_balances totals are the CASH account's side, which is always
--   the opposite one. Standard bookkeeping: cash received is a DEBIT to cash
--   (the receipts side of a two-column cash book is its debit side).
--     total_debit  = receipts = SUM(amount) WHERE entry_type = 'credit'
--     total_credit = payments = SUM(amount) WHERE entry_type = 'debit'
--
-- So a row with entry_type='credit' correctly appears under Debit on the
-- Cashbook and under Credit on the ledger statement. Both are right - they are
-- two different accounts. Do not "fix" one to match the other.
--
-- Before this migration total_credit held receipts and total_debit held
-- payments, i.e. folio-side values under cash-side names. Nothing reads these
-- two columns for display today (the Cashbook UI sums the entries themselves,
-- and only opening_balance/closing_balance are consumed), so the swap below
-- changes no visible number. opening_balance and closing_balance are unaffected
-- either way: the arithmetic is symmetric.

COMMENT ON COLUMN cashbook_daily_balances.total_debit IS
    'Cash received that day (receipts). Sums cashbook_entries with entry_type = ''credit'' - entry_type is folio-perspective, this column is cash-perspective.';
COMMENT ON COLUMN cashbook_daily_balances.total_credit IS
    'Cash paid out that day (payments). Sums cashbook_entries with entry_type = ''debit'' - entry_type is folio-perspective, this column is cash-perspective.';

-- Postgres evaluates every RHS against the pre-UPDATE row, so this swaps rather
-- than clobbering. Deliberately NOT idempotent - re-running swaps back - which
-- is why it lives only here and not in supabase_schema.sql (a fresh install has
-- no rows to swap).
UPDATE cashbook_daily_balances
SET total_debit  = total_credit,
    total_credit = total_debit;

CREATE OR REPLACE FUNCTION recalc_cashbook_daily_balances(p_from_date DATE, p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_opening NUMERIC(12, 2);
BEGIN
    SELECT closing_balance INTO v_opening
    FROM cashbook_daily_balances
    WHERE org_id = p_org_id AND balance_date < p_from_date
    ORDER BY balance_date DESC
    LIMIT 1;

    v_opening := COALESCE(v_opening, 0);

    DELETE FROM cashbook_daily_balances
    WHERE org_id = p_org_id
      AND balance_date >= p_from_date
      AND balance_date NOT IN (
          SELECT DISTINCT entry_date FROM cashbook_entries
          WHERE org_id = p_org_id AND entry_date >= p_from_date
      );

    WITH day_totals AS (
        SELECT entry_date AS balance_date,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'credit'), 0) AS total_debit,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debit'), 0)  AS total_credit
        FROM cashbook_entries
        WHERE org_id = p_org_id AND entry_date >= p_from_date
        GROUP BY entry_date
    ),
    running AS (
        SELECT balance_date,
               total_debit,
               total_credit,
               v_opening + SUM(total_debit - total_credit)
                   OVER (ORDER BY balance_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS closing_balance
        FROM day_totals
    )
    INSERT INTO cashbook_daily_balances
        (org_id, balance_date, opening_balance, total_debit, total_credit, closing_balance, updated_at)
    SELECT p_org_id,
           balance_date,
           closing_balance - total_debit + total_credit,
           total_debit,
           total_credit,
           closing_balance,
           NOW()
    FROM running
    ON CONFLICT (org_id, balance_date) DO UPDATE SET
        opening_balance = EXCLUDED.opening_balance,
        total_debit      = EXCLUDED.total_debit,
        total_credit     = EXCLUDED.total_credit,
        closing_balance  = EXCLUDED.closing_balance,
        updated_at       = NOW();
END;
$$;

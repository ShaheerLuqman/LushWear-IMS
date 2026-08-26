-- Opt-out flag for Month Summary's per-expense-ledger breakdown. Defaults TRUE
-- so every existing/new Expense ledger keeps showing there unless someone
-- explicitly unchecks it - opt-in-by-default already burned this report once
-- (report_category, replaced in 20260819060000_month_summary_per_ledger_expenses.sql)
-- by silently dropping ledgers nobody got around to tagging.
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS show_in_month_summary BOOLEAN NOT NULL DEFAULT TRUE;

CREATE OR REPLACE FUNCTION get_month_summary_expense_lines(
    p_entry_start DATE,
    p_entry_end DATE,
    p_org_id UUID
)
RETURNS TABLE(
    ledger_id UUID,
    ledger_name VARCHAR,
    amount NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        l.id,
        l.name,
        COALESCE(SUM(ce.amount) FILTER (
            WHERE ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
        ), 0) AS amount
    FROM finances_ledgers l
    LEFT JOIN finances_transaction_entries ce
           ON ce.to_account_id = l.id AND ce.org_id = p_org_id
    WHERE l.org_id = p_org_id
      AND l.type = 'Expense'
      AND l.show_in_month_summary
    GROUP BY l.id, l.name
    ORDER BY l.name;
$$;

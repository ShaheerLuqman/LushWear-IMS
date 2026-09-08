-- get_month_summary_expense_lines only summed the debit side (to_account_id),
-- so a credit against an Expense ledger (refund, reversal) never reduced its
-- Month Summary line. Sum both sides: debit (to_account_id) minus credit
-- (from_account_id), matching the ledger's actual net balance.
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
        COALESCE(SUM(
            CASE
                WHEN ce.to_account_id = l.id THEN ce.amount
                WHEN ce.from_account_id = l.id THEN -ce.amount
            END
        ) FILTER (
            WHERE ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
        ), 0) AS amount
    FROM finances_ledgers l
    LEFT JOIN finances_transaction_entries ce
           ON (ce.to_account_id = l.id OR ce.from_account_id = l.id) AND ce.org_id = p_org_id
    WHERE l.org_id = p_org_id
      AND l.type = 'Expense'
      AND l.show_in_month_summary
    GROUP BY l.id, l.name
    ORDER BY l.name;
$$;

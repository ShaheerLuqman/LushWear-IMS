-- The COGS system ledger (system_key = 'cost_of_goods_sold') is Expense-typed
-- and show_in_month_summary defaults TRUE, so it was eligible to show up here
-- as "Less: COGS" alongside the dedicated "Less: Cost of Goods Sold" line
-- (cost_of_goods_sold field) - double-counting it in Net Profit. COGS is
-- posted via the journal (sync_month_cogs_journal), not transaction_entries,
-- and is already surfaced through its own field; exclude it here.
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
      AND l.system_key IS DISTINCT FROM 'cost_of_goods_sold'
    GROUP BY l.id, l.name
    ORDER BY l.name;
$$;

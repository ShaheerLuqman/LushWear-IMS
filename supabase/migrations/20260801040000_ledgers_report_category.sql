-- Replaces get_month_summary_totals' ledger-name substring matching with an
-- explicit ledgers.report_category column. See FINANCE_ACCOUNTING_PLAN.md §B4.
--
-- The old rules classified a ledger by what its *display name* contained:
--     position('shopify' in lower(name)) > 0  -> 'shopify'
--     position('ad'      in lower(name)) > 0  -> 'ad'
--     position('expense' in lower(type)) > 0  -> 'other'
-- 'ad' matches "Load Sheet", "Trade Supplies", "Adnan Traders", "Gadgets" and
-- anything else containing those two letters, and renaming a ledger silently
-- moved money between P&L lines. Classification now lives on the row.

ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS report_category VARCHAR(20);

ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_report_category_check;
ALTER TABLE ledgers ADD CONSTRAINT ledgers_report_category_check
    CHECK (report_category IS NULL OR report_category IN ('shopify', 'ad', 'other'));

-- Backfill reproduces the old rules *exactly*, over-broad 'ad' match included,
-- so no previously reported month's figures shift on deploy. Ledgers wrongly
-- caught by the 'ad' substring can now be corrected one at a time from the edit
-- ledger UI - which was impossible while the name was the classifier.
UPDATE ledgers SET report_category = CASE
    WHEN position('shopify' in lower(name)) > 0 THEN 'shopify'
    WHEN position('ad' in lower(name)) > 0 THEN 'ad'
    WHEN position('expense' in lower(type)) > 0 THEN 'other'
    ELSE NULL
END
WHERE report_category IS NULL;

CREATE OR REPLACE FUNCTION get_month_summary_totals(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_entry_start DATE,
    p_entry_end DATE,
    p_org_id UUID
)
RETURNS TABLE(
    total_orders INT,
    total_gross_sale NUMERIC,
    total_return_amount NUMERIC,
    return_orders_count INT,
    delivered_orders_count INT,
    enroute_orders_count INT,
    unfulfilled_orders_count INT,
    net_sales NUMERIC,
    net_profit NUMERIC,
    dc_charges_delivered NUMERIC,
    dc_charges_returned NUMERIC,
    dc_charges_total NUMERIC,
    shopify_expense NUMERIC,
    ad_expense NUMERIC,
    other_expense NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH period_orders AS (
        SELECT *
        FROM orders
        WHERE org_id = p_org_id
          AND order_receiving_date >= p_period_start
          AND order_receiving_date <  p_period_end
          AND COALESCE(lower(trim(order_status)), '') <> 'cancelled'
    ),
    order_totals AS (
        SELECT
            COUNT(*)::INT AS total_orders,
            COALESCE(SUM(total_amount), 0) AS total_gross_sale,
            COALESCE(SUM(total_amount) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS total_return_amount,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'returned')::INT AS return_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) IN ('fulfilled', 'cna', 'rfd', 'ica'))::INT AS enroute_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'unfulfilled')::INT AS unfulfilled_orders_count,
            COALESCE(SUM(total_amount) FILTER (WHERE delivery_charge IS NOT NULL), 0) AS gross_with_delivery,
            COALESCE(SUM(total_amount) FILTER (WHERE delivery_charge IS NOT NULL AND lower(trim(order_status)) = 'returned'), 0) AS return_amount_with_delivery,
            COALESCE(SUM(cost_price) FILTER (WHERE delivery_charge IS NOT NULL), 0) AS cost_with_delivery,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'delivered'), 0) AS dc_charges_delivered,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS dc_charges_returned
        FROM period_orders
    ),
    -- entry_type = 'debit' is a debit to the folio ledger, i.e. cash paid out to
    -- it - the expense direction. See "THE TWO PERSPECTIVES" in supabase_schema.sql.
    ledger_totals AS (
        SELECT
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'shopify' AND ce.entry_type = 'debit'), 0) AS shopify_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'ad'      AND ce.entry_type = 'debit'), 0) AS ad_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'other'   AND ce.entry_type = 'debit'), 0) AS other_expense
        FROM ledgers l
        JOIN cashbook_entries ce ON ce.folio = l.id
        WHERE l.org_id = p_org_id AND ce.org_id = p_org_id
          AND ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
    )
    SELECT
        ot.total_orders,
        ot.total_gross_sale,
        ot.total_return_amount,
        ot.return_orders_count,
        ot.delivered_orders_count,
        ot.enroute_orders_count,
        ot.unfulfilled_orders_count,
        (ot.total_gross_sale - ot.total_return_amount) AS net_sales,
        ((ot.gross_with_delivery - ot.return_amount_with_delivery) - ot.cost_with_delivery) AS net_profit,
        ot.dc_charges_delivered,
        ot.dc_charges_returned,
        (ot.dc_charges_delivered + ot.dc_charges_returned) AS dc_charges_total,
        lt.shopify_expense,
        lt.ad_expense,
        lt.other_expense
    FROM order_totals ot, ledger_totals lt;
$$;

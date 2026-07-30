-- Pushes get_month_summary_detail's order/ledger aggregation (backend/app/routes/orders.py)
-- into Postgres: instead of fetching every order (select "*") and every matching
-- cashbook entry for the period and summing/counting in Python, this returns the
-- computed totals directly. Mirrors the Python logic term-for-term, including the
-- (now effectively always-true, since delivery_charge/total_amount/cost_price are
-- NOT NULL) "delivery_charge IS NOT NULL" filter on the net-profit terms - kept for
-- literal parity rather than silently changing behavior if that constraint is ever
-- relaxed. products_sold_by_collection is NOT covered here: its fuzzy name-matching
-- fallback (exact -> variant-suffix-stripped -> substring, first match in product
-- list order wins) is not safely reproducible in SQL and stays in Python.
CREATE OR REPLACE FUNCTION get_month_summary_totals(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_entry_start DATE,
    p_entry_end DATE
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
        WHERE order_receiving_date >= p_period_start
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
    -- A ledger falls into at most one bucket, in this priority order - mirrors the
    -- if/elif chain in orders.py (name containing "shopify" wins over "ad", which
    -- wins over a plain Expense-type ledger; anything else is uncounted).
    ledger_buckets AS (
        SELECT
            CASE
                WHEN position('shopify' in lower(l.name)) > 0 THEN 'shopify'
                WHEN position('ad' in lower(l.name)) > 0 THEN 'ad'
                WHEN position('expense' in lower(l.type)) > 0 THEN 'other'
                ELSE NULL
            END AS bucket,
            ce.entry_type,
            ce.amount
        FROM ledgers l
        JOIN cashbook_entries ce ON ce.folio = l.id
        WHERE ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
    ),
    ledger_totals AS (
        SELECT
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'shopify' AND entry_type = 'debit'), 0) AS shopify_expense,
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'ad' AND entry_type = 'debit'), 0) AS ad_expense,
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'other' AND entry_type = 'debit'), 0) AS other_expense
        FROM ledger_buckets
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

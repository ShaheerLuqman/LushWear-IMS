-- get_month_summary_totals' net_profit disagreed with the orders grid's
-- per-row definition (computeNetProfit in orders-grid.js): it never netted
-- out tax_amount or delivery_charge for delivered orders, and subtracted
-- cost_price instead of delivery_charge for returned orders. Recomputing
-- net_profit as a straight sum of the same per-row formula the grid uses
-- makes the two agree - grid footer sums are just this same total restricted
-- to whatever subset of orders happens to be selected.
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
    cancelled_orders_count INT,
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
        FROM shopify_orders
        WHERE org_id = p_org_id
          AND order_receiving_date >= p_period_start
          AND order_receiving_date <  p_period_end
    ),
    order_totals AS (
        SELECT
            COUNT(*) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled')::INT AS total_orders,
            COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled'), 0) AS total_gross_sale,
            COALESCE(SUM(total_amount) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS total_return_amount,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'returned')::INT AS return_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) IN ('fulfilled', 'cna', 'rfd', 'ica'))::INT AS enroute_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'unfulfilled')::INT AS unfulfilled_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'cancelled')::INT AS cancelled_orders_count,
            COALESCE(SUM(
                CASE
                    WHEN lower(trim(order_status)) = 'returned' AND delivery_charge IS NOT NULL AND delivery_charge <> 0
                        THEN -delivery_charge
                    WHEN lower(trim(order_status)) = 'delivered' AND delivery_charge IS NOT NULL AND delivery_charge <> 0
                        THEN total_amount - (delivery_charge + COALESCE(tax_amount, 0) + COALESCE(cost_price, 0))
                    ELSE 0
                END
            ), 0) AS net_profit,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'delivered'), 0) AS dc_charges_delivered,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS dc_charges_returned
        FROM period_orders
    ),
    ledger_totals AS (
        SELECT
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'shopify'), 0) AS shopify_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'ad'), 0)      AS ad_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'other'), 0)   AS other_expense
        FROM finances_ledgers l
        JOIN finances_transaction_entries ce ON ce.to_account_id = l.id
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
        ot.cancelled_orders_count,
        (ot.total_gross_sale - ot.total_return_amount) AS net_sales,
        ot.net_profit,
        ot.dc_charges_delivered,
        ot.dc_charges_returned,
        (ot.dc_charges_delivered + ot.dc_charges_returned) AS dc_charges_total,
        lt.shopify_expense,
        lt.ad_expense,
        lt.other_expense
    FROM order_totals ot, ledger_totals lt;
$$;

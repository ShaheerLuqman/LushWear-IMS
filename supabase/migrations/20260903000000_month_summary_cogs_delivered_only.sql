-- Cost of Goods Sold in Month Summary now counts only delivered orders, not
-- every non-cancelled order. Goods on orders still en route, unfulfilled, or
-- returned are still in (or back in) stock, so their cost is not a cost of
-- sale. Gross Profit picks up the narrower COGS automatically.
--
-- Note this leaves Net Sales and Tax on the wider non-cancelled basis, so
-- Gross Profit still slightly overstates for orders in transit - a deliberate
-- scope choice, not an oversight.
DROP FUNCTION IF EXISTS get_month_summary_totals(TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, UUID);

CREATE FUNCTION get_month_summary_totals(
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
    cost_of_goods_sold NUMERIC,
    tax_total NUMERIC,
    gross_profit NUMERIC,
    dc_charges_delivered NUMERIC,
    dc_charges_returned NUMERIC,
    dc_charges_total NUMERIC
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
            COALESCE(SUM(cost_price) FILTER (WHERE lower(trim(order_status)) = 'delivered'), 0) AS cost_of_goods_sold,
            COALESCE(SUM(tax_amount) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled'), 0) AS tax_total,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'delivered'), 0) AS dc_charges_delivered,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS dc_charges_returned
        FROM period_orders
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
        ot.cost_of_goods_sold,
        ot.tax_total,
        (
            (ot.total_gross_sale - ot.total_return_amount)
            - ot.cost_of_goods_sold
            - (ot.dc_charges_delivered + ot.dc_charges_returned)
            - ot.tax_total
        ) AS gross_profit,
        ot.dc_charges_delivered,
        ot.dc_charges_returned,
        (ot.dc_charges_delivered + ot.dc_charges_returned) AS dc_charges_total
    FROM order_totals ot;
$$;

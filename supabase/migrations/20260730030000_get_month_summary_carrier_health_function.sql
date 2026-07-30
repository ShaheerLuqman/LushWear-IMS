-- Per-carrier delivered/total parcel counts for the Month Summary "Carrier health"
-- display (backend/app/routes/orders.py's get_month_summary_detail). Same period
-- filter as get_month_summary_totals (cancelled orders excluded); additionally
-- excludes orders with no courier assigned yet (unfulfilled orders never reached
-- a carrier, so they'd only dilute the delivered/total ratio).
CREATE OR REPLACE FUNCTION get_month_summary_carrier_health(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ
)
RETURNS TABLE(
    courier TEXT,
    delivered_count INT,
    total_count INT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        courier,
        COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_count,
        COUNT(*)::INT AS total_count
    FROM orders
    WHERE order_receiving_date >= p_period_start
      AND order_receiving_date <  p_period_end
      AND COALESCE(lower(trim(order_status)), '') <> 'cancelled'
      AND courier IS NOT NULL
      AND trim(courier) <> ''
    GROUP BY courier
    ORDER BY total_count DESC, courier ASC;
$$;

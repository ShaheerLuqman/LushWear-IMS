-- Add total_orders and completed_orders_count (delivered + returned) to
-- get_month_summary_periods so the month summary card can show completion
-- (delivered+returned)/total instead of just the warning count.
DROP FUNCTION IF EXISTS get_month_summary_periods(UUID);

CREATE FUNCTION get_month_summary_periods(p_org_id UUID)
RETURNS TABLE(month INT, year INT, warning_orders_count INT, total_orders INT, completed_orders_count INT)
LANGUAGE sql
STABLE
AS $$
    WITH local_dates AS (
        SELECT
            EXTRACT(DAY FROM local_ts)::INT   AS day,
            EXTRACT(MONTH FROM local_ts)::INT AS mon,
            EXTRACT(YEAR FROM local_ts)::INT  AS yr,
            order_status,
            delivery_charge,
            piece_received,
            COALESCE(o.fiscal_month_start_day, 22) AS start_day
        FROM (
            SELECT order_receiving_date AT TIME ZONE INTERVAL '+05:00' AS local_ts,
                   order_status, delivery_charge, piece_received
            FROM shopify_orders
            WHERE org_id = p_org_id
        ) t
        LEFT JOIN system_organizations o ON o.id = p_org_id
    ),
    bucketed AS (
        SELECT
            CASE WHEN day < start_day THEN (CASE WHEN mon = 1 THEN 12 ELSE mon - 1 END) ELSE mon END AS month,
            CASE WHEN day < start_day AND mon = 1 THEN yr - 1 ELSE yr END AS year,
            order_status,
            delivery_charge,
            piece_received
        FROM local_dates
    )
    SELECT
        month,
        year,
        COUNT(*) FILTER (
            WHERE lower(trim(order_status)) <> 'cancelled'
              AND NOT (
                    (lower(trim(order_status)) = 'delivered' AND delivery_charge > 0)
                 OR (lower(trim(order_status)) = 'returned' AND delivery_charge > 0 AND piece_received = 'Received')
              )
        )::INT AS warning_orders_count,
        COUNT(*) FILTER (WHERE lower(trim(order_status)) <> 'cancelled')::INT AS total_orders,
        COUNT(*) FILTER (WHERE lower(trim(order_status)) IN ('delivered', 'returned'))::INT AS completed_orders_count
    FROM bucketed
    GROUP BY month, year
    ORDER BY year DESC, month DESC;
$$;

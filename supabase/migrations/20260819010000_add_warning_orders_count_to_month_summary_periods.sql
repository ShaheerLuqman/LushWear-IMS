-- Adds warning_orders_count to get_month_summary_periods so the Month Summary
-- front page can show, on each month's card, how many of that period's orders
-- are in "Warning" status - mirrors the Orders grid's final_status column
-- (orders-columns.js): cancelled orders are excluded entirely, an order is
-- "OK" only if delivered with delivery_charge > 0, or returned with
-- delivery_charge > 0 and piece_received = 'Received'; everything else
-- (non-cancelled) counts as Warning.
-- Adding a column changes the OUT-parameter row type, which CREATE OR REPLACE
-- cannot do for an existing function of the same argument signature - drop it first.
DROP FUNCTION IF EXISTS get_month_summary_periods(UUID);

CREATE OR REPLACE FUNCTION get_month_summary_periods(p_org_id UUID)
RETURNS TABLE(month INT, year INT, warning_orders_count INT)
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
            piece_received
        FROM (
            SELECT order_receiving_date AT TIME ZONE INTERVAL '+05:00' AS local_ts,
                   order_status, delivery_charge, piece_received
            FROM shopify_orders
            WHERE org_id = p_org_id
        ) t
    ),
    bucketed AS (
        SELECT
            CASE WHEN day < 22 THEN (CASE WHEN mon = 1 THEN 12 ELSE mon - 1 END) ELSE mon END AS month,
            CASE WHEN day < 22 AND mon = 1 THEN yr - 1 ELSE yr END AS year,
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
        )::INT AS warning_orders_count
    FROM bucketed
    GROUP BY month, year
    ORDER BY year DESC, month DESC;
$$;

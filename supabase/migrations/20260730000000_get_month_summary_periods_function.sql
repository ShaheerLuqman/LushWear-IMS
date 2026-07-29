-- Pushes get_month_summary_list's bucketing (backend/app/routes/orders.py) into
-- Postgres: instead of fetching order_receiving_date for every order and grouping
-- in Python, this returns the distinct (month, year) reporting periods directly.
-- Period = a month's 22nd through the next month's 21st, in PKT (fixed UTC+5, no
-- DST) - mirrors _period_start_end's day-based rollback logic in orders.py.
-- order_receiving_date is NOT NULL (see supabase_schema.sql), so no created_at
-- fallback is needed here, unlike the Python version this replaces.
CREATE OR REPLACE FUNCTION get_month_summary_periods()
RETURNS TABLE(month INT, year INT)
LANGUAGE sql
STABLE
AS $$
    WITH local_dates AS (
        SELECT
            EXTRACT(DAY FROM local_ts)::INT   AS day,
            EXTRACT(MONTH FROM local_ts)::INT AS mon,
            EXTRACT(YEAR FROM local_ts)::INT  AS yr
        FROM (
            SELECT order_receiving_date AT TIME ZONE INTERVAL '+05:00' AS local_ts
            FROM orders
        ) t
    )
    SELECT DISTINCT
        CASE WHEN day < 22 THEN (CASE WHEN mon = 1 THEN 12 ELSE mon - 1 END) ELSE mon END AS month,
        CASE WHEN day < 22 AND mon = 1 THEN yr - 1 ELSE yr END AS year
    FROM local_dates
    ORDER BY year DESC, month DESC;
$$;

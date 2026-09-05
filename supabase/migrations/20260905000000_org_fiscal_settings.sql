-- Org-configurable fiscal calendar (Financial Settings): which day of the month a
-- "financial month" starts, and which calendar month the organization's financial
-- year starts in. Defaults match the previously hardcoded 22nd-to-21st cycle used
-- throughout get_month_summary_periods()/backend/app/routes/orders.py's
-- _period_start_end(), so every existing org's month-summary periods are
-- unaffected until an admin changes these in Settings.
-- fiscal_month_start_day is capped at 28 so it exists in every month, including
-- February. fiscal_year_start_month isn't consumed by any report yet (see
-- FINANCE_ACCOUNTING_PLAN.md's "no financial year" gap) - it's stored now so
-- that work has an org-level setting to read once it lands.
ALTER TABLE system_organizations
    ADD COLUMN IF NOT EXISTS fiscal_month_start_day INT NOT NULL DEFAULT 22
        CHECK (fiscal_month_start_day BETWEEN 1 AND 28),
    ADD COLUMN IF NOT EXISTS fiscal_year_start_month INT NOT NULL DEFAULT 1
        CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

-- Same return shape as before (month, year, warning_orders_count) - only the day
-- threshold used to bucket orders into periods changes, from a hardcoded 22 to
-- each org's own fiscal_month_start_day. CREATE OR REPLACE can't be used across
-- a DROP-then-CREATE-FUNCTION pair with an unchanged signature either, so this
-- mirrors the drop-then-create style of the migration that last touched it.
DROP FUNCTION IF EXISTS get_month_summary_periods(UUID);

CREATE FUNCTION get_month_summary_periods(p_org_id UUID)
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
        )::INT AS warning_orders_count
    FROM bucketed
    GROUP BY month, year
    ORDER BY year DESC, month DESC;
$$;

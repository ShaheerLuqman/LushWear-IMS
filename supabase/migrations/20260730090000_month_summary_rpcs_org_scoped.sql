-- Org-scoping cutover, part 3 (ORGANIZATIONS_USERS_PLAN.md Phase 2). Adds
-- p_org_id to the 3 month-summary RPCs so they only ever aggregate one org's
-- orders/ledgers/cashbook_entries - without this they'd silently sum every
-- org's data into one shared month summary. Depends on 20260730070000
-- (org_id must already exist on orders/ledgers/cashbook_entries).
--
-- Postgres identifies functions by name + argument types, so each of these 3
-- CREATE OR REPLACE calls (different arg list than before) would otherwise
-- create a second overload rather than replacing the old one - drop the old
-- signatures explicitly first.
DROP FUNCTION IF EXISTS get_month_summary_periods();
DROP FUNCTION IF EXISTS get_month_summary_totals(TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE);
DROP FUNCTION IF EXISTS get_month_summary_carrier_health(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION get_month_summary_periods(p_org_id UUID)
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
            WHERE org_id = p_org_id
        ) t
    )
    SELECT DISTINCT
        CASE WHEN day < 22 THEN (CASE WHEN mon = 1 THEN 12 ELSE mon - 1 END) ELSE mon END AS month,
        CASE WHEN day < 22 AND mon = 1 THEN yr - 1 ELSE yr END AS year
    FROM local_dates
    ORDER BY year DESC, month DESC;
$$;

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
        WHERE l.org_id = p_org_id AND ce.org_id = p_org_id
          AND ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
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

CREATE OR REPLACE FUNCTION get_month_summary_carrier_health(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_org_id UUID
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
    WHERE org_id = p_org_id
      AND order_receiving_date >= p_period_start
      AND order_receiving_date <  p_period_end
      AND COALESCE(lower(trim(order_status)), '') <> 'cancelled'
      AND courier IS NOT NULL
      AND trim(courier) <> ''
    GROUP BY courier
    ORDER BY total_count DESC, courier ASC;
$$;

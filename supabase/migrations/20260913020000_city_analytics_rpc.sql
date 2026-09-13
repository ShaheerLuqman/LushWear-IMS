-- City Analytics RPC: per-city units & revenue over a date range plus the
-- equal-length window immediately before it, distinct order/product counts
-- per city, and a per-city product breakdown - all from
-- shopify_orders.line_items in one round trip. Same basis and product
-- resolution (variant_id -> product_id -> name) as get_product_analytics,
-- so the two screens never disagree on how a line maps to a product.

DROP FUNCTION IF EXISTS get_city_analytics(UUID, DATE, DATE, DATE, DATE);

CREATE FUNCTION get_city_analytics(
    p_org_id UUID,
    p_start DATE,
    p_end DATE,
    p_prev_start DATE,
    p_prev_end DATE
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    WITH lines AS (
        SELECT
            o.id AS order_id,
            COALESCE(NULLIF(btrim(o.customer_city), ''), 'Unknown') AS city,
            CASE
                WHEN o.order_receiving_date >= p_start::timestamptz
                     AND o.order_receiving_date < (p_end + 1)::timestamptz
                    THEN 'current'
                WHEN p_prev_start IS NOT NULL
                     AND o.order_receiving_date >= p_prev_start::timestamptz
                     AND o.order_receiving_date < (p_prev_end + 1)::timestamptz
                    THEN 'previous'
            END AS phase,
            NULLIF(btrim(e.item ->> 'name'), '') AS item_name,
            COALESCE(
                (SELECT v.product_id FROM shopify_variants v
                 WHERE v.org_id = p_org_id AND v.id = NULLIF(e.item ->> 'variant_id', '')::uuid),
                NULLIF(e.item ->> 'product_id', '')::uuid
            ) AS product_id,
            GREATEST(COALESCE((e.item ->> 'qty')::numeric, 0), 0) AS qty,
            COALESCE((e.item ->> 'unit_price')::numeric, 0) AS unit_price
        FROM shopify_orders o
        CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS e(item)
        WHERE o.org_id = p_org_id
          AND lower(btrim(o.order_status)) <> 'cancelled'
          AND o.replacement_of_order_no IS NULL
          AND o.line_items <> '[]'::jsonb
          AND o.order_receiving_date >= COALESCE(p_prev_start, p_start)::timestamptz
          AND o.order_receiving_date < (p_end + 1)::timestamptz
    ),
    kept AS (
        SELECT
            l.*,
            COALESCE(l.product_id::text, 'name:' || lower(COALESCE(l.item_name, ''))) AS gk
        FROM lines l
        WHERE l.phase IS NOT NULL AND l.qty > 0
    ),
    city_totals AS (
        SELECT
            phase, city,
            SUM(qty)::bigint AS units,
            SUM(qty * unit_price)::numeric AS revenue,
            COUNT(DISTINCT order_id) AS order_count,
            COUNT(DISTINCT gk) AS product_count
        FROM kept
        GROUP BY phase, city
    ),
    city_prod AS (
        SELECT
            phase, city, gk,
            MAX(product_id::text)::uuid AS product_id,
            MIN(item_name) AS item_name,
            SUM(qty)::bigint AS units,
            SUM(qty * unit_price)::numeric AS revenue
        FROM kept
        GROUP BY phase, city, gk
    )
    SELECT jsonb_build_object(
        'cities', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'phase', phase, 'city', city, 'units', units, 'revenue', revenue,
                'orders', order_count, 'products', product_count
            ))
            FROM city_totals
        ), '[]'::jsonb),
        'city_products', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'phase', phase, 'city', city, 'product_id', product_id,
                'item_name', item_name, 'units', units, 'revenue', revenue
            ))
            FROM city_prod
        ), '[]'::jsonb)
    );
$$;

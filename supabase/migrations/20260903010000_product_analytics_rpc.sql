-- Product Analytics RPC: per-product units & revenue over a date range plus the
-- equal-length window immediately before it, a size (variant) breakdown, distinct
-- order counts per collection, and a bucketed sales trend - all from
-- shopify_orders.line_items in one round trip, so the page no longer pages the
-- whole orders list into the browser to aggregate client-side.
--
-- Basis: non-cancelled, non-replacement orders, filtered on
-- (order_receiving_date AT TIME ZONE 'UTC')::date to match the old client-side
-- filter. A line is attributed to a product by its variant_id, then product_id;
-- lines that resolve to neither are grouped by lowercased name and returned with
-- product_id = null for the route to name-match against the catalog.

DROP FUNCTION IF EXISTS get_product_analytics(UUID, DATE, DATE, DATE, DATE, TEXT);

CREATE FUNCTION get_product_analytics(
    p_org_id UUID,
    p_start DATE,
    p_end DATE,
    p_prev_start DATE,
    p_prev_end DATE,
    p_grain TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    WITH lines AS (
        SELECT
            o.id AS order_id,
            (o.order_receiving_date AT TIME ZONE 'UTC')::date AS d,
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
            COALESCE((e.item ->> 'unit_price')::numeric, 0) AS unit_price,
            CASE
                WHEN upper(btrim(COALESCE(e.item ->> 'variant_title', '')))
                     IN ('', '-', 'DEFAULT TITLE', 'DEFAULT') THEN 'OS'
                ELSE upper(btrim(e.item ->> 'variant_title'))
            END AS size
        FROM shopify_orders o
        CROSS JOIN LATERAL jsonb_array_elements(o.line_items) AS e(item)
        WHERE o.org_id = p_org_id
          AND lower(btrim(o.order_status)) <> 'cancelled'
          AND o.replacement_of_order_no IS NULL
          AND o.line_items <> '[]'::jsonb
          -- one contiguous range covering both windows (prev ends the day before
          -- start), kept as a raw timestamptz comparison so idx_orders_order_receiving_date
          -- is usable - the phase CASE above splits the rows.
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
    prod_size AS (
        SELECT phase, gk, size, SUM(qty)::bigint AS u
        FROM kept GROUP BY phase, gk, size
    ),
    prod AS (
        SELECT
            k.phase,
            k.gk,
            MAX(k.product_id::text)::uuid AS product_id,
            MIN(k.item_name) AS item_name,
            SUM(k.qty)::bigint AS units,
            SUM(k.qty * k.unit_price)::numeric AS revenue
        FROM kept k
        GROUP BY k.phase, k.gk
    ),
    order_coll AS (
        SELECT DISTINCT
            k.phase,
            k.order_id,
            COALESCE(NULLIF(btrim(sp.collection), ''), 'Uncategorized') AS collection
        FROM kept k
        LEFT JOIN shopify_products sp ON sp.org_id = p_org_id AND sp.id = k.product_id
    ),
    trend AS (
        SELECT
            k.phase,
            date_trunc(
                CASE WHEN p_grain IN ('day', 'week', 'month') THEN p_grain ELSE 'day' END,
                k.d::timestamp
            )::date AS bucket,
            COALESCE(NULLIF(btrim(sp.collection), ''), 'Uncategorized') AS collection,
            SUM(k.qty)::numeric AS units,
            SUM(k.qty * k.unit_price)::numeric AS revenue
        FROM kept k
        LEFT JOIN shopify_products sp ON sp.org_id = p_org_id AND sp.id = k.product_id
        GROUP BY 1, 2, 3
    )
    SELECT jsonb_build_object(
        'products', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'phase', p.phase,
                'product_id', p.product_id,
                'item_name', p.item_name,
                'units', p.units,
                'revenue', p.revenue,
                'sizes', COALESCE((
                    SELECT jsonb_object_agg(ps.size, ps.u)
                    FROM prod_size ps WHERE ps.phase = p.phase AND ps.gk = p.gk
                ), '{}'::jsonb)
            ))
            FROM prod p
        ), '[]'::jsonb),
        'orders', COALESCE((
            SELECT jsonb_agg(x) FROM (
                SELECT jsonb_build_object(
                    'phase', phase, 'collection', collection, 'order_count', COUNT(*)
                ) AS x
                FROM order_coll GROUP BY phase, collection
                UNION ALL
                SELECT jsonb_build_object(
                    'phase', phase, 'collection', '__all__', 'order_count', COUNT(DISTINCT order_id)
                )
                FROM order_coll GROUP BY phase
            ) t
        ), '[]'::jsonb),
        'trend', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'phase', phase, 'bucket', bucket, 'collection', collection,
                'units', units, 'revenue', revenue
            ))
            FROM trend
        ), '[]'::jsonb)
    );
$$;

-- Inventory screen: cost history, manual stock adjustments, and the daily
-- snapshot the stat cards' month-over-month deltas are measured against.

-- Every cost change made from the Inventory screen, so "View History" can show
-- who changed a cost, when, from what, and why. Purchase-bill-driven cost
-- changes already have their own audit trail (finances_bills.cost_price_snapshot)
-- and are not duplicated here.
CREATE TABLE IF NOT EXISTS shopify_product_cost_history (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES system_organizations(id),
    product_id     UUID NOT NULL REFERENCES shopify_products(id) ON DELETE CASCADE,
    -- NULL when the cost landed on the product itself (a variant-less product,
    -- or a product-level bulk update that cascaded onto its variants).
    variant_id     UUID REFERENCES shopify_variants(id) ON DELETE CASCADE,
    old_cost_price DECIMAL(10, 2),
    new_cost_price DECIMAL(10, 2),
    -- Date the new cost is meant to apply from. Defaults to the change date;
    -- the Update Cost modal lets it be backdated for a price that took effect earlier.
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    reason         TEXT,
    -- No FK: a user row can be deleted while the history it wrote must survive.
    changed_by     UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Manual stock corrections made from the Inventory screen (Adjust Stock).
-- Stock otherwise moves only via Shopify sync or a received purchase bill,
-- neither of which writes here.
CREATE TABLE IF NOT EXISTS shopify_stock_adjustments (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id           UUID NOT NULL REFERENCES system_organizations(id),
    product_id       UUID NOT NULL REFERENCES shopify_products(id) ON DELETE CASCADE,
    variant_id       UUID NOT NULL REFERENCES shopify_variants(id) ON DELETE CASCADE,
    -- Signed: positive adds stock, negative removes it. The Add/Remove choice in
    -- the modal is the sign, so a reversal is just the negated row.
    delta            INTEGER NOT NULL,
    quantity_before  INTEGER NOT NULL,
    quantity_after   INTEGER NOT NULL,
    reason           TEXT NOT NULL,
    notes            TEXT,
    changed_by       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per org per day, written opportunistically whenever the Inventory
-- screen asks for its summary. There is no scheduler in this deployment, so the
-- page view itself is what captures history; deltas stay null until a snapshot
-- a month old exists.
CREATE TABLE IF NOT EXISTS shopify_inventory_snapshots (
    id                 UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id             UUID NOT NULL REFERENCES system_organizations(id),
    snapshot_date      DATE NOT NULL,
    total_products     INTEGER NOT NULL,
    total_stock        BIGINT NOT NULL,
    low_stock_count    INTEGER NOT NULL,
    out_of_stock_count INTEGER NOT NULL,
    inventory_value    DECIMAL(14, 2) NOT NULL,
    captured_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, snapshot_date)
);

ALTER TABLE shopify_product_cost_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_stock_adjustments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_inventory_snapshots   ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_cost_history_product     ON shopify_product_cost_history(org_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adjust_product     ON shopify_stock_adjustments(org_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_date ON shopify_inventory_snapshots(org_id, snapshot_date DESC);


-- Computes the five Inventory stat-card figures, records them as today's
-- snapshot, and returns them alongside the newest snapshot at least a month old
-- (null until one exists) so the route can derive the deltas. Aggregating here
-- keeps the whole catalog out of the API process just to sum it.
CREATE OR REPLACE FUNCTION capture_inventory_snapshot(p_org_id UUID, p_low_stock_threshold INT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_current  JSONB;
    v_previous JSONB;
BEGIN
    WITH product_stock AS (
        SELECT p.id,
               COALESCE(SUM(v.quantity), 0) AS qty,
               COALESCE(SUM(v.quantity * COALESCE(v.cost_price, p.cost_price, 0)), 0) AS value
          FROM shopify_products p
          LEFT JOIN shopify_variants v ON v.product_id = p.id AND v.org_id = p.org_id
         WHERE p.org_id = p_org_id AND p.is_active
         GROUP BY p.id
    )
    SELECT jsonb_build_object(
        'total_products',     COUNT(*),
        'total_stock',        COALESCE(SUM(qty), 0),
        'low_stock_count',    COUNT(*) FILTER (WHERE qty > 0 AND qty < p_low_stock_threshold),
        'out_of_stock_count', COUNT(*) FILTER (WHERE qty = 0),
        'inventory_value',    ROUND(COALESCE(SUM(value), 0), 2)
    ) INTO v_current
      FROM product_stock;

    INSERT INTO shopify_inventory_snapshots (
        org_id, snapshot_date, total_products, total_stock,
        low_stock_count, out_of_stock_count, inventory_value
    ) VALUES (
        p_org_id, CURRENT_DATE,
        (v_current ->> 'total_products')::INT,
        (v_current ->> 'total_stock')::BIGINT,
        (v_current ->> 'low_stock_count')::INT,
        (v_current ->> 'out_of_stock_count')::INT,
        (v_current ->> 'inventory_value')::NUMERIC
    )
    ON CONFLICT (org_id, snapshot_date) DO UPDATE SET
        total_products     = EXCLUDED.total_products,
        total_stock        = EXCLUDED.total_stock,
        low_stock_count    = EXCLUDED.low_stock_count,
        out_of_stock_count = EXCLUDED.out_of_stock_count,
        inventory_value    = EXCLUDED.inventory_value,
        captured_at        = NOW();

    SELECT jsonb_build_object(
        'snapshot_date',      s.snapshot_date,
        'total_products',     s.total_products,
        'total_stock',        s.total_stock,
        'low_stock_count',    s.low_stock_count,
        'out_of_stock_count', s.out_of_stock_count,
        'inventory_value',    s.inventory_value
    ) INTO v_previous
      FROM shopify_inventory_snapshots s
     WHERE s.org_id = p_org_id
       AND s.snapshot_date <= (CURRENT_DATE - INTERVAL '1 month')::date
     ORDER BY s.snapshot_date DESC
     LIMIT 1;

    RETURN jsonb_build_object('current', v_current, 'previous', v_previous);
END;
$$;

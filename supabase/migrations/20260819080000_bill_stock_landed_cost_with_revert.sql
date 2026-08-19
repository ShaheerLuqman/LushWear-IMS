-- Receiving a bill now lands each referenced product's cost_price: the
-- quantity-weighted average of its own line(s) unit cost on this bill, plus
-- an even share of the bill's tax/other-expense/discount spread across the
-- whole bill's quantity (the same figure the bill modal previews live before
-- it's confirmed - see updateCostEffects() in bills.js). Each product's price
-- beforehand is snapshotted onto the bill first, so un-receiving restores it
-- exactly rather than leaving it at whatever this bill set it to.
ALTER TABLE finances_bills ADD COLUMN IF NOT EXISTS cost_price_snapshot JSONB;

COMMENT ON COLUMN finances_bills.cost_price_snapshot IS
    '{product_id: cost_price} as it stood immediately before receive_bill last overwrote it. Set on receive, cleared on unreceive.';

CREATE OR REPLACE FUNCTION apply_bill_stock(p_bill_id UUID, p_sign INT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_total_qty NUMERIC;
    v_extra     NUMERIC := 0;
BEGIN
    -- variants.quantity is INTEGER while a bill line can be fractional (fabric
    -- by the metre), so the movement is rounded to whole units.
    UPDATE shopify_variants v
       SET quantity   = v.quantity + (p_sign * ROUND(agg.qty))::INT,
           updated_at = NOW()
      FROM (
          SELECT variant_id, SUM(quantity) AS qty
            FROM finances_bill_items
           WHERE bill_id = p_bill_id AND variant_id IS NOT NULL
           GROUP BY variant_id
      ) agg
     WHERE v.id = agg.variant_id;

    IF p_sign > 0 THEN
        SELECT COALESCE(SUM(quantity), 0) INTO v_total_qty
          FROM finances_bill_items WHERE bill_id = p_bill_id;

        IF v_total_qty > 0 THEN
            SELECT (b.tax_amount + b.other_expense_amount - b.discount_amount) / v_total_qty
              INTO v_extra
              FROM finances_bills b WHERE b.id = p_bill_id;
        END IF;

        -- Snapshot each affected product's price before changing it so
        -- unreceive_bill (p_sign < 0) can put it back exactly.
        UPDATE finances_bills
           SET cost_price_snapshot = (
                   SELECT jsonb_object_agg(p.id::text, p.cost_price)
                     FROM shopify_products p
                    WHERE p.id IN (
                        SELECT DISTINCT product_id FROM finances_bill_items
                         WHERE bill_id = p_bill_id AND product_id IS NOT NULL
                    )
               )
         WHERE id = p_bill_id;

        UPDATE shopify_products p
           SET cost_price = ROUND(agg.avg_cost + v_extra, 2),
               updated_at = NOW()
          FROM (
              SELECT product_id, SUM(quantity * unit_cost) / SUM(quantity) AS avg_cost
                FROM finances_bill_items
               WHERE bill_id = p_bill_id AND product_id IS NOT NULL AND quantity > 0
               GROUP BY product_id
          ) agg
         WHERE p.id = agg.product_id;

    ELSIF p_sign < 0 THEN
        UPDATE shopify_products p
           SET cost_price = (snap.value #>> '{}')::NUMERIC,
               updated_at = NOW()
          FROM (
              SELECT kv.key AS product_id, kv.value
                FROM (SELECT cost_price_snapshot FROM finances_bills WHERE id = p_bill_id) b,
                     jsonb_each(COALESCE(b.cost_price_snapshot, '{}'::jsonb)) kv
          ) snap
         WHERE p.id = snap.product_id::UUID;

        UPDATE finances_bills SET cost_price_snapshot = NULL WHERE id = p_bill_id;
    END IF;
END;
$$;

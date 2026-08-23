-- Cost tracking moves to variant level. shopify_products.cost_price stays -
-- it's still the cost for a variant-less product, and the fallback/prefill
-- used when a specific variant has no cost of its own yet - but a product
-- with variants now lands its purchase cost on each variant individually
-- instead of blending every variant into one product-wide average.

ALTER TABLE shopify_variants ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10, 2);

COMMENT ON COLUMN shopify_variants.cost_price IS
    'Cost price for this specific variant. NULL until set (via a received purchase bill or the Products page) - falls back to the product''s own cost_price until then.';

COMMENT ON COLUMN shopify_products.cost_price IS
    'Cost price for a variant-less product, and the fallback/prefill for a variant with no cost_price of its own yet. No longer "same across variants" once a product has variants with their own costs.';

-- Variant-level sibling of finances_bills.cost_price_snapshot: {variant_id:
-- cost_price} as it stood immediately before receive_bill last overwrote it,
-- so unreceive_bill can put a variant's price back exactly. Set on receive,
-- cleared on unreceive.
ALTER TABLE finances_bills ADD COLUMN IF NOT EXISTS variant_cost_price_snapshot JSONB;

COMMENT ON COLUMN finances_bills.variant_cost_price_snapshot IS
    '{variant_id: cost_price} as it stood immediately before receive_bill last overwrote it - the variant-level sibling of cost_price_snapshot, for bill items that reference a variant. Set on receive, cleared on unreceive.';

-- Adds (p_sign = 1) or removes (p_sign = -1) this bill's stock.
--
-- Receiving also lands cost_price: a bill item WITH a variant_id lands the
-- quantity-weighted average of its own line(s) unit cost on that variant
-- (shopify_variants.cost_price); an item with no variant_id (a variant-less
-- product, or one deactivated since the line was set) still lands on the
-- product itself (shopify_products.cost_price), as it always did. Either way
-- it's plus an even share of the bill's tax/other-expense/discount spread
-- across the whole bill's quantity (the same figure the bill modal previews
-- live before it's confirmed). Each price beforehand is snapshotted onto the
-- bill first, so un-receiving restores it exactly rather than leaving it at
-- whatever this bill set it to.
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

        -- Snapshot affected prices before changing them so unreceive_bill
        -- (p_sign < 0) can put them back exactly. Variant-less lines snapshot
        -- their product; variant lines snapshot their variant.
        UPDATE finances_bills
           SET cost_price_snapshot = (
                   SELECT jsonb_object_agg(p.id::text, p.cost_price)
                     FROM shopify_products p
                    WHERE p.id IN (
                        SELECT DISTINCT product_id FROM finances_bill_items
                         WHERE bill_id = p_bill_id AND product_id IS NOT NULL AND variant_id IS NULL
                    )
               ),
               variant_cost_price_snapshot = (
                   SELECT jsonb_object_agg(v.id::text, v.cost_price)
                     FROM shopify_variants v
                    WHERE v.id IN (
                        SELECT DISTINCT variant_id FROM finances_bill_items
                         WHERE bill_id = p_bill_id AND variant_id IS NOT NULL
                    )
               )
         WHERE id = p_bill_id;

        -- Variant lines land on their own variant - two variants of the same
        -- product bought at different prices no longer get blended together.
        UPDATE shopify_variants v
           SET cost_price = ROUND(agg.avg_cost + v_extra, 2),
               updated_at = NOW()
          FROM (
              SELECT variant_id, SUM(quantity * unit_cost) / SUM(quantity) AS avg_cost
                FROM finances_bill_items
               WHERE bill_id = p_bill_id AND variant_id IS NOT NULL AND quantity > 0
               GROUP BY variant_id
          ) agg
         WHERE v.id = agg.variant_id;

        -- Variant-less lines still land on the product, same as before.
        UPDATE shopify_products p
           SET cost_price = ROUND(agg.avg_cost + v_extra, 2),
               updated_at = NOW()
          FROM (
              SELECT product_id, SUM(quantity * unit_cost) / SUM(quantity) AS avg_cost
                FROM finances_bill_items
               WHERE bill_id = p_bill_id AND product_id IS NOT NULL AND variant_id IS NULL AND quantity > 0
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

        UPDATE shopify_variants v
           SET cost_price = (snap.value #>> '{}')::NUMERIC,
               updated_at = NOW()
          FROM (
              SELECT kv.key AS variant_id, kv.value
                FROM (SELECT variant_cost_price_snapshot FROM finances_bills WHERE id = p_bill_id) b,
                     jsonb_each(COALESCE(b.variant_cost_price_snapshot, '{}'::jsonb)) kv
          ) snap
         WHERE v.id = snap.variant_id::UUID;

        UPDATE finances_bills
           SET cost_price_snapshot = NULL, variant_cost_price_snapshot = NULL
         WHERE id = p_bill_id;
    END IF;
END;
$$;

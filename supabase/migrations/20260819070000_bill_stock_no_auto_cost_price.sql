-- A product's cost_price is now set explicitly when a draft bill referencing
-- it is saved (the frontend computes it landed - unit cost plus the bill's
-- tax/other-expense/discount spread evenly across its total quantity - and
-- shows the change before saving). apply_bill_stock no longer overwrites it
-- at receive time with the unadjusted raw unit_cost of the latest line.
CREATE OR REPLACE FUNCTION apply_bill_stock(p_bill_id UUID, p_sign INT)
RETURNS void
LANGUAGE plpgsql
AS $$
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
END;
$$;

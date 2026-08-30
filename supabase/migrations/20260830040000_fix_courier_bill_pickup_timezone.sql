-- assign_courier_bills bucketed pickups by `courier_pickup_date AT TIME ZONE '+05'`, which
-- shifts the wrong way: applied to a timestamptz, a bare '+05' is read with POSIX's
-- inverted sign convention, so it subtracted five hours instead of adding them. Every
-- parcel picked up after 19:00 UTC (midnight-to-5am PKT) landed on the previous day's bill
-- - 380 of 8635 orders on the first backfill.
--
-- Redefines the function with 'Asia/Karachi' and re-runs assignment for every org, which
-- moves those orders onto the correct bill and drops any open bill left empty. Bills marked
-- settled are still protected: assign_courier_bills refuses to move orders out of them, so
-- a wrongly-dated bill already settled keeps its contents and is reported in `blocked`
-- rather than silently rewritten.

CREATE OR REPLACE FUNCTION assign_courier_bills(
    p_org_id UUID,
    p_order_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(assigned INTEGER, blocked UUID[])
LANGUAGE plpgsql
AS $$
DECLARE
    v_assigned INTEGER := 0;
    v_blocked UUID[];
BEGIN
    CREATE TEMP TABLE IF NOT EXISTS _candidates (
        id UUID,
        courier VARCHAR(100),
        pickup_date DATE,
        current_bill_id UUID
    ) ON COMMIT DROP;
    TRUNCATE _candidates;

    INSERT INTO _candidates (id, courier, pickup_date, current_bill_id)
    SELECT o.id,
           COALESCE(NULLIF(BTRIM(o.courier), ''), 'Unknown'),
           (o.courier_pickup_date AT TIME ZONE 'Asia/Karachi')::DATE,
           o.courier_bill_id
      FROM shopify_orders o
     WHERE o.org_id = p_org_id
       AND o.courier_pickup_date IS NOT NULL
       AND (p_order_ids IS NULL OR o.id = ANY(p_order_ids));

    DELETE FROM _candidates c
     USING shopify_courier_bills b
     WHERE b.id = c.current_bill_id
       AND b.courier = c.courier
       AND b.pickup_date = c.pickup_date;

    SELECT COALESCE(ARRAY_AGG(c.id), '{}')
      INTO v_blocked
      FROM _candidates c
      JOIN shopify_courier_bills b ON b.id = c.current_bill_id
     WHERE b.status = 'settled';

    DELETE FROM _candidates c
     USING shopify_courier_bills b
     WHERE b.id = c.current_bill_id
       AND b.status = 'settled';

    INSERT INTO shopify_courier_bills (org_id, courier, pickup_date)
    SELECT DISTINCT p_org_id, c.courier, c.pickup_date FROM _candidates c
    ON CONFLICT (org_id, courier, pickup_date) DO NOTHING;

    WITH updated AS (
        UPDATE shopify_orders o
           SET courier_bill_id = b.id,
               updated_at = NOW()
          FROM _candidates c
          JOIN shopify_courier_bills b
            ON b.org_id = p_org_id
           AND b.courier = c.courier
           AND b.pickup_date = c.pickup_date
         WHERE o.id = c.id
           AND o.org_id = p_org_id
        RETURNING o.id
    )
    SELECT COUNT(*)::INTEGER INTO v_assigned FROM updated;

    DELETE FROM shopify_courier_bills b
     WHERE b.org_id = p_org_id
       AND b.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM shopify_orders o WHERE o.courier_bill_id = b.id);

    RETURN QUERY SELECT v_assigned, COALESCE(v_blocked, '{}');
END;
$$;

DO $$
DECLARE
    v_org UUID;
BEGIN
    FOR v_org IN SELECT id FROM system_organizations LOOP
        PERFORM assign_courier_bills(v_org, NULL);
    END LOOP;
END;
$$;

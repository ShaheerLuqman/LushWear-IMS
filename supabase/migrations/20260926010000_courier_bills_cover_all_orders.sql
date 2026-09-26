-- Every dispatched order belongs to a courier bill, not only the ones a tracking
-- API has given a pickup date.
--
-- Until now membership required courier_pickup_date, which only PostEx and
-- Couriers Next report, so SCS/FedEx/"Other"/unassigned-courier parcels sat on
-- no bill: absent from the Courier Payment Report and, since sales post per
-- bill (20260910040000_post_by_courier_bill.sql), never posted as revenue.
--
-- Two changes to how an order is grouped:
--
-- 1. Date: COALESCE(courier_pickup_date, fulfilled_at, order_receiving_date) -
--    the dispatch-date fallback post_courier_payout_journal already uses, plus
--    the order date for parcels fulfilled outside the app, which have neither.
--    Any shipped status qualifies; unfulfilled/cancelled orders with no pickup
--    date are still left out (they have not gone anywhere).
-- 2. Courier: an order keeps its own courier's bill only if that courier is
--    enabled in Settings > Couriers. Everything else shares one 'Other' bill per
--    date, which resolve_courier_ledger already maps to Courier Receivables -
--    Other. Enablement lives in the encrypted couriers blob, so the caller
--    passes the enabled names (lowercased) as p_couriers.
--
-- No backfill here for the same reason: the app regroups the whole org when a
-- courier is toggled in Settings (app/couriers.py), which is also how to apply
-- this to existing orders.
DROP FUNCTION IF EXISTS assign_courier_bills(UUID, UUID[]);

CREATE OR REPLACE FUNCTION assign_courier_bills(
    p_org_id UUID,
    p_order_ids UUID[],
    p_couriers TEXT[]
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
           CASE WHEN LOWER(BTRIM(o.courier)) = ANY(p_couriers) THEN BTRIM(o.courier) ELSE 'Other' END,
           (COALESCE(o.courier_pickup_date, o.fulfilled_at, o.order_receiving_date) AT TIME ZONE 'Asia/Karachi')::DATE,
           o.courier_bill_id
      FROM shopify_orders o
     WHERE o.org_id = p_org_id
       AND (o.courier_pickup_date IS NOT NULL
            OR LOWER(BTRIM(COALESCE(o.order_status, ''))) NOT IN ('', 'unfulfilled', 'cancelled'))
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
     WHERE b.status = 'settled' OR b.is_pre_onboarding;

    DELETE FROM _candidates c
     USING shopify_courier_bills b
     WHERE b.id = c.current_bill_id
       AND (b.status = 'settled' OR b.is_pre_onboarding);

    INSERT INTO shopify_courier_bills (org_id, courier, pickup_date)
    SELECT DISTINCT p_org_id, c.courier, c.pickup_date FROM _candidates c
    ON CONFLICT (org_id, courier, pickup_date) WHERE NOT is_pre_onboarding DO NOTHING;

    WITH updated AS (
        UPDATE shopify_orders o
           SET courier_bill_id = b.id,
               updated_at = NOW()
          FROM _candidates c
          JOIN shopify_courier_bills b
            ON b.org_id = p_org_id
           AND b.courier = c.courier
           AND b.pickup_date = c.pickup_date
           AND NOT b.is_pre_onboarding
         WHERE o.id = c.id
           AND o.org_id = p_org_id
        RETURNING o.id
    )
    SELECT COUNT(*)::INTEGER INTO v_assigned FROM updated;

    DELETE FROM shopify_courier_bills b
     WHERE b.org_id = p_org_id
       AND b.status = 'open'
       AND NOT b.is_pre_onboarding
       AND NOT EXISTS (SELECT 1 FROM shopify_orders o WHERE o.courier_bill_id = b.id);

    RETURN QUERY SELECT v_assigned, COALESCE(v_blocked, '{}');
END;
$$;

-- Orders sent by rider before Local Delivery existed were fulfilled in Shopify as
-- courier "Other", with the rider's name and charge in the tracking number or a tag
-- ("Bykea 300" - see shopify_sync._other_courier_delivery_charge). Those from the
-- last 60 days move to Local Delivery so the Local Deliveries page lists them. The
-- sync keeps a Local Delivery courier on file rather than reverting it to Shopify's
-- "Other" (see _reconcile_one_order's local_delivery).
--
-- Their charge stays as synced from the tag; no paid-from ledger is set, so nothing
-- posts until one is picked on the page.
DO $$
DECLARE
    v_org UUID;
    v_ids UUID[];
BEGIN
    FOR v_org IN SELECT id FROM system_organizations LOOP
        WITH moved AS (
            UPDATE shopify_orders o
               SET courier = 'Local Delivery',
                   -- Delivered = settled, as for a new Local Delivery order: no payout to wait for.
                   is_order_settled = o.is_order_settled OR lower(trim(COALESCE(o.order_status, ''))) = 'delivered',
                   updated_at = NOW()
             WHERE o.org_id = v_org
               AND lower(trim(COALESCE(o.courier, ''))) = 'other'
               AND (o.tracking_number ILIKE '%bykea%' OR o.tags ILIKE '%bykea%')
               AND COALESCE(o.courier_pickup_date, o.fulfilled_at, o.order_receiving_date) >= NOW() - INTERVAL '60 days'
            RETURNING o.id
        )
        SELECT array_agg(id) INTO v_ids FROM moved;

        IF v_ids IS NOT NULL THEN
            -- Off the shared 'Other' bill onto a Local Delivery one (an 'Other' bill already
            -- settled keeps its orders, as assign_courier_bills always does), then derive
            -- that bill's status.
            PERFORM assign_courier_bills(v_org, v_ids, ARRAY['local delivery']);
            PERFORM sync_local_delivery_bill_status(v_org, v_ids, ARRAY['local delivery']);
        END IF;
    END LOOP;
END;
$$;

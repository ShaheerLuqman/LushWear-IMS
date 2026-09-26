-- FedEx is TCS.
--
-- Shopify has no TCS carrier: scanning a TCS tracking number auto-assigns the
-- fulfillment to FedEx, and the sync stored that name as-is. The frontend
-- relabelled it for display, but bills, the Courier Payment Report's courier
-- filter and resolve_courier_ledger (which has no courier_fedex, so posted to
-- Courier Receivables - Other) all saw "FedEx". The sync now maps Shopify's
-- name onto ours (app/couriers.py canonical_courier); this renames what it
-- already stored.
--
-- No TCS orders or bills exist yet, so renaming cannot collide with the
-- (org_id, courier, pickup_date) bill key.
UPDATE shopify_orders
   SET courier = 'TCS', updated_at = NOW()
 WHERE LOWER(BTRIM(courier)) = 'fedex';

-- Repost the renamed bills so their receivable moves to the TCS ledger. A
-- rename touches none of the columns the resync trigger watches.
DO $$
DECLARE
    v_bill_id UUID;
BEGIN
    FOR v_bill_id IN
        UPDATE shopify_courier_bills
           SET courier = 'TCS', updated_at = NOW()
         WHERE LOWER(BTRIM(courier)) = 'fedex'
        RETURNING id
    LOOP
        PERFORM post_courier_bill_journal(v_bill_id);
    END LOOP;
END;
$$;

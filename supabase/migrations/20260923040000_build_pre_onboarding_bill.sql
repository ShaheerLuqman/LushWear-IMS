-- Builds (or rebuilds) a courier's pre-onboarding bill from current order state:
-- every parcel dispatched in the window before onboarding that is still unsettled
-- is what the courier still owes at the cutover.
--
-- Rebuildable by design - the admin can upload more CSVs and run it again. It
-- detaches only members **no payout has cleared**: a member accreted by
-- sync_pre_onboarding_bill was settled by a post-onboarding CPR and its voucher
-- already clears this bill's receivable, so dropping it would leave that voucher
-- crediting a courier account with nothing to clear and the ledger negative.
--
-- Window is in days before onboarding_date (60 by default, matching
-- SHOPIFY_SYNC_WINDOW_DAYS). Parcels older than that are deliberately left off:
-- most never pay out, and booking a receivable for them would invent an asset.
-- If one does pay out later, sync_pre_onboarding_bill adds it then.
CREATE OR REPLACE FUNCTION build_pre_onboarding_bill(
    p_org_id      UUID,
    p_courier     VARCHAR,
    p_window_days INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_onboarding DATE;
    v_start      DATE;
    v_bill       UUID;
    v_detached   INT := 0;
    v_attached   INT := 0;
    v_orders     INT := 0;
    v_cod        NUMERIC(14, 2) := 0;
BEGIN
    SELECT onboarding_date INTO v_onboarding FROM system_organizations WHERE id = p_org_id;
    IF v_onboarding IS NULL THEN
        RAISE EXCEPTION 'Organization % has no onboarding date', p_org_id;
    END IF;
    v_start := v_onboarding - p_window_days;

    SELECT id INTO v_bill
      FROM shopify_courier_bills
     WHERE org_id = p_org_id AND courier = p_courier AND is_pre_onboarding;

    IF v_bill IS NULL THEN
        INSERT INTO shopify_courier_bills (org_id, courier, pickup_date, is_pre_onboarding, notes)
        VALUES (p_org_id, p_courier, v_onboarding, TRUE, 'Pre-onboarding remaining orders')
        RETURNING id INTO v_bill;
    END IF;

    WITH dropped AS (
        UPDATE shopify_orders o
           SET courier_bill_id = NULL,
               updated_at = NOW()
         WHERE o.org_id = p_org_id
           AND o.courier_bill_id = v_bill
           AND o.courier_payout_id IS NULL
        RETURNING o.id
    )
    SELECT COUNT(*)::INT INTO v_detached FROM dropped;

    WITH added AS (
        UPDATE shopify_orders o
           SET courier_bill_id = v_bill,
               updated_at = NOW()
         WHERE o.org_id = p_org_id
           AND o.courier = p_courier
           AND NOT o.is_order_settled
           AND lower(trim(COALESCE(o.order_status, ''))) <> 'cancelled'
           AND COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE >= v_start
           AND COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE < v_onboarding
           AND o.courier_bill_id IS DISTINCT FROM v_bill
        RETURNING o.id
    )
    SELECT COUNT(*)::INT INTO v_attached FROM added;

    PERFORM post_courier_bill_journal(v_bill);

    SELECT COUNT(*)::INT,
           ROUND(COALESCE(SUM(COALESCE(o.total_amount, 0) - COALESCE(o.advance_amount, 0)), 0), 2)
      INTO v_orders, v_cod
      FROM shopify_orders o
     WHERE o.courier_bill_id = v_bill
       AND lower(trim(COALESCE(o.order_status, ''))) <> 'cancelled';

    -- An empty bill has nothing to say and would sit in the Courier Payment
    -- Report as a zero-value row; assign_courier_bills' own cleanup skips
    -- pre-onboarding bills, so clear it up here instead.
    IF v_orders = 0 THEN
        DELETE FROM shopify_courier_bills WHERE id = v_bill;
        v_bill := NULL;
    END IF;

    RETURN jsonb_build_object(
        'bill_id',       v_bill,
        'window_start',  v_start,
        'onboarding_date', v_onboarding,
        'orders_detached', v_detached,
        'orders_attached', v_attached,
        'orders_on_bill',  v_orders,
        'cod_total',       v_cod
    );
END;
$$;

-- sync_pre_onboarding_bill was far too broad: it attached every settled order
-- dispatched before onboarding, which for an established org is its entire
-- settled history (LushWear: ~1000 orders, ~3.8m of COD). Those were settled
-- *before* onboarding - their cash arrived then and is already part of the
-- opening position, so giving them a receivable invents an asset and credits
-- Opening Balance Equity with money that was never owed.
--
-- The case that actually needs accretion is narrower: a parcel dispatched before
-- onboarding whose CPR arrives *after* it. Only then does cash land on books
-- that hold no receivable for it. That is precisely "linked to a payout dated on
-- or after onboarding_date" - and since assign_courier_payouts now refuses to
-- create payouts dated earlier, any payout link at all implies a post-onboarding
-- CPR. The date test is kept explicit rather than implied, so this stays correct
-- if that rule ever changes.
--
-- Consequence for the caller: the order must already be linked to its payout, so
-- this now runs after assign_courier_payouts rather than before it (see
-- _post_postex_payout in routes/orders.py). post_courier_payout_journal still
-- runs afterwards, so the receivable exists before the voucher clears it.
CREATE OR REPLACE FUNCTION sync_pre_onboarding_bill(p_org_id UUID, p_courier VARCHAR)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    v_onboarding DATE;
    v_bill       UUID;
    v_n          INT := 0;
BEGIN
    SELECT onboarding_date INTO v_onboarding FROM system_organizations WHERE id = p_org_id;
    IF v_onboarding IS NULL THEN
        RETURN 0;
    END IF;

    CREATE TEMP TABLE IF NOT EXISTS _stale_pre_onboarding (id UUID) ON COMMIT DROP;
    TRUNCATE _stale_pre_onboarding;

    INSERT INTO _stale_pre_onboarding (id)
    SELECT o.id
      FROM shopify_orders o
      JOIN finances_courier_payouts y ON y.id = o.courier_payout_id
      LEFT JOIN shopify_courier_bills b ON b.id = o.courier_bill_id
     WHERE o.org_id = p_org_id
       AND o.courier = p_courier
       AND o.is_order_settled
       AND COALESCE(o.courier_pickup_date, o.fulfilled_at)::DATE < v_onboarding
       AND y.payout_date >= v_onboarding
       AND NOT COALESCE(b.is_pre_onboarding, FALSE);

    IF NOT EXISTS (SELECT 1 FROM _stale_pre_onboarding) THEN
        RETURN 0;
    END IF;

    SELECT id INTO v_bill
      FROM shopify_courier_bills
     WHERE org_id = p_org_id AND courier = p_courier AND is_pre_onboarding;

    IF v_bill IS NULL THEN
        INSERT INTO shopify_courier_bills (org_id, courier, pickup_date, is_pre_onboarding, notes)
        VALUES (p_org_id, p_courier, v_onboarding, TRUE, 'Pre-onboarding remaining orders')
        RETURNING id INTO v_bill;
    END IF;

    WITH moved AS (
        UPDATE shopify_orders o
           SET courier_bill_id = v_bill,
               updated_at = NOW()
          FROM _stale_pre_onboarding s
         WHERE o.id = s.id
        RETURNING o.id
    )
    SELECT COUNT(*)::INT INTO v_n FROM moved;

    PERFORM post_courier_bill_journal(v_bill);
    RETURN v_n;
END;
$$;

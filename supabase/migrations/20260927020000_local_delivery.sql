-- Local Delivery couriers (riders booked on demand; see LOCAL_DELIVERY_PLAN.md).
--
-- The rider is paid their delivery charge on the spot, so unlike a courier
-- company's DC (netted out of its payout, see post_courier_payout_journal) it is
-- posted per order, from the ledger it was actually paid from. A DC of 0 (the
-- customer paid the rider) or no ledger picked yet posts nothing.
ALTER TABLE shopify_orders
    ADD COLUMN IF NOT EXISTS delivery_charge_ledger_id UUID REFERENCES finances_ledgers(id) ON DELETE SET NULL;

-- A transaction entry rather than a bare journal entry so the payment also lands
-- on the Transactions page, same as a payout's Cash Received leg
-- (20260917000000_postex_payout_cash_as_transaction_entry.sql). Deleting it
-- cascades to its journal entry via transaction_entries_journal_trigger.
CREATE OR REPLACE FUNCTION post_local_delivery_charge(p_order_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    o      RECORD;
    v_cash UUID;
BEGIN
    DELETE FROM finances_transaction_entries
     WHERE source_type = 'local_delivery_charge' AND source_id = p_order_id;

    SELECT * INTO o FROM shopify_orders WHERE id = p_order_id;
    IF NOT FOUND OR COALESCE(o.delivery_charge, 0) <= 0 OR o.delivery_charge_ledger_id IS NULL THEN
        RETURN;
    END IF;

    SELECT id INTO v_cash FROM finances_ledgers WHERE org_id = o.org_id AND system_key = 'cash';

    INSERT INTO finances_transaction_entries
        (org_id, entry_date, amount, description, from_account_id, to_account_id, source_type, source_id)
    VALUES (
        o.org_id,
        (COALESCE(o.fulfilled_at, o.order_receiving_date) AT TIME ZONE 'Asia/Karachi')::DATE,
        o.delivery_charge,
        o.courier || ' #' || o.order_number || ' - Delivery Charges',
        -- Cash is stored as an empty side, as the Transactions page writes it.
        NULLIF(o.delivery_charge_ledger_id, v_cash),
        ensure_system_ledger(o.org_id, 'delivery_charges', 'Delivery Charges', 'Expense', '5100'),
        'local_delivery_charge', o.id
    );
END;
$$;

-- A trigger rather than a call from the Local Deliveries endpoint, so the posting
-- follows the charge whichever writer changes it (the Orders grid's inline and bulk
-- delivery-charge edits too). WHEN keeps the Shopify sync's upserts, which always
-- carry delivery_charge, from re-posting unchanged rows.
CREATE OR REPLACE FUNCTION trg_shopify_orders_post_local_delivery_charge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM post_local_delivery_charge(NEW.id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS shopify_orders_local_delivery_charge_trigger ON shopify_orders;
CREATE TRIGGER shopify_orders_local_delivery_charge_trigger
AFTER UPDATE OF delivery_charge, delivery_charge_ledger_id ON shopify_orders
FOR EACH ROW
WHEN (OLD.delivery_charge IS DISTINCT FROM NEW.delivery_charge
      OR OLD.delivery_charge_ledger_id IS DISTINCT FROM NEW.delivery_charge_ledger_id)
EXECUTE FUNCTION trg_shopify_orders_post_local_delivery_charge();

-- A Local Delivery bill has nothing to close out with the rider's company, so its
-- status is derived: settled once every non-cancelled order on it is delivered,
-- open again if a later same-day booking joins it. Run by app/couriers.py's
-- assign_courier_bills right after assignment, for the bills of p_order_ids (every
-- bill of the org when NULL). p_couriers (lowercased) limits this to Local Delivery
-- bills - a disabled courier's orders share the 'Other' bill, which is settled by
-- hand like any courier company's.
CREATE OR REPLACE FUNCTION sync_local_delivery_bill_status(p_org_id UUID, p_order_ids UUID[], p_couriers TEXT[])
RETURNS void
LANGUAGE sql
AS $$
    UPDATE shopify_courier_bills b
       SET status = s.status,
           settled_at = CASE WHEN s.status = 'settled' THEN NOW() END,
           updated_at = NOW()
      FROM (
          SELECT c.id,
                 CASE WHEN EXISTS (
                     SELECT 1 FROM shopify_orders o
                      WHERE o.courier_bill_id = c.id
                        AND lower(trim(COALESCE(o.order_status, ''))) NOT IN ('delivered', 'cancelled')
                 ) THEN 'open' ELSE 'settled' END AS status
            FROM shopify_courier_bills c
           WHERE c.org_id = p_org_id
             AND lower(c.courier) = ANY(p_couriers)
             AND NOT c.is_pre_onboarding
             AND (p_order_ids IS NULL OR c.id IN (
                 SELECT courier_bill_id FROM shopify_orders WHERE id = ANY(p_order_ids)
             ))
      ) s
     WHERE b.id = s.id AND b.status <> s.status;
$$;

-- The Bykea courier is now the generic "Local Delivery" one (app/couriers.py), so any
-- order or bill already carrying the old name moves over, and those bills repost so
-- their sale entry's particulars carry the new name.
UPDATE shopify_orders SET courier = 'Local Delivery' WHERE lower(trim(courier)) = 'bykea';

DO $$
DECLARE
    v_bill_id UUID;
BEGIN
    FOR v_bill_id IN
        UPDATE shopify_courier_bills SET courier = 'Local Delivery', updated_at = NOW()
         WHERE lower(trim(courier)) = 'bykea'
        RETURNING id
    LOOP
        PERFORM post_courier_bill_journal(v_bill_id);
    END LOOP;
END;
$$;

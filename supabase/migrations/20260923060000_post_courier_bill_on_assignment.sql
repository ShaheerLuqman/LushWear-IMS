-- A dispatch bill's Sales Revenue voucher never posted when orders joined it.
--
-- The resync trigger from 20260916000000_exclude_cancelled_from_courier_bills.sql
-- reposts a bill only when a member's status/total/advance changes. Its members
-- arrive through assign_courier_bills, which sets courier_bill_id alone, and they
-- are usually already 'fulfilled' by then - so a bill posted only once some
-- later status change (e.g. delivered) happened to touch it, and a fresh
-- dispatch day showed nothing in Sales Revenue until then.
--
-- Reposting on a courier_bill_id change too, for both the bill joined and the
-- bill left, so a moved order stops counting on its old bill as well.
CREATE OR REPLACE FUNCTION trg_shopify_orders_resync_courier_bill_journal_stmt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM post_courier_bill_journal(v.bill_id)
      FROM (
          SELECT n.courier_bill_id AS bill_id
            FROM old_rows o
            JOIN new_rows n ON n.id = o.id
           WHERE o.order_status IS DISTINCT FROM n.order_status
              OR o.total_amount IS DISTINCT FROM n.total_amount
              OR o.advance_amount IS DISTINCT FROM n.advance_amount
              OR o.courier_bill_id IS DISTINCT FROM n.courier_bill_id
          UNION
          SELECT o.courier_bill_id
            FROM old_rows o
            JOIN new_rows n ON n.id = o.id
           WHERE o.courier_bill_id IS DISTINCT FROM n.courier_bill_id
      ) v
     WHERE v.bill_id IS NOT NULL;
    RETURN NULL;
END;
$$;

-- Backfill every bill the old trigger left unposted; post_courier_bill_journal
-- applies the onboarding gate itself.
DO $$
DECLARE
    v_bill_id UUID;
BEGIN
    FOR v_bill_id IN
        SELECT b.id
          FROM shopify_courier_bills b
         WHERE NOT EXISTS (SELECT 1 FROM finances_journal_entries e
                            WHERE e.source_type = 'courier_bill_sale' AND e.source_id = b.id)
         ORDER BY b.pickup_date
    LOOP
        PERFORM post_courier_bill_journal(v_bill_id);
    END LOOP;
END;
$$;

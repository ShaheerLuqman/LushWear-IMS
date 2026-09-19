-- A booking made through the app's /fulfill (fulfilled_at set) is this app's own record,
-- not a mirror of Shopify's. Three days running the Shopify sync voided real parcels by
-- reading Shopify's "no fulfillment" as an undo (2026-09-17 13839/13803, 09-18 13915,
-- 09-19 13940); the sync no longer does that, and this trigger makes the invariant hold
-- against every other writer too - a future code path, a script, a hand edit.
--
-- Only /orders/{id}/unbook may clear a booking, and it does so by also clearing
-- fulfilled_at in the same UPDATE - the one shape this trigger lets through. Moving the
-- status forward (delivered/returned/cancelled) is fine; cancelling keeps the booking on
-- record by design.
CREATE OR REPLACE FUNCTION trg_shopify_orders_booking_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.fulfilled_at IS NULL OR NEW.fulfilled_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.order_status = 'unfulfilled'
     OR (COALESCE(OLD.tracking_number, '') <> '' AND COALESCE(NEW.tracking_number, '') = '')
     OR (LOWER(COALESCE(OLD.courier, '')) NOT IN ('', 'unassigned')
         AND LOWER(COALESCE(NEW.courier, '')) IN ('', 'unassigned')) THEN
    RAISE EXCEPTION 'order % is booked through the app (fulfilled_at set) - use Unbook to clear its booking',
      OLD.order_number
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shopify_orders_booking_guard_trigger ON shopify_orders;
CREATE TRIGGER shopify_orders_booking_guard_trigger
BEFORE UPDATE OF order_status, tracking_number, courier, fulfilled_at ON shopify_orders
FOR EACH ROW
EXECUTE FUNCTION trg_shopify_orders_booking_guard();

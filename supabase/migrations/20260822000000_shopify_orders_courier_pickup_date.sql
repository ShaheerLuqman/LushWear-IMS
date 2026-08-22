-- Date the courier actually picked up the parcel: PostEx's own orderPickupDate when
-- available, else the datetime of delivery_status's status_history second entry
-- (oldest-first) - the first entry is the order being booked with the courier, the
-- second is the courier collecting it (see orders.py's _courier_pickup_date_iso).
-- Null until a delivery-status fetch supplies one or the other. Distinct from
-- order_receiving_date, which is when the order itself was placed/received, not
-- when the courier collected it.

ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS courier_pickup_date TIMESTAMPTZ;

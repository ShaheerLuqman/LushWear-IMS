# Local Delivery — Implementation Plan

Status: design in progress, nothing implemented.

## Goal

Support **Local Delivery** couriers: Bykea-style riders booked on demand for
urgent, same-city parcels. They are not courier companies. There is no booking
API, pickup date, pickup location, courier city or order type, and there is
never cash to collect. The only money on the order is the delivery charge (DC).

## Decisions

- **Name:** "Local Delivery" in the UI; `kind: "local_delivery"` in code.
  Normal couriers are left as they are, with no kind set.
- **Reuse, not a new subsystem:** a Local Delivery courier is an ordinary entry
  in `COURIER_CATALOG` (backend) and `FULFILLMENT_COURIERS` (frontend) with the
  kind flag. Bykea is already in both.
- **DC varies per order.** A positive amount means we paid the rider (our
  expense). 0 means the customer paid the rider directly, so there's nothing to
  post.
- **No cash to collect.** No COD on Local Delivery orders, ever.
- **A new Local Deliveries page** lists Local Delivery orders. On each row the
  user sets the DC, picks the ledger it was paid from, and marks the order
  delivered.
- **The paid-from ledger is chosen per order** on that page, not configured
  once in Settings.

## Current state

- Bykea's ledger `courier_bykea` (1153) is seeded as an Asset account for COD it
  owes us, the same model as PostEx. With no COD it will simply stay at zero.
- Picking Bykea on Order Fulfillment still asks for a pickup location and city,
  and booking only dispatches to PostEx or Couriers Next (`routes/orders.py`
  `_book_one_order`).
- Current workaround: fulfill as courier "Other" and tag the Shopify order
  `Bykea 300`, which `_delivery_charge_from_other_tags` (`services/shopify_sync.py`)
  parses into the DC. Local Delivery replaces this for new orders.
- The sale posting (`post_order_journal`) debits the courier's ledger for
  `total - advance` as "COD due from courier". For a Local Delivery order this
  has to be 0 (see open questions).

## Proposed flow

1. **Order Fulfillment:** picking a Local Delivery courier hides pickup location,
   courier city, order type and COD. Booking needs only the selected orders plus
   an optional ref (Bykea booking ID or rider phone), saved as `tracking_number`.
   The DC is not asked for here; it's entered on the Local Deliveries page.
2. **Booking (backend):** no courier API. Save `courier`,
   `order_status = fulfilled` and `fulfilled_at` locally, then reuse the existing
   Shopify fulfillment push. `pickup_address_code` and `courier_city` become
   optional for this kind.
3. **Local Deliveries page:** a list of orders whose courier is a Local Delivery
   courier, with pending ones first. Per row:
   - **DC:** editable amount, default 0.
   - **Paid from:** a ledger dropdown (cash/bank), required when DC > 0. Reuse
     whatever ledger picker payment vouchers already use.
   - **Delivered:** a button that sets `order_status = delivered`.
4. **Accounting:** saving a row (re)posts one journal entry per order,
   `source_type = 'local_delivery_charge'`, `source_id = order id`, dated
   `fulfilled_at`: **Dr Delivery Charges (5100) / Cr <paid-from ledger>**.
   Setting DC to 0 or clearing the ledger deletes that entry. This follows the
   same delete-then-reinsert pattern as the sale and payout postings. A row with
   DC > 0 and no ledger shows as incomplete and posts nothing.
   Because the post has to go through a plpgsql function (like the other
   postings), it needs a versioned migration.

## Open questions

1. How do Local Delivery customers pay for the goods? The sale posting reads
   `total - advance` as COD owed by the courier. So either these orders are
   always recorded with a full advance, or booking must reject an order whose
   advance is less than its total. Otherwise Bykea's ledger builds up a
   receivable nobody will ever pay.
2. Does "delivered" also mean settled (`is_order_settled = true`)? There's no
   payout to wait for, so it probably should.
3. Failed deliveries (rider brings the parcel back): do they need a "Returned"
   action on the page, or is that rare enough to handle by hand?

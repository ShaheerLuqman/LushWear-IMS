# Local Delivery — Implementation Plan

Status: design in progress, nothing implemented.

## Goal

Support **Local Delivery** couriers: Bykea-style riders booked on demand for
urgent, same-city parcels. They are not courier companies. There is no booking
API, pickup date, pickup location, courier city or order type, and an order
normally carries a delivery charge (DC) instead of COD.

## Decisions

- **Name:** "Local Delivery" in the UI; `kind: "local_delivery"` in code.
  Normal couriers are left as they are, with no kind set.
- **Reuse, not a new subsystem:** a Local Delivery courier is an ordinary entry
  in `COURIER_CATALOG` (backend) and `FULFILLMENT_COURIERS` (frontend) with the
  kind flag. Bykea is already in both.

## Current state

- Bykea's ledger `courier_bykea` (1153) is seeded as an Asset account for COD it
  owes us, the same model as PostEx, which doesn't fit a rider paid a DC.
- Picking Bykea on Order Fulfillment still asks for a pickup location and city,
  and booking only dispatches to PostEx or Couriers Next (`routes/orders.py`
  `_book_one_order`).
- Current workaround: fulfill as courier "Other" and tag the Shopify order
  `Bykea 300`, which `_delivery_charge_from_other_tags` (`services/shopify_sync.py`)
  parses into the DC. Local Delivery should replace this.

## Proposed changes

1. **Catalog:** add `kind: "local_delivery"` to Bykea in both catalogs.
2. **Fulfillment page:** for a Local Delivery courier, hide pickup location,
   courier city, order type and COD. Show a required, editable **Delivery
   charge** column and an optional ref (Bykea booking ID or rider phone), saved
   as `tracking_number`.
3. **Booking:** no courier API. Save `courier`, `delivery_charge`,
   `order_status = fulfilled` and `fulfilled_at` locally, then reuse the
   existing Shopify fulfillment push. `pickup_address_code` and `courier_city`
   become optional for this kind.
4. **Accounting:** a normal courier's DC is posted only at payout (Dr Delivery
   Charges / Cr Courier), and a rider never sends a payout. Post it at dispatch
   instead: **Dr Delivery Charges (5100) / Cr <paid-from account>**.
5. **Delivered status:** no tracking API, so something must move these orders
   to delivered (see open questions).

## Open questions

1. Who pays the DC: we pay the rider (our expense, step 4), or the customer pays
   the rider directly (reference only, no journal)?
2. Are these orders always prepaid, or does the rider sometimes collect cash and
   hand it back (keeps a COD field and the Bykea receivable ledger)?
3. Delivered: automatically at dispatch, or a manual "Mark delivered" action?
4. DC paid from cash in hand or bank?

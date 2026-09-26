# Local Delivery — Implementation Plan

Status: implemented 2026-09-27; migrations `20260927000000`-`20260927020000` not yet
applied to the live database. Deviations from the design below are listed under
Implementation notes.

## Goal

Support **Local Delivery**: riders booked on demand (a ride-hailing app's parcel
service) for urgent, same-city parcels. They are not courier companies. There is no booking
API, pickup date, pickup location, courier city or order type, and there is
never cash to collect. The only money on the order is the delivery charge (DC).

## Decisions

- **Name:** "Local Delivery" everywhere - the courier itself, not a brand. Courier
  id `local_delivery`, `kind: "local_delivery"`, ledger `courier_local_delivery`
  ("Courier Local Delivery"). It replaces the old Bykea entry, whose ledger,
  orders and bills are renamed by the migrations. Normal couriers have no kind.
- **Reuse, not a new subsystem:** Local Delivery is an ordinary entry in
  `COURIER_CATALOG` (backend) and `FULFILLMENT_COURIERS` (frontend) with the kind
  flag.
- **DC varies per order.** A positive amount means we paid the rider (our
  expense). 0 means the customer paid the rider directly, so there's nothing to
  post. It starts as the courier's `fixed_delivery_charge` from Settings >
  Couriers when one is set (booking already writes it onto the order), else
  NULL (not entered).
- **No cash to collect.** No COD on Local Delivery orders, ever.
- **A new Local Deliveries page** lists Local Delivery orders. On each row the
  user sets the DC, picks the ledger it was paid from, and marks the order
  delivered.
- **The paid-from ledger is chosen per order** on that page, not configured
  once in Settings.
- **Customers always pay the full amount in advance.** Booking rejects a Local
  Delivery order whose `advance_amount < total_amount`. Otherwise the bill's
  sale posting would book the difference as COD owed by the rider, a receivable
  no one will ever pay. The advance is recorded beforehand through the Advance
  modal (`PUT /orders/{id}/advance`), which only works before booking anyway.
- **Delivered means settled:** marking a Local Delivery order delivered sets
  `order_status = delivered` and `is_order_settled = true` together, and settles
  its courier bill once every non-cancelled order on it is delivered. This lives
  in one helper called from every path that can mark an order delivered: the
  Local Deliveries page, `bulk_update_order_status` and `update_order`. That
  way, marking it from the Orders page behaves the same.
- **Local Delivery bills stay on the Courier Payment Report.** The bill shows
  the orders' total. Its remaining amount (`net_receivable`) goes negative by the
  DC, which is accepted: it reflects the DC paid to riders.
- **Failed deliveries are handled by hand for now.** No Returned action; revisit
  if they stop being rare.
- **`delivery_charge` becomes nullable.** NULL = not entered yet, 0 = entered as
  zero (e.g. customer paid the rider). A migration drops `NOT NULL` and
  `DEFAULT 0` and sets every existing 0 to NULL, because today's 0 can't be told
  apart from "never entered". Orders already marked with DC 1 are left alone.
  - Must ship with the migration: every writer that turns NULL back into 0,
    otherwise the next sync undoes the backfill. These are the new-order insert
    default and the "keep existing DC" step in `_reconcile_one_order`
    (`shopify_sync.py`), the same pattern in force sync (`routes/orders.py`),
    and the `delivery_charge: float = 0.0` model field (becomes Optional). A
    "<name> 0" tag on an "Other" order becomes a valid 0 instead of "no charge".
  - **SCS's hard-coded 180 goes away** (`shopify_sync.py` new-order and
    re-sync paths, and force sync in `routes/orders.py`) in favour of the
    fixed-DC setting in Settings > Couriers:
    1. Add SCS to `COURIER_CATALOG` (ledger `courier_scs`, code 1154). Its seed
       needs a migration line in the org-creation trigger and the existing-org
       backfill, the same as the other couriers' in
       `20260913050000_seed_courier_system_ledgers.sql`. The admin then sets
       SCS's fixed DC to 180.
    2. The sync applies a courier's `fixed_delivery_charge` when an order's DC is
       NULL, for any catalog courier. Today only `/fulfill` applies it, and SCS
       orders are booked outside the app. A DC already entered is never
       overwritten.
    - Side effect: once SCS is enabled, its orders move from the shared 'Other'
      bills to their own SCS bills, and the COD receivable moves from Courier
      Receivables - Other to the new SCS ledger when the bills repost. Orders on a
      bill already marked settled stay put (`assign_courier_bills` blocks them).
  - Deferred: the Warning/OK rule (`computeFinalStatus`,
    `get_month_summary_periods`) and `computeNetProfit` switching from
    `delivery_charge > 0` to `IS NOT NULL`. Reads already treat NULL as 0 (`or 0`,
    `|| 0`, `COALESCE`), so nothing breaks in between. Until the rule switches, a
    DC 0 order still shows as Warning.
- **`tax_amount` stays NOT NULL DEFAULT 0.** Only PostEx's CSV and API set it;
  for every other courier 0 is the real value, and nothing treats 0 as missing.

## Current state

- The old Bykea ledger `courier_bykea` (1153) is seeded as an Asset account for
  COD it owes us, the same model as PostEx. As `courier_local_delivery`, with no
  COD, it simply stays at zero.
- Picking Bykea on Order Fulfillment still asks for a pickup location and city,
  and booking only dispatches to PostEx or Couriers Next (`routes/orders.py`
  `_book_one_order`).
- Current workaround: fulfill as courier "Other" and tag the Shopify order
  `Bykea 300`, which `_other_courier_delivery_charge` (`services/shopify_sync.py`)
  parses into the DC. Local Delivery replaces this for new orders.
- Every shipped order now sits on a courier bill, one per (courier, dispatch
  date), using `COALESCE(courier_pickup_date, fulfilled_at, order_receiving_date)`
  (`20260926010000_courier_bills_cover_all_orders.sql`). An order of a courier
  that is disabled in Settings goes on the shared 'Other' bill instead, so a Local
  Delivery courier must be enabled. The picker only offers enabled couriers
  already.
- Sales post per bill (`post_courier_bill_journal`): Dr courier ledger
  `total - advance` ("COD Receivable"), Dr Customer Advances, Cr Sales. With a
  full advance the courier line is 0, so Local Delivery orders post correctly
  with no change there.
- Payout DC posting (`post_courier_payout_journal`) only sums orders carrying a
  `courier_payout_id`, which Local Delivery orders never get, so it can't
  double-post the DC posted below.
- The Courier Payment Report's bill `net_receivable` is
  `total - advance - charges - taxes`. For a Local Delivery bill with DC it's negative
  (-DC), which is accepted (see Decisions).
- Settling a bill (`PATCH /courier-bills/{id}`, `status = settled`) posts
  nothing. It only sets `settled_at` and freezes the bill's membership, so
  settling Local Delivery bills automatically is safe.
- The Orders grid (`computeFinalStatus` in `logic/orders.ts`) and the month
  summary warning count (`get_month_summary_periods`) only treat a delivered
  order as OK when `delivery_charge > 0`, and `computeNetProfit` returns null at
  DC 0. This is why the merchant enters DC 1 on customer-paid "Other" orders
  (see `_other_courier_delivery_charge`).

## Proposed flow

1. **Order Fulfillment:** picking a Local Delivery courier hides pickup location,
   courier city, order type and COD. Booking needs only the selected orders plus
   an optional ref (the ride's booking ID or rider phone), saved as `tracking_number`.
   The DC is not asked for here; it's entered on the Local Deliveries page.
   Orders without a full advance are rejected per order, the same way booking
   failures are already reported per order.
   A late booking dated the same day can join a bill already settled
   (`assign_courier_bills` only freezes orders already on a settled bill, not new
   ones). So after assigning, re-open any Local Delivery bill that now holds an
   undelivered order. The bill's status is always derived: settled if and only
   if all its non-cancelled orders are delivered.
2. **Booking (backend):** no courier API. Save `courier`,
   `order_status = fulfilled` and `fulfilled_at` locally, then reuse the existing
   Shopify fulfillment push. `pickup_address_code` and `courier_city` become
   optional for this kind. Also call `assign_courier_bills` for the booked orders
   so their bill (and so their sale) posts at once. `fulfill_orders` doesn't call
   it today and relies on the Shopify sync picking them up later.
3. **Local Deliveries page:** a list of orders whose courier is a Local Delivery
   courier, newest order number first. Per row:
   - **DC:** editable amount; blank (NULL) until entered, and 0 is a valid entry.
     A row needs attention while its DC is NULL, or while it's above 0 with no
     paid-from ledger.
   - **Paid from:** a ledger dropdown (cash/bank), required when DC > 0. Reuse
     whatever ledger picker payment vouchers already use.
   - **Delivered:** a button that sets `order_status = delivered` and
    `is_order_settled = true`. This is local only: do **not** call
    `shopify.mark_order_settled`. Its "Settled" tag tells the sync's advance
    derivation (`shopify_sync.py`, the `has_settled_tag` check) that a "paid"
    status came from a courier payout, not the customer. On a prepaid Local
    Delivery order paid through Shopify checkout (no "Advance Paid" tag) that
    would reset the advance to 0. Shopify already shows these orders as paid,
    so there's nothing to push.
4. **Accounting:** saving a row (re)posts one journal entry per order,
   `source_type = 'local_delivery_charge'`, `source_id = order id`, dated
   `fulfilled_at`: **Dr Delivery Charges (5100) / Cr <paid-from ledger>**.
   Particulars follow the descriptive style from
   `20260926020000_descriptive_courier_particulars.sql`, e.g.
   `Local Delivery #1234 - Delivery Charges`.
   Setting DC to 0 or clearing the ledger deletes that entry. This follows the
   same delete-then-reinsert pattern as the sale and payout postings. A row with
   DC > 0 and no ledger shows as incomplete and posts nothing.
   Because the post has to go through a plpgsql function (like the other
   postings), it needs a versioned migration.

## Ledger naming (ships alongside)

### Courier ledgers are named "Courier <label>"

- `courier_postex` → "Courier PostEx", `courier_couriers_next` → "Courier
  Couriers Next", `courier_tcs` → "Courier TCS", `courier_bykea` →
  `courier_local_delivery` "Courier Local Delivery", and the new `courier_scs` is
  seeded as "Courier SCS".
  `courier_other` ("Courier Receivables - Other") → "Courier Others" to match.
- A migration following `20260926000000_rename_orders_ledger_to_customer_advances.sql`:
  - redefine `trg_organizations_seed_system_ledgers` with the new names;
  - redefine `resolve_courier_ledger`'s `courier_other` fallback;
  - set every system ledger (all `system_key`s, not just couriers) to its
    canonical name, even if the org renamed it. Names are now locked (below), so
    a custom name would otherwise be frozen for good. Skip any org where the
    canonical name is held by another ledger (`idx_ledgers_org_id_name_lower` is a
    hard unique constraint), and have the migration `RAISE NOTICE` those so they
    can be sorted out by hand.
- Postings find these accounts by `system_key`, so renaming touches no postings.
- Python: `COURIER_LEDGER_LABELS` and the `p_name` passed to
  `enable_courier_system_ledger` become `"Courier " + label`.
  `SYSTEM_LEDGER_LABELS["courier_other"]` becomes "Courier Others". The courier's
  own `label` ("PostEx") is unchanged, since it's the name stored on orders and
  matched by `resolve_courier_ledger` and bill grouping.

### System ledger names are locked

- `update_ledger` rejects a name change on a ledger with a `system_key`
  ("System ledgers can't be renamed"). Sending its current name unchanged is
  fine, since the edit modal sends the whole form.
- Edit Ledger modal (`pages/finance/LedgerModals.tsx`): the name field is
  read-only when `isSystem`, and the banner reads "…so it can't be renamed or
  deleted".

### Users can't take a system ledger's name

- `create_ledger` and a rename via `update_ledger` (`routes/ledger.py`) reject a
  name matching any system ledger's name, case-insensitively and trimmed, with
  "<name> is reserved for a system ledger". This applies whether or not the org
  has that system ledger yet.
  - Why: `ensure_system_ledger` creates some accounts lazily (`tax_on_purchases`,
    `other_expenses`, `courier_other`, `courier_scs` for existing orgs). If a user
    already holds the name, the system account gets "<name> (2)" instead.
- The reserved set is the values of `SYSTEM_LEDGER_LABELS` plus
  `COURIER_LEDGER_LABELS`, so there's one list in Python. The SQL seed literals
  are already kept in sync with those by hand.
- Existing clashes (a user ledger already holding a reserved name) are left
  alone. They can still be renamed away, just not onto another reserved name.

## Implementation notes

- **DC posting is a transaction entry, posted by a trigger.**
  `post_local_delivery_charge` writes a `finances_transaction_entries` row, so the
  rider payment also shows on the Transactions page, like a payout's Cash Received
  leg. The trigger `shopify_orders_local_delivery_charge_trigger` fires whenever
  `delivery_charge` or `delivery_charge_ledger_id` actually changes, so the Orders
  grid's inline and bulk DC edits re-post too, not only the Local Deliveries page.
- **Bill status is re-derived inside `assign_courier_bills`** (couriers.py), via
  `sync_local_delivery_bill_status`. Every write that can move or re-status an
  order already calls it, and `fulfill_orders` and `bulk_update_order_status` now
  do too.
- **`fulfill_orders` assigns bills right after booking for every courier**, not
  only Local Delivery. The Shopify sync did this seconds later anyway.
- **A "<name> 0" tag on an "Other" order still reads as "no charge"**, deferred along with
  the Warning/OK rule. Turning it into a real 0 before that rule switches would
  flip DC-1-marked orders to Warning on their next sync.
- **Renaming system ledgers was already blocked in the Edit Ledger form**; only the
  backend lacked the check. The frontend's partial `SYSTEM_LEDGER_LABELS` map
  (used only by that form's banner) was removed.
- **Old rider orders from the last 60 days are Local Delivery too**
  (`20260927030000_legacy_local_deliveries.sql`): "Other" orders whose tracking
  number or tags mention the old rider service move over, onto Local Delivery bills,
  settled if delivered. Their charge stays as synced from the tag, with no paid-from
  ledger, so nothing posts for them unless one is picked. The sync keeps a Local
  Delivery courier on file instead of reverting it to Shopify's "Other", and no
  longer re-derives its charge from the tag.
- **A blank (NULL) delivery charge shows as a greyed dash** on the Orders grid and
  order details, the Local Deliveries page and the Courier Payment Report's bill table.
- **After deploying:** enable SCS in Settings > Couriers and set its fixed
  delivery charge to 180; until then SCS orders get no DC from the sync.

## Open questions

None. Ready to implement when asked.

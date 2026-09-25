# Receive Advance from the Orders Grid — Plan

Status: planning. Nothing implemented.

## Problem

Recording a customer advance today takes three separate steps in three places:

1. Record the payment in Shopify, either by marking the order paid or by adding a discount
   for a partial advance. The sync then derives `advance_amount` from that.
2. Post a Transaction Entry with **Order Advance Amount** ticked. This credits the Orders
   ledger, debits the cash or bank ledger, and stamps `order_number` on the entry.
3. Check the `advance_status` dot to make sure the two agree.

The goal is to do all of this in a single popup opened from the order row.

## Decisions taken

| Question | Decision |
|---|---|
| Where the advance is recorded in Shopify | **Partial:** a `Partial Advance: <amount>` tag, and nothing else. **Full:** the order is marked paid, with no tag. Partial payments can't be recorded through the API without Shopify Plus (see "Why a tag"). |
| Discount-as-advance | **Retired.** Every discount becomes a real price reduction, and only the tag or the paid status counts as an advance. |
| Orders in progress that use discount-as-advance | Converted by a **one-off script** |
| When an advance can be received or edited | **Only before the courier is booked.** The COD amount is fixed at booking, so once an order has a courier or tracking number, the action is hidden and the endpoint refuses it. |
| Overpayment | **Rejected.** The advance can never exceed the order total. |
| Undo | **Edit it again.** The same popup reopens with the current advance, and saving a lower amount (down to 0) reverses the difference. There is no separate reverse action. |
| Orders not in Shopify | **Not a case.** Every order comes from Shopify. An order with no Shopify ID is an error, not a separate path. |
| Tests on Shopify (`orderMarkAsPaid`, tag round-trip, discount removal) | **Deferred.** They are run before this ships, not now. |

## What already exists and is reused

| Piece | Where | Role here |
|---|---|---|
| Order-advance transaction entry (`from = Orders`, `to = cash/bank`, `order_number`) | `routes/transactions.py`, `TransactionEntryModal.tsx` | The ledger posting. It is already double-entry: Dr bank, Cr Orders (liability). |
| `recompute_advance_statuses` | `app/advance_status.py` | Turns the dot green once Shopify and the ledger agree |
| Courier bill reposting on an `advance_amount` change | `20260910040000_post_by_courier_bill.sql` trigger | The "Dr Orders / advances applied" leg follows automatically |
| `ensure_not_before_onboarding` | transactions route | Blocks entry dates before onboarding |
| Row actions menu, `booked` check | `ordersPolarisColumns.tsx` `ActionsCell` | Entry point and its visibility rule |
| `FormModal`, `LedgerSelect`, `orderAdvanceParticularPlaceholder` | frontend shared | The popup |
| `add_order_tag`, `_shopify_order_id_for` | `shopify.py`, `routes/orders.py` | Shopify writes |

## Proposed flow

**UI.** The row menu gets **Receive advance**, or **Edit advance** once the order has one.
It is shown only for orders that are unfulfilled, not cancelled and not booked. It opens a
`FormModal` with a pinned footer, per CLAUDE.md:

- Order # and Total (read-only)
- **Advance received**: the order's total advance, not the amount being added. It defaults
  to the order total for a first advance and to the current advance when editing. It is
  editable, from 0 up to the total.
- **Received in / Returned from**, a `LedgerSelect` limited to Asset ledgers (cash, bank,
  wallets). This is the account the difference is posted to.
- **Date**, which defaults to today
- **Particulars**, which defaults to the existing order-advance placeholder

**Backend.** Add one endpoint, `PUT /orders/{id}/advance {advance, ledger_id, entry_date, particulars}`.
It sets the order's total advance:

1. **Validate.** The order must be unfulfilled and not booked (the UI hides the action, but
   the server enforces it too). Also check `0 ≤ advance ≤ total`, that the ledger is an
   Asset, that the Orders system ledger exists, and that the date is on or after
   onboarding.
2. **Ledger: post only the difference** between `advance` and what the ledger already holds
   for this order.
   - If the difference is positive: `from = Orders`, `to = ledger` (money received). This is
     today's entry.
   - If it is negative: `from = ledger`, `to = Orders` (money returned, or a correction).
   - If it is zero: no entry. This is also how a failed Shopify step is retried.

   All three use the idempotency-key path of `create_transaction_entry`.
3. **Shopify:**
   - Full (`advance = total`): remove any `Partial Advance:` tag, then `orderMarkAsPaid`.
   - Partial (`0 < advance < total`): set `Partial Advance: <advance>`, replacing any
     earlier one.
   - Zero: remove the tag.
4. **Local:** set `advance_amount`, recompute the advance status, and publish
   `orders_changed`.

**Failure between steps 2 and 3.** If the Shopify call fails after the ledger entry is
saved, return a warning and keep the entry, because the money really did arrive. The dot
then shows the mismatch. Saving the same amount again posts nothing to the ledger and
retries Shopify.

**Why a tag, not a Shopify payment (tested 2026-09-25 on #14204).** `orderCreateManualPayment`
exists on our `2024-07` API version, but Shopify refuses its `amount` argument unless the
store is on **Shopify Plus**: "The API client must be installed on a Shopify Plus store to
use the amount field." The call failed before it wrote anything, and the order is
unchanged. The admin screen's Mark as paid is full-only too. A discount is also rejected as
the record, because it lowers the sale and gets confused with real discounts.

## Changes needed outside the popup

- **The sync rule for `advance_amount`** (`shopify_sync._reconcile_one_order`), checked in
  this order:
  1. A `Partial Advance: N` tag gives `N`.
  2. Otherwise, `paid` without the `Settled` tag gives `total`.
  3. Otherwise, `0`.

  A full advance that later gets `Settled` would fall through to 0 under this rule.
  Settlement only happens after delivery, though, and by then `freeze_advance` has already
  locked the value, so it is never re-derived.
- **Every discount lowers `total_amount`.** Today a discount only lowers the total when
  its code is in `PRICE_REDUCTION_DISCOUNT_CODES`. Any other discount leaves the total as
  it is and is counted as the advance instead, so the CoD still comes out as the net price.
  Once discounts stop being advances, the fulfillment-based total has to subtract all
  discounts, or the CoD is overstated. `PRICE_REDUCTION_DISCOUNT_CODES` and its branch are
  then deleted. Check this against the double-subtraction fix in `2e49a72`.
- **Advance totals net out returns.** `fetch_transaction_advance_totals` sums only
  `from = Orders` entries. It must subtract `to = Orders` entries that carry an
  `order_number`, so that a reduced advance still reconciles.
- **Courier settlement: no change.** `mark_order_settled` records `total_outstanding`.
  - A partial advance leaves Shopify owing the full total, so the full total is recorded
    at settlement. Advance plus payout really does make up that total.
  - A fully paid order has nothing outstanding and is only tagged.
  - Orders with no pending checkout sale, like #14204, are only tagged, both today and
    after this change.
- **One-off migration script** for orders in progress that carry a discount-as-advance,
  meaning orders not yet frozen: unfulfilled or fulfilled.
  - Tag each one `Partial Advance: <discount>`.
  - For **unfulfilled** orders, also remove the discount in Shopify. Their total is still
    re-derived from `current_total_price`, which is net of the discount, so leaving it
    there would subtract the advance twice.
  - Fulfilled orders already have a frozen gross total, so they only need the tag.
  - Their ledger entries were posted by hand through the Transaction Entry modal and are
    left as they are.
  - Run it once, when the new sync rule goes live.
- **Tests.**
  - One sync test: `Partial Advance: 1500` survives a re-sync, a plain discount lowers the
    total, and neither counts as an advance.
  - One endpoint test: it rejects `advance > total`, rejects a booked order, and a lower
    amount posts a return entry.

## Open questions

1. **Editing a full advance down to a partial one.** `orderMarkAsPaid` can't be undone
   through the API except as a refund of that manual payment. That would leave the order
   `partially_refunded` in Shopify. The sync then reads the `Partial Advance` tag, so the
   figures stay correct, but the order's payment status in Shopify reads oddly. Options:
   - (a) Refund through the API when editing down (recommended; add it to the deferred
     tests).
   - (b) Block editing below the total once an order is fully paid.
2. **Removing a discount in Shopify for the migration** needs the order-editing API
   (`orderEditBegin` → remove discount → `orderEditCommit`). Removing a discount this way
   has not been checked on our API version. If it isn't available, the fallback is to
   remove those few discounts by hand in the admin before the script runs.

# Receive Advance from the Orders Grid — Plan

Status: implemented (2026-09-26). Not yet released: the deferred Shopify tests and the
migration run are still to do.

| Piece | Where |
|---|---|
| Popup | `frontend/src/pages/orders/ReceiveAdvanceModal.tsx`, row action in `ordersPolarisColumns.tsx` |
| Endpoint | `PUT /orders/{id}/advance`, `set_order_advance` in `backend/app/routes/orders.py` |
| Shopify tag / mark paid | `set_advance_tag`, `mark_order_paid` in `backend/app/shopify.py` |
| Sync rule | `derive_total_and_advance` in `backend/app/services/shopify_sync.py`, also used by force sync |
| Net ledger totals | `fetch_transaction_advance_totals` in `backend/app/advance_status.py` |
| Migration | `backend/scripts/migrate_discount_advances.py` (dry run by default, `--apply` writes) |

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
| Where the advance is recorded in Shopify | **Partial:** a `Partial Advance: <amount>` tag, and nothing else. **Full:** the order is marked paid and tagged `Advance Paid`; the sync reads that tag as the whole total. Partial payments can't be recorded through the API without Shopify Plus (see "Why a tag"). |
| Discount-as-advance | **Retired.** Every discount becomes a real price reduction, and only the tag or the paid status counts as an advance. |
| Orders in progress that use discount-as-advance | Converted by a **one-off script** |
| When an advance can be received or edited | **Only before the courier is booked.** The COD amount is fixed at booking, so once an order has a courier or tracking number, the action is hidden and the endpoint refuses it. |
| Overpayment | **Rejected.** The advance can never exceed the order total. |
| Undo | **Edit it again**, for partial advances only. The same popup reopens with the current advance, and saving a lower amount (down to 0) reverses the difference. There is no separate reverse action. |
| Full advance | **Final.** It can never be refunded or edited down. Once `advance = total`, the action is hidden and the endpoint refuses it, so Shopify's paid status never has to be undone. |
| Orders not in Shopify | **Not a case.** Every order comes from Shopify. An order with no Shopify ID is an error, not a separate path. |
| Tests on Shopify (`orderMarkAsPaid`, tag round-trip, discount removal) | **Deferred.** They are run before this ships, not now. |
| Other ways to set an advance | **Removed.** The inline Advance cell in the Orders grid becomes read-only. The Transaction Entry modal's "Order Advance Amount" checkbox and the `Order#` bulk-entry shorthand go away. The popup is the only way to record an advance. |
| Force sync | **Same per-order logic as the normal sync.** It exists only to catch orders whose Shopify `updated_at` never moved, so it differs only in which orders it fetches. |
| Ledger name | **Customer Advances**, renamed from "Orders" (`20260926000000_rename_orders_ledger_to_customer_advances.sql`). The internal key stays `orders`; the ledger only ever holds customer advances. |
| Sequencing | **Implementation first, then the migration script**, in the same change. The script reuses the tag helper and runs at release, straight after the new sync rule is live. |

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

**UI.** The row menu gets **Receive advance**, or **Edit advance** once the order has a
partial one. It is shown only for orders that are unfulfilled, not cancelled, not booked
and not fully paid. It opens a
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

1. **Validate.** The order must be unfulfilled, not booked and not already fully paid (the
   UI hides the action, but the server enforces it too). Also check `0 ≤ advance ≤ total`, that the ledger is an
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
   - Full (`advance = total`): replace any `Partial Advance:` tag with `Advance Paid`, then
     `orderMarkAsPaid`. The tag goes first, so a webhook caught between the two writes still
     reads the full advance.
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
  1. An `Advance Paid` tag gives `total`.
  2. Otherwise, a `Partial Advance: N` tag gives `N`.
  3. Otherwise, `paid` without the `Settled` tag gives `total`.
  4. Otherwise, `0`.

  Both tags come before the paid check, so a later `Settled` tag can't drop an advance.
- **The rule is duplicated.** `/orders/sync-shopify-force` (`routes/orders.py`, around
  line 1600) re-implements the same total/advance derivation. Its only purpose is to catch
  orders skipped because their `updated_at` didn't change, so it moves onto the same
  derivation helper in `shopify_sync`, and the two paths can't drift apart.
- **Remove the other advance writers.**
  - Make the Advance column in `ordersPolarisColumns.tsx` plain text, dropping
    `EditableAmount`. Drop the `advance_amount` special case in `OrdersPage.tsx`'s save
    handler if nothing else uses it.
  - In `TransactionEntryModal.tsx`, remove the `isAdvance` checkbox, the order-number
    field, the `Order#` help text and the `orderAdvanceParticularPlaceholder` path if it
    has no other caller.
  - Remove the `Order#` / `Orders <n>` resolution in `transactionsBulkEntry.ts`.
  - Existing advance entries and `advance_status` keep working unchanged.
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
- **One-off migration script**, run once when the new sync rule goes live. Its targets
  are orders whose advance can still re-sync (unfulfilled or fulfilled) and whose advance
  comes from a discount, meaning `0 < advance_amount < total_amount`. Orders fully paid
  at checkout need nothing, because `paid` still maps to `total`.
  - **Fulfilled:** tag only, `Partial Advance: <advance_amount>`. Their total is already
    frozen at the gross price, so the discount left in Shopify is never subtracted again.
  - **Unfulfilled:** tag, and remove the discount **by hand** in Shopify admin; the
    script flags each one. Their total is still re-derived from the discounted
    `current_total_price`, so leaving the discount would subtract the advance twice. The
    order-editing API (`orderEditBegin` → `orderEditRemoveDiscount` → `orderEditCommit`,
    present on `2024-07`) was left unautomated because none existed and it is untested.
  - **Scope: orders on or after `onboarding_date`.** Pre-onboarding orders (below about
    #5000) are out of scope, and the script filters by the org's onboarding date, not by
    an order-number cutoff.
  - **Every in-scope candidate is converted**, whatever its ledger status. Ledger
    mismatches are cleaned up separately, by hand.
  - Ledger entries already posted through the Transaction Entry modal are left as they
    are.
  - **Snapshot on 2026-09-25:** 3 in-scope candidates, all fulfilled, so the
    discount-removal branch would not run today.

    | Order | Tag | Ledger (to fix later) |
    |---|---|---|
    | #13321 | `Partial Advance: 10000` | matches |
    | #13963 | `Partial Advance: 4298` | no entry |
    | #14066 | `Partial Advance: 4798` | 9,594 (looks posted twice) |

    Run it again at release, since new orders may come in with discount-advances before
    then.
- **Tests.**
  - One sync test: `Partial Advance: 1500` survives a re-sync, a plain discount lowers the
    total, and neither counts as an advance.
  - One endpoint test: it rejects `advance > total`, rejects a booked order, and a lower
    amount posts a return entry.

## Open questions

None block implementation.

1. **Deferred Shopify tests** to run before release: `orderMarkAsPaid` on an order with
   no transactions, a tag round-trip, and `orderEditRemoveDiscount` on a discount applied
   at checkout. The last only matters if an unfulfilled order has a discount-advance at
   release.

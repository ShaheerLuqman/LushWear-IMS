# Pre-Onboarding Courier Reconciliation — Plan

Status: design settled, not yet implemented. Supersedes the "Deferred: Shopify
window and the pre-onboarding courier tail" section of
`ONBOARDING_DATE_PLAN.md`.

## Problem

At onboarding an org has a tail of orders already dispatched with the courier
but not yet settled. Nothing before `onboarding_date` may be posted (the
`enforce_onboarding_cutoff` trigger), so those orders carry no receivable — yet
the cash for them arrives *after* onboarding and will credit the courier ledger.
Without a matching debit the courier ledger drifts negative, with no record of
why money was received.

## Decisions taken

| Question | Decision |
|---|---|
| What "pre-onboarding remaining orders" is | A **courier bill** (`shopify_courier_bills`), one per courier |
| What carries the receivable | The **bill's own posting**, receivable leg only — no opening balance for the courier ledger |
| What the posting credits | **Opening Balance Equity** — not Sales Revenue, not COGS/Inventory |
| `journal_orders_from` | **Removed.** Every reader switches to `onboarding_date`; see the removal section for what must survive it |
| Expected DC / withholding tax | **Not estimated.** Recognised when the real settlement arrives |
| Window | **60 days before `onboarding_date`** (matches `SHOPIFY_SYNC_WINDOW_DAYS`); older unsettled orders join the bill only if they later settle |
| Order history | On onboarding, **fetch all orders from Shopify**, no window floor, so old orders always have records |
| Uploaded CSVs | Mark orders settled (write back DC/tax), but **create no payout rows** |
| Inventory / COGS | **Untouched by this flow.** The Inventory opening balance is the plain physical stock count at onboarding |
| Upload location | **Settings → Couriers**, per courier |
| Courier coverage | **PostEx first**, but built per courier: more CSV-settled couriers are coming, so the parser is selected by courier rather than hardcoded |
| Re-uploading | **Rebuilds**: detach the bill's orders, re-classify from the CSVs, re-post |

Two earlier answers are superseded by these and are noted so they aren't
re-litigated: a per-courier configured DC/WHT rate is no longer needed (nothing
is estimated), and no opening balance is computed for the courier, withholding
tax or delivery charge ledgers.

## The posting

`post_courier_bill_journal` currently posts three legs: Dr courier receivable,
Dr Orders (advances), Cr Sales Revenue. It no longer touches COGS or Inventory —
those moved to the period-level `order_cogs_period` posting in
`20260913040000_cogs_inventory_period_completion.sql`, so the earlier worry about
stock being reduced twice by this bill does not apply. (Those period entries are
dated at each period's start, so for pre-onboarding months the cutoff trigger
drops them anyway.)

Two of the three legs are still wrong for a pre-onboarding bill:

- **Sales Revenue** would recognise pre-onboarding sales in the first
  post-onboarding month. Their profit belongs in opening equity.
- **Advances** were collected before onboarding, so they sit in opening cash
  rather than as an outstanding liability to relieve.

So a pre-onboarding bill posts two legs only:

```
Dr  <courier ledger>            SUM(total_amount - advance_amount)
Cr  Opening Balance Equity      same
```

Implementation: a `is_pre_onboarding BOOLEAN NOT NULL DEFAULT FALSE` column on
`shopify_courier_bills`, and a branch in `post_courier_bill_journal` that posts
these two legs. The `journal_orders_from` gate is skipped for such a bill: it is
dated at the onboarding date by construction, and an org whose cutover still
sits later (the `GREATEST` rule below) would otherwise silently get no
receivable at all. Everything
else about the bill — appearing in the Courier Payment Report, its order list,
its totals, re-posting on edit — is unchanged, which is the whole point of using
a bill rather than a bare opening balance.

Cancelled orders are excluded from the sum, matching the existing posting.

Each enabled courier gets its own upload row and its own bill. PostEx is the
only parser that exists today (`services/postex.py`); the flow looks the parser
up by courier id and shows couriers without one as unsupported rather than
hiding them, so adding a courier later is a parser plus a registry entry.

## Flow

1. **Onboarding sets the date**, then the admin runs a **one-off history
   backfill** (§ below) to pull orders older than the regular sync window.
   Orders then exist for all history; none of them post anything, because their
   dispatch dates precede `onboarding_date`.
2. **Admin uploads the courier's CPR CSVs** covering the trailing 60 days, from
   that courier's row in Settings → Couriers.
3. **Parse and classify** each order in the window (reusing
   `services/postex.py`, which already parses CPR CSVs and matches on tracking
   number / order number):
   - appears in a CSV → **settled pre-onboarding**. Write its delivery charge
     and tax back onto the order and mark it settled. No payout row, no posting:
     the money arrived before onboarding and is part of the opening cash
     position, not of this bill.
   - does not appear → **remaining**. Goes on the bill.
   - appears in a CSV but was dispatched *before* the 60-day window → also goes
     on the bill, so the cash received against it has a receivable to clear.
     This is the case that otherwise drives the courier ledger negative with no
     record of why the money arrived.
4. **Create one courier bill per courier**, `pickup_date = onboarding_date`
   (it must be on or after the cutoff or the trigger drops its posting), holding
   every order from the "remaining" classifications above. Attach orders by
   setting their `courier_bill_id`.
5. **Post it** via `post_courier_bill_journal(bill_id)`.
6. **Report back**: order count and gross COD. (No cost-price figure is needed —
   Inventory is not touched by this flow.)

Afterwards, normal operation: post-onboarding CPR uploads settle these orders
through the existing machinery, clearing the receivable this bill created.

## History backfill

**Orders only** - it is a Shopify order sync reaching further back, nothing to do
with couriers, CSVs or postings. A separate, admin-triggered endpoint rather than
widening the regular sync:
`_compute_sync_window_start`'s 60-day floor and the incremental checkpoint stay
exactly as they are, so the routine sync keeps its current cost and its lock
window. The backfill fetches orders older than that floor, upserting through the
same order-reconciliation path the sync already uses.

- Runs on demand (part of onboarding, re-runnable), not on every sync.
- Takes a `from` date; default is the org's earliest Shopify order, i.e. all
  history.
- Must not advance the sync checkpoint (`shopify_sync_status.last_synced_at`) —
  it is reaching backwards, and moving the checkpoint would skip recent orders.
- Long-running for a large store, so it reports progress/page counts rather
  than blocking a request indefinitely.
- Nothing it imports posts anything: every order it reaches is dated before
  `onboarding_date`, so the cutoff trigger drops any posting attempt.

## Keeping `assign_courier_bills` off this bill

`assign_courier_bills` computes bill membership from each order's own pickup
date and moves orders onto the bill matching `(courier, pickup_date)`
(`20260830030000_courier_bills.sql`). The pre-onboarding bill is dated
`onboarding_date` while its orders were picked up earlier, so the next run —
every sync and every CPR upload calls it — would **move every order out of it**,
emptying the bill and silently zeroing its posting on the next re-post.

The function already skips orders sitting on a bill with `status = 'settled'`
(they come back in its `blocked` list). Rather than overload that status, the
same skip is extended to `is_pre_onboarding` bills: two clauses alongside the
existing settled checks. Without this the whole flow quietly undoes itself.

## Keeping `assign_courier_payouts` off pre-onboarding folios

`assign_courier_payouts(p_org_id)` is **org-wide**, not scoped to the upload that
calls it: it creates a payout row for every settled order with a non-empty
`folio`. Marking pre-onboarding orders settled and writing their folio would
therefore see payout rows created for them by the next ordinary CPR upload,
silently undoing the "no payout rows" decision.

Fix: skip payouts whose derived date falls before `onboarding_date` — one clause
on the INSERT, using the date the function already computes from the folio. This
covers CSV-settled orders too, which stay on their original pickup-date bills
and so are *not* reachable by the `is_pre_onboarding` bill check. Leaving `folio`
empty would also work but throws away the record of which CPR settled the order.

Those payouts would post nothing anyway (the cutoff trigger drops a voucher dated
before onboarding), so the harm is rows that exist with no accounting behind
them - exactly the "money with no explanation" this plan exists to prevent.

## Rebuilding on re-upload

Uploading again rebuilds rather than merges:

1. detach every order currently on the bill (`courier_bill_id = NULL`),
2. re-classify from the newly uploaded CSVs,
3. re-attach and call `post_courier_bill_journal`, which rewrites both legs from
   the bill's current contents.

Nothing is lost by this. Bill membership has no manual-edit path to clobber —
there is no endpoint that moves an order between bills — and order-level
corrections (amounts, cost price, status) live on the order rows, which
detaching does not touch. The bill's own `notes` and `status` are preserved by
updating the existing row rather than deleting and recreating it.

## Editing the bill later

`post_courier_bill_journal` deletes the bill's existing `courier_bill_sale`
entry and recomputes it from the orders currently linked to the bill, so adding
an order later and calling it again rewrites the entry to the new totals — no
adjusting entry, no manual correction. It is **not** automatic on order change
(no trigger on `shopify_orders.courier_bill_id`), so any flow that attaches an
order to this bill must call it explicitly. `post_courier_bills_journal(org_id,
bill_ids)` is the batch form.

## Removing `journal_orders_from`

`journal_orders_from` is the original, narrower version of the same idea, added
with the sales-journal posting (`20260910010000_sales_journal_posting.sql`):
*"Cutover. Orders dispatched before this post nothing, so a pre-cutover order
that settles after it cannot credit a courier receivable that was never
debited."* `onboarding_date` now covers that and more — all three finance tables
rather than order/courier postings only, blocking writes rather than silently
skipping them, and admin-visible. Keeping both invites them to disagree, so the
column is **removed and every reader switched to `onboarding_date`**.

Two things must survive the removal.

**1. The payout member filter is not redundant.** In
`post_courier_bill_journal` the `pickup_date < journal_orders_from -> RETURN`
gate only decides whether to post, which the cutoff trigger would also do (it
drops any insert dated before `onboarding_date`). But in
`post_courier_payout_journal` the `>= journal_orders_from` filter decides **which
orders' amounts are aggregated** — something a trigger cannot do, because the
voucher it guards is dated *after* onboarding and posts legitimately. Drop that
filter and a post-onboarding payout containing pre-onboarding members would
include their COD in the clearing and cash legs, crediting a receivable that was
never debited. It stays, keyed on `onboarding_date`, with the
`is_pre_onboarding` exemption described above.

**2. NULL means the opposite of the old default.** `journal_orders_from` is
`NOT NULL DEFAULT '2026-01-01'`; `onboarding_date` is nullable and NULL means
*no cutoff at all*. An org with a NULL onboarding date would therefore lose its
2026-01-01 cutover the moment the column is dropped, re-opening its whole
history to posting. The removal migration must backfill first:

```sql
UPDATE system_organizations
   SET onboarding_date = journal_orders_from
 WHERE onboarding_date IS NULL;
```

with one caveat that makes this more than a mechanical copy: the two dates do
not mean the same thing. `journal_orders_from` gated only order/courier
postings, while `onboarding_date` blocks transaction entries, journal entries
and bills as well. An org holding manual entries or bills before that date would
suddenly have rows sitting before its own cutoff — the state
`set_org_onboarding_date`'s "not later than the earliest existing entry" check
exists to prevent, with a mis-sorted opening voucher as the visible symptom.

So the backfill applies only where it is safe (no finance rows before
`journal_orders_from`), and any org failing that check is reported for a
deliberate decision — pick an earlier date, or purge forward — rather than
migrated silently.

Once the column is gone, `set_org_onboarding_date` no longer mirrors anything
and the `GREATEST` rule disappears with it: there is one date, and it is the one
the admin sets.

Reference state: LushWear has been purged to `2026-01-01`, with
`onboarding_date = journal_orders_from = 2026-01-01`, so it needs no backfill
and no manual review.

## Returns on pre-onboarding orders

An order on the pre-onboarding bill that is **returned** after onboarding would
post `Dr Sales Return / Cr courier` through the normal payout voucher. Its sale
was never recognised as revenue (the bill credits Opening Balance Equity), so the
first post-onboarding P&L would show a return with no matching sale.

**Decided:** those returns post to **Opening Balance Equity** instead, mirroring
where their sale went. The return leg therefore splits by membership:

```
Dr  Sales Return              returned parcels NOT on a pre-onboarding bill
Dr  Opening Balance Equity    returned parcels ON a pre-onboarding bill
Cr  <courier>                 the two combined
```

`journal_line` drops zero-value lines, so an ordinary payout still produces the
same two-line voucher it does today.

Delivery charges and withholding tax deliberately stay as expenses even for these
parcels: they are deductions the org first learns about when the CPR arrives, and
are recognised then (the "gross receivable only" decision above).

## Two more places the pre-onboarding bill breaks an assumption

Both found while working through the fixes above; neither is optional.

**1. The payout voucher excludes pre-cutover members.**
`post_courier_payout_journal` filters its members to
`COALESCE(courier_pickup_date, fulfilled_at) >= journal_orders_from`, commented
as "a member whose bill was never posted (dispatched before the cutover) has no
COD on the courier account to clear". That is true of every other bill and
**false** for this one — the pre-onboarding bill posts that COD deliberately. Left
as is, settlements would never clear the receivable it created, and the courier
ledger would carry it forever. The filter must also admit orders whose bill is
`is_pre_onboarding`.

**2. The empty-bill cleanup would delete it mid-rebuild.**
`assign_courier_bills` ends by deleting every `open` bill with no orders left on
it. A rebuild (§ "Rebuilding on re-upload") detaches every order before
re-classifying, so the pre-onboarding bill is empty at exactly that moment and
would be deleted underneath the flow. The cleanup must skip `is_pre_onboarding`
bills.

## Upload order does not matter

A CSV is treated by **its own payout date**, not by when it happens to be
uploaded, so there is no required sequence between this flow and ordinary CPR
uploads:

| CSV payout date | Treatment |
|---|---|
| on/after `onboarding_date` | normal processing — payout row, vouchers, the lot |
| within the 60 days before `onboarding_date` | pre-onboarding window: settles its orders and rebuilds the bill (below). No payout row, no vouchers |
| older than that window | settle the orders on the table only. No payout row, no vouchers, no effect on the bill |

The last two are already covered by the `assign_courier_payouts` date filter:
anything dated before `onboarding_date` creates no payout row and therefore
posts nothing. The only difference between them is whether the settlement
re-classifies orders for the bill.

A window CSV arriving *after* the bill was built simply rebuilds it (§
"Rebuilding on re-upload"): the orders it settles are no longer owed, so they
come off the bill and the receivable shrinks on the re-post. That also removes
the risk of the bill being built against already-settled data — it is rebuilt
from whatever is true at the time.

## Stale pre-onboarding orders join the bill when they settle

The bill starts as the **60-day window only**: orders dispatched earlier and
still unsettled at onboarding are left off it. Most never pay out, and booking a
receivable for them would be inventing an asset.

But if one later *does* settle, it is **added to the bill at that moment**. Its
cash is real, so it needs a receivable to clear, and the alternative - the
payout voucher's member filter silently dropping it - means the CSV's NET_AMOUNT
lands in the bank while the posting records less, with nothing to flag it.

So a post-onboarding CPR upload, before it assigns and posts payouts:

1. finds settled orders dispatched before `onboarding_date` that are not already
   on a pre-onboarding bill,
2. attaches them to that courier's pre-onboarding bill (creating it if the org
   never ran the onboarding flow),
3. re-posts the bill, growing `Dr courier / Cr Opening Balance Equity` by their
   COD.

Only then do `assign_courier_payouts` and `post_courier_payout_journal` run, so
the receivable exists before the voucher clears it. The member filter admits
them automatically once they are on an `is_pre_onboarding` bill.

No inventory or COGS: that month's stock movement was never in these books, and
the bill posts two legs only. It works out to zero either way -

- **delivered**: bill debits the courier, the payout credits it and lands the
  cash; the revenue stays in opening equity.
- **returned**: bill debits the courier, the payout's return leg credits it
  against Opening Balance Equity (see above), so both sides net to nothing.

### Interaction with rebuilds

"Rebuilding on re-upload" detaches every member before re-classifying from the
uploaded CSVs. An order accreted this way was settled by a *post-onboarding* CSV,
so it will not appear in the window CSVs a rebuild reads, and a naive rebuild
would drop it - leaving its payout voucher clearing a receivable that no longer
exists, and the courier ledger negative by its COD.

A rebuild must therefore detach only members that no payout has cleared, and
leave accreted, already-settled members in place.

## Resolved, recorded so they are not re-litigated

1. ~~`is_order_settled` semantics~~ — **checked, not a problem.** Nothing joins
   orders to payouts for display: the Courier Payment Report's `settled_count`
   derives from `is_order_settled` + `delivery_charge > 0` + resolved status, and
   the one Python path reading `courier_payout_id` filters NULLs explicitly. The
   real risk was `assign_courier_payouts` creating the rows later (see above).

2. ~~Timing / upload order~~ — resolved by keying every CSV off its own payout
   date; see "Upload order does not matter".

3. ~~Which couriers~~ — PostEx first, parser looked up by courier.

4. ~~Estimated DC/WHT rates~~ — nothing is estimated; they are recognised when
   the real settlement arrives.

**Nothing is open. The design is ready to implement**, in dependency order:
`journal_orders_from` removal -> mandatory `onboarding_date`
(`ONBOARDING_DATE_PLAN.md` §7) -> the bill's DB layer (column plus the four
function changes) -> CSV upload flow and Settings -> Couriers UI -> the history
backfill endpoint.

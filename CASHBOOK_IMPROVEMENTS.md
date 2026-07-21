# Cashbook & Ledger — improvements

All open cashbook/ledger work items, moved here from `TODO.md` (2026-07-21)
so cashbook/ledger work has one home instead of being split across two docs.

Part one is a robustness review comparing the implementation against
established open-source double-entry systems (Firefly III, Akaunting,
beancount/hledger, the Medici library) — dated 2026-07-21, ranked by
effort-to-value. Part two is everything else open on the cashbook/ledger
surface.

---

# Part 1: Robustness review

## 1. Transaction atomicity — the two sides of an entry aren't linked

Every open-source ledger checked groups the two legs of a transaction under
one parent record:
- Firefly III: a `transaction_journal` (the logical transaction) has N
  `transactions` (the legs) underneath it.
- beancount/hledger: a transaction *is* a list of postings that must sum to
  zero — enforced at parse time. It's structurally impossible to write an
  unbalanced one.

`cashbook_entries` has no equivalent — each row is independent, with no
`transaction_id`/`journal_id` linking the paired inflow/outflow rows
(`supabase_schema.sql` ~122-134).

Worse, the actual write path for the "Create Cashbook Entry" modal fires
**two separate HTTP POSTs** in parallel
(`Promise.all(requests)` — `frontend/renderer.js:4133`), each hitting the
single-row `POST /cashbook/entries` endpoint. If one succeeds and the other
fails (network blip, one side fails validation, tab closes mid-flight), the
result is a real half-written transaction with no way to detect it later —
money leaves one ledger with no corresponding arrival in the other, or vice
versa. Same pattern in the order-advance modal (`renderer.js` ~4220-4221).

**The fix already exists in the codebase and isn't being used here.**
`POST /cashbook/entries/bulk` (`backend/app/routes/cashbook.py:91-116`) does
a single batched `.insert(payloads)` — one SQL statement, genuinely atomic —
built for the bulk-text-entry modal. Routing the two-sided entry modal (and
the order-advance modal) through that same endpoint instead of two parallel
`/entries` calls would close this gap with no new backend code, just
reusing what's already there.

Related precedent: the *daily balance* side of cashbook writes already went
through exactly this kind of atomicity fix — see "Cashbook entry + balance
recalculation" (Done, 2026-07-20) in `TODO.md` §"Sync performance &
concurrency" #5. That moved balance recalculation into a DB trigger so it
fires for every writer, not just the API. This item is the remaining piece:
the *entry* side (the paired inflow/outflow rows) still isn't atomic.

- [ ] Change `submitCashbookEntry`/order-advance submit to build both
      payloads and POST them together via `/cashbook/entries/bulk` instead
      of `Promise.all` of two `/entries` calls.

---

## 2. Account typing via string-matched special cases, not a real type field

Real systems assign every account a **type** (Asset/Liability/Equity/
Revenue/Expense) with a defined normal-balance sign, and one shared formula
applies uniformly across all accounts of that type.

`ledgers.section` is free text, used both for **display grouping** and,
via `if section == 'Bank'` string checks scattered across three places in
`frontend/renderer.js` (`updateCashInHand()` ~4702-4706,
`renderLedgerDetailGrid()` ~5038-5058), for actual **balance-sign behavior**.
This is the root cause of the Bank inversion issue in Part 2, item 10 —
mixing "what bucket does this ledger display under" with "which direction
does its balance move" in one free-text field, matched by literal string
comparison instead of a real type-driven formula.

**Decision (2026-07-21): replace `section` with a `type` field.** This
folds together two motivations that both want to replace the same column:
- Accounting-type values that drive balance-sign math uniformly (replacing
  the `Bank`-only special case): something like Asset/Bank, Expense,
  Revenue/Sales, Equity/Investors.
- **Vendor Payable** / **Vendor Receivable** as their own classification
  (the original motivation, from Part 2 item 9 below) — distinct from the
  per-order receivable reconciliation already in `orders.py`/`renderer.js`.

- [ ] Decide the full `type` value set — must cover both motivations above.
- [ ] Migrate `ledgers.section` → `ledgers.type` in `supabase_schema.sql` and
      backfill existing rows.
- [ ] Update `Ledger`/`LedgerCreate`/`LedgerUpdate` in `backend/app/models.py`
      and the routes in `backend/app/routes/ledger.py`.
- [ ] Update the create/edit ledger `<select>` options and any section-based
      grouping/filtering in `frontend/renderer.js` / `frontend/index.html`.
- [ ] Replace the `section === 'Bank'` special cases in
      `updateCashInHand()` and `renderLedgerDetailGrid()`
      (`frontend/renderer.js`) with logic driven by the new `type`.
- [ ] Check `backend/DATABASE.md` / `backend/BACKEND.md` for references to
      `section` that need updating.

---

## 3. Balance computation ships full history to the browser

Real systems either materialize running balances via a DB trigger (which
this app already does correctly for the **daily cashbook total** —
`recalc_cashbook_daily_balances()` + row trigger, a good pattern) or compute
them server-side with a single indexed/window-function query. Per-ledger
balance doesn't get that treatment.

`updateCashInHand()` (`frontend/renderer.js:4669-4713`) re-fetches full
ledger history on **every** cashbook mutation. For every Bank-section ledger
it calls `GET /ledgers/{id}/entries` with no date filter — the entire
transaction history, every time — then sums a running balance client-side.
It runs on every `reloadCashbookForCurrentDate()` call, which fires after
*each* individual create/update/delete, so deleting N entries in a row
re-fetches all Bank ledgers' full history N times over. Confirmed live via
backend logs: cleaning up 7 test entries fired the 5-ledger fetch 7 times.

Two fixes, increasing effort:
- (a) cheap: only refetch the one Bank ledger the changed entry's `folio`
  belongs to, not all of them — no backend change.
- (b) more correct: move the running-balance computation server-side (one
  aggregate query per ledger, same pattern as the cashbook daily-balance
  trigger work) so the browser stops downloading full transaction histories
  at all.

Not urgent — revisit when ledger history volume makes it visible. This is
also the reason item 7 in Part 2 says to do this before extending the
ledger model further: new ledger surface area builds on this same
N-refetch code path.

---

## 4. No audit trail

`DELETE /cashbook/entries/{id}` (`backend/app/routes/cashbook.py:148-160`)
is a hard delete — no record of who deleted what or when. Firefly
III/Akaunting/QuickBooks all keep an immutable log, or favor reversing
entries over deleting them outright. Already on the broader backlog
(admin portal / audit log in `backend/BACKEND.md` §6) — this confirms it's
a standard feature for financial data specifically, not just a nice-to-have.

---

## 5. No idempotency key on entry creation

No idempotency key on `POST /cashbook/entries` — a double-click or a
retried request after a dropped response creates a duplicate row. Every
payment-grade ledger (Stripe, Modern Treasury) treats this as
non-negotiable. Cheap to add: a client-generated UUID per submission,
unique-constrained server-side, request replayed with the same key returns
the original row instead of inserting again.

---

## Not a gap — already a deliberate, documented decision

**Money as `float` at the API boundary.** The DB column is correctly
`DECIMAL(12,2)`; beancount/hledger use fixed-point/arbitrary-precision
throughout, including at their equivalent of the API boundary. This repo's
`backend/DATABASE.md` already settled this tradeoff deliberately (see
`TODO.md`'s "Settled — do not fix these" note). Leave it alone.

---

## Review priority

Ranked by effort-to-value:

1. **Item 1, transaction atomicity** — cheapest, highest value; reuses the
   existing `/entries/bulk` endpoint, no new backend code.
2. **Item 2, account typing (`section` → `type`)** — decided, not yet
   migrated.
3. **Item 3, balance computation** and **item 4, audit trail** — real gaps,
   bigger investment, already tracked.
4. **Item 5, idempotency** — cheap, but only worth it if duplicate entries
   have actually been observed in practice.

---

# Part 2: Other open items

## 6. Optimize cashbook before extending the ledger model

Do this first, before items 2 (`section` → `type`) or 8. The full-history
refetch on every cashbook mutation (Part 1, item 3 —
`updateCashInHand()`, `frontend/renderer.js:4639`) is the ledger code path
that both would build on. Adding more ledger surface area before fixing the
N-refetch behavior means the new code inherits the same performance problem.

## 7. Create a ledger inline from the cashbook entry form

**Done, 2026-07-21** (commit `c1bc427`, "feat: enhance ledger management
with inline creation and improved dropdown options"). Was: creating a
ledger meant leaving the cashbook entry flow, going to the Ledgers view, and
using `createLedgerModal`.

Implemented as a "+ Create new ledger..." option appended to the end of
each ledger `<select>` (`cashbookEntryInLedger`, `cashbookEntryOutLedger`,
`orderAdvanceOutLedger`) — picking it opens the create-ledger modal inline,
and on save the new ledger is auto-selected in the dropdown that triggered
it without losing the rest of the in-progress entry
(`populateCashbookEntryLedgerSelect`, `handleLedgerSelectChange`,
`frontend/renderer.js`). Also extended to the cashbook grid's per-entry
folio dropdown (`createFolioCellRenderer`) — same "+ Create new ledger..."
row, same auto-select-on-save behavior via a generic
`openCreateLedgerModal(onCreated)` callback shared by both entry points.

## 8. Replace ledger `section` with `type`

See Part 1, item 2 — the decision and full checklist live there since the
robustness review is what drove the final `type` value-set requirements.

## 9. Original motivation for item 8 (Vendor Payable / Vendor Receivable)

Ledgers currently carry a free-text `section` (Bank/Expense/Vendors/Sales/
Investors — `backend/app/models.py:194`, `frontend/index.html` ~308-315).
The original ask was a per-ledger **Vendor Payable** / **Vendor Receivable**
classification, distinct from the per-order receivable reconciliation
already in `orders.py`/`renderer.js` (see
[`backend/BACKEND.md`](backend/BACKEND.md)). Folded into item 8's `type`
field rather than tracked separately.

## 10. Re-examine the Bank section's inverted debit/credit and balance sign

Customer has again asked to "invert" how `Bank`-section ledgers behave. Worth
scrutinizing before touching it again — this has already been flipped twice:

- Commit "Invert debit and credit for bank" (Feb 19) swapped which raw field
  the Debit/Credit columns show for Bank ledgers only
  (`renderLedgerDetailGrid`, `frontend/renderer.js` ~5038-5044: Debit shows
  `incoming`, Credit shows `outgoing`; every other section is the reverse).
- A later commit ("changes") also flipped the running-balance sign for Bank to
  `outgoing - incoming`, both in `renderLedgerDetailGrid` (~5058) and in
  `updateCashInHand()` (~4702-4706), to match.

Standard bookkeeping treats a bank ledger like any other asset/cash account:
Debit (incoming/deposit) increases the balance, Credit (outgoing/withdrawal)
decreases it, so balance = **incoming − outgoing** — exactly the formula every
non-Bank section already uses. Tracing how entries get created (an `IN:` bulk
entry or the Incoming side of `cashbookEntryForm` books an *inflow* to the
named ledger), `incoming` really does mean "money deposited," so the current
`outgoing − incoming` sign for Bank produces the *negative* of actual cash
held — it doesn't match the "your own books" convention, and it doesn't match
the alternative "bank statement" convention either (that one only swaps which
label a movement sits under, it never negates the balance itself).

Before changing anything, pin down which of the two independent flips the
customer actually means:
- [ ] If they mean the **balance sign** (`outgoing - incoming` →
      `incoming - outgoing` for Bank) — this looks like the one worth
      restoring; it would make Bank match every other section and fix what
      currently reads as an inverted cash balance.
- [ ] If they mean the **Debit/Credit column swap** — that's a labeling/
      statement-format preference, not a correctness issue; confirm intent
      before reverting since it doesn't have an obviously "right" answer.

This is the same root cause identified in Part 1, item 2 — once `section` is
replaced with a proper `type`-driven balance formula, this special case goes
away entirely rather than needing a third manual flip.

## 11. Folio dropdown doesn't highlight the currently-selected ledger

`.folio-dropdown-option.selected` (`frontend/styles.css` ~3023) is meant to
highlight the row matching the cell's current folio when the dropdown
reopens, but it isn't showing up visibly in practice. The `l.id ===
currentFolio` check it depends on (`renderOptions()` in
`createFolioCellRenderer`, `frontend/renderer.js` ~2181-2204) mirrors the
comparison used a few lines earlier to compute `displayText`, which does
work, so the match itself isn't obviously broken. `currentFolio` is a
`const` captured once when the cell renderer function runs (~2112) — worth
checking whether it goes stale relative to `params.data.folio` across
dropdown reopens without a full cell re-render, before assuming it's a pure
CSS issue.

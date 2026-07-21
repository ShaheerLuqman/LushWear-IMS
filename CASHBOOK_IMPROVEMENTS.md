# Cashbook & Ledger — improvements

Open cashbook/ledger work items, moved here from `TODO.md` (2026-07-21) so
cashbook/ledger work has one home instead of being split across two docs.

Originated from a robustness review comparing the implementation against
established open-source double-entry systems (Firefly III, Akaunting,
beancount/hledger, the Medici library), dated 2026-07-21. Completed items
(transaction atomicity via `/entries/bulk`, per-ledger balance computation,
idempotency keys, the pre-extending-the-ledger-model cleanup, inline ledger
creation) have been removed from this list as they shipped — see git history
(2026-07-21 commits) for what changed.

---

## 1. Account typing: replace ledger `section` with a `type` field

Real systems assign every account a **type** (Asset/Liability/Equity/
Revenue/Expense) with a defined normal-balance sign, and one shared formula
applies uniformly across all accounts of that type.

`ledgers.section` is free text, used both for **display grouping** and,
via `if section == 'Bank'` string checks scattered across three places in
`frontend/renderer.js` (`updateCashInHand()`, `renderLedgerDetailGrid()`),
for actual **balance-sign behavior**. This is the root cause of the Bank
inversion issue in item 3 below — mixing "what bucket does this ledger
display under" with "which direction does its balance move" in one
free-text field, matched by literal string comparison instead of a real
type-driven formula.

**Decision (2026-07-21): replace `section` with a `type` field.** This
folds together two motivations that both want to replace the same column:
- Accounting-type values that drive balance-sign math uniformly (replacing
  the `Bank`-only special case): something like Asset/Bank, Expense,
  Revenue/Sales, Equity/Investors.
- **Vendor Payable** / **Vendor Receivable** as their own classification —
  distinct from the per-order receivable reconciliation already in
  `orders.py`/`renderer.js`. Ledgers currently carry a free-text `section`
  (Bank/Expense/Vendors/Sales/Investors — `backend/app/models.py`,
  `frontend/index.html` ~308-315); this was the original ask that led to
  the `type` decision above.

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

## 2. No audit trail

`DELETE /cashbook/entries/{id}` (`backend/app/routes/cashbook.py`) is a hard
delete — no record of who deleted what or when. Firefly III/Akaunting/
QuickBooks all keep an immutable log, or favor reversing entries over
deleting them outright. Already on the broader backlog (admin portal /
audit log in `backend/BACKEND.md` §6) — this confirms it's a standard
feature for financial data specifically, not just a nice-to-have.

---

## 3. Re-examine the Bank section's inverted debit/credit and balance sign

Customer has again asked to "invert" how `Bank`-section ledgers behave. Worth
scrutinizing before touching it again — this has already been flipped twice:

- Commit "Invert debit and credit for bank" (Feb 19) swapped which raw field
  the Debit/Credit columns show for Bank ledgers only
  (`renderLedgerDetailGrid`, `frontend/renderer.js`: Debit shows `incoming`,
  Credit shows `outgoing`; every other section is the reverse).
- A later commit ("changes") also flipped the running-balance sign for Bank to
  `outgoing - incoming`, both in `renderLedgerDetailGrid` and in
  `updateCashInHand()`, to match.

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

This is the same root cause identified in item 1 above — once `section` is
replaced with a proper `type`-driven balance formula, this special case goes
away entirely rather than needing a third manual flip.

Note: the per-ledger balance table added 2026-07-21 (`ledger_balances`)
deliberately preserved this sign as-is — it stores the standard
`incoming - outgoing`, and `updateCashInHand()` negates it for Bank ledgers
to match current (likely-wrong) display behavior. Fixing the sign here will
need to account for that negation too.

---

## Not a gap — already a deliberate, documented decision

**Money as `float` at the API boundary.** The DB column is correctly
`DECIMAL(12,2)`; beancount/hledger use fixed-point/arbitrary-precision
throughout, including at their equivalent of the API boundary. This repo's
`backend/DATABASE.md` already settled this tradeoff deliberately (see
`TODO.md`'s "Settled — do not fix these" note). Leave it alone.

# Cashbook & Ledger — improvements

Open cashbook/ledger work items, moved here from `TODO.md` (2026-07-21) so
cashbook/ledger work has one home instead of being split across two docs.

Originated from a robustness review comparing the implementation against
established open-source double-entry systems (Firefly III, Akaunting,
beancount/hledger, the Medici library), dated 2026-07-21. Completed items
(transaction atomicity via `/entries/bulk`, per-ledger balance computation,
idempotency keys, the audit-log trigger, the pre-extending-the-ledger-model
cleanup, inline ledger creation, the folio dropdown highlight bug, the
`section` → `type` migration) have been removed from this list as they
shipped — see git history (2026-07-21 commits) for what changed.

---

## 1. Re-examine the Bank ledger's inverted debit/credit and balance sign

Customer has again asked to "invert" how `Bank`-type ledgers behave. Worth
scrutinizing before touching it again — this has already been flipped twice:

- Commit "Invert debit and credit for bank" (Feb 19) swapped which raw field
  the Debit/Credit columns show for Bank ledgers only
  (`renderLedgerDetailGrid`, `frontend/renderer.js`: Debit shows `incoming`,
  Credit shows `outgoing`; every other type is the reverse).
- A later commit ("changes") also flipped the running-balance sign for Bank to
  `outgoing - incoming`, both in `renderLedgerDetailGrid` and in
  `updateCashInHand()`, to match.

Standard bookkeeping treats a bank ledger like any other asset/cash account:
Debit (incoming/deposit) increases the balance, Credit (outgoing/withdrawal)
decreases it, so balance = **incoming − outgoing** — exactly the formula every
non-Bank type already uses. Tracing how entries get created (an `IN:` bulk
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
      restoring; it would make Bank match every other type and fix what
      currently reads as an inverted cash balance.
- [ ] If they mean the **Debit/Credit column swap** — that's a labeling/
      statement-format preference, not a correctness issue; confirm intent
      before reverting since it doesn't have an obviously "right" answer.

Note: `ledgers.section` was replaced with `ledgers.type` (2026-07-21,
CHECK-constrained to Bank/Expense/Payable Vendors/Receivable Vendors/Sales/
Investors) — the `section === 'Bank'` special cases in `updateCashInHand()`
and `renderLedgerDetailGrid()` (`frontend/renderer.js`) now key off `type`
instead, but the formula itself is untouched: `ledger_balances.balance`
still stores the standard `incoming - outgoing`, and `updateCashInHand()`
still negates it for Bank ledgers to match current (likely-wrong) display
behavior. This item is that formula fix — still open, deliberately deferred.

---

## Not a gap — already a deliberate, documented decision

**Money as `float` at the API boundary.** The DB column is correctly
`DECIMAL(12,2)`; beancount/hledger use fixed-point/arbitrary-precision
throughout, including at their equivalent of the API boundary. This repo's
`backend/DATABASE.md` already settled this tradeoff deliberately (see
`TODO.md`'s "Settled — do not fix these" note). Leave it alone.

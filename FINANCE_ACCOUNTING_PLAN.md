# Finance & Bookkeeping — Review and Plan

Review of the existing Cashbook and Ledgers modules against standard bookkeeping
practice, plus a phased plan to grow them into a complete small-business finance
module.

Reference implementations consulted: **Akaunting** (`D:\code\akaunting`) for the
document/transaction model and screen shapes, **ERPNext**
(`D:\code\erpnext\erpnext\accounts`) for the general-ledger core, period
controls, and report set.

Guiding constraint from the product owner: **keep it simple and easy to
understand.** Every recommendation below is weighed against that — the aim is
books that are *correct* without asking the user to think in debits and credits.

---

## Part 1 — Review of what exists today

### 1.1 How the current system actually works

Worth stating plainly, because it isn't documented anywhere and it drives every
finding below.

`cashbook_entries` is a single table where each row has **one** `folio` (a
ledger) and **one** `entry_type` (`credit` / `debit`). Two different DB functions
read that same row with **opposite signs**:

| Function | Formula | Effect |
|---|---|---|
| `recalc_cashbook_daily_balances` | `closing = opening + Σcredit − Σdebit` | `credit` **increases** the cash pot |
| `recalc_ledger_balance` | `balance = opening + Σdebit − Σcredit` | `credit` **decreases** the folio ledger |

So the system *is* doing double entry — but with an **implicit, invisible cash
account** as the permanent other side of every transaction. Arithmetically it
holds together (the cash closing balance is always exactly the negative of the
sum of all ledger movements). Conceptually it is a **single-entry cashbook**,
and that limitation is the root cause of most of what follows.

---

### 1.2 Findings — contradictions with bookkeeping principles

Ordered roughly by severity.

#### 🔴 A1. Every transaction is forced to touch cash

Because the cash side is implicit and mandatory, there is **no way to record a
non-cash transaction**. The following are all impossible today:

- A credit purchase (goods received now, paid next month)
- A credit sale / any accounts-receivable balance
- Stock write-off, shrinkage, damaged goods
- Depreciation, accruals, prepayments
- Owner capital contributed in kind
- Bad-debt write-off
- Opening AR / AP balances
- A supplier settling a debit note against an invoice

This is the defining limitation of single-entry bookkeeping and is the reason
the purchase-bill gap you already identified cannot be closed without changing
the core model first.

#### 🔴 A2. `debit` / `credit` are used with the reversed sense on the cash side

In standard bookkeeping, **cash received is a debit to cash**. In a traditional
handwritten cash book, the *receipts* page is the **debit** side.

Here, `entry_type = 'credit'` means money **in**, and it increases
`cashbook_daily_balances.closing_balance`. The column names on that table are
`total_credit` / `total_debit` — cash-side columns carrying folio-side labels.
The UI then presents `credit` under "Incoming"
([cashbook.js:42](frontend/js/cashbook.js#L42)).

The naming is internally defensible (you are crediting the *Sales* ledger, and
cash is debited), but the labels are attached to the wrong side of the ledger in
the table and on screen. Anyone with bookkeeping training reading the Cashbook
screen or querying `cashbook_daily_balances` will read it exactly backwards.

**Fix — decided: `debit` / `credit` everywhere, no loose terms.**
"Incoming" / "Outgoing" are removed from the UI, the API payloads, and the JS
internals. Because the cashbook's columns are *cash-side*, the textbook mapping
applies: **receipts are the Debit side, payments are the Credit side.** That is
the reverse of what `cashbook_daily_balances.total_credit` / `total_debit`
currently hold, so those two columns are swapped in the same change — which is
what actually closes this finding rather than relabelling around it.

⚠️ **The one sharp edge, until Phase 1.** `entry_type` is written from the
*folio ledger's* perspective (`credit` = credit the folio, so cash came in).
After this change a row with `entry_type = 'credit'` renders under **Debit** on
the cashbook and under **Credit** on the ledger statement. Both are correct —
they are two different accounts — but this must be commented in exactly one
place or it will be read as a bug and "fixed" into a real one. Phase 1 dissolves
it: each side becomes its own journal line carrying its own account and its own
debit-or-credit, so no label ever has to describe two accounts at once.

#### 🔴 A3. All ledger balances are stored debit-positive regardless of nature

`recalc_ledger_balance` applies `opening + Σdebit − Σcredit` to **every** ledger,
and the migration comment states nature "drives display grouping only"
([20260729000000_ledger_type_nature.sql](supabase/migrations/20260729000000_ledger_type_nature.sql)).

Consequence: **Revenue, Liability and Equity ledgers always display as negative
numbers.** A Sales ledger with Rs 500,000 of sales shows **−500,000**. A supplier
you owe Rs 50,000 shows **−50,000**. An investor who put in Rs 1,000,000 shows
**−1,000,000**.

This contradicts the normal-balance convention (Asset/Expense = debit-normal;
Liability/Equity/Revenue = credit-normal) and makes the ledger list unusable as
a trial-balance substitute.

**Where this is actually visible:** narrower than it first appears.
`renderLedgerCards` does not render balances at all — the ledger list shows only
names. The single affected surface is the **Balance column of the ledger detail
grid**, where [ledgers.js:519-524](frontend/js/ledgers.js#L519-L524) already
works around the problem by inverting the red/black colour test for
credit-normal natures. That workaround is evidence of the design flaw, not a
fix: the number itself is still shown negative.

**Fix:** keep the signed debit-positive value in storage (that part is correct
and worth preserving) but **present** per nature — flip the sign for
credit-normal accounts so the number shown is always positive, and append a
`Dr` / `Cr` suffix to carry the direction. Once the sign is corrected, the
inverted `cellStyle` test collapses to a plain "negative is bad" rule.

#### 🔴 A4. `ledgers.opening_balance` has no contra entry — the books stop balancing

`opening_balance` is a number on the ledger row, folded into `ledger_balances`
by trigger, but **never posted to the cashbook and never offset against
anything**. The moment any opening balance is entered, the identity
`cash = −Σ(ledger movements)` breaks and the books no longer balance.

Standard practice: opening balances are entered as **one opening journal entry**
whose balancing figure goes to *Opening Balance Equity* / retained earnings, and
that entry must balance like any other.

Two aggravating factors:
- `opening_balance` is freely editable at any time via `LedgerUpdate`
  ([models.py:246](backend/app/models.py#L246)), silently restating every
  historical balance with no audit record.
- It is also double-counted into "Cash In Hand" for any ledger flagged
  `include_in_cash_in_hand` (see B3).

#### 🔴 A5. There is no trial balance — no way to prove the books balance

No report anywhere sums debits and credits and demonstrates they are equal. This
is the single most basic bookkeeping control and its absence means an error can
sit in the data indefinitely with nothing to surface it.

#### 🟢 B1. Ledger statement columns — misleading field names only, not a display bug

*Corrected after reading the grid definition — an earlier draft of this review
overstated this finding.*

[ledger.py:167-169](backend/app/routes/ledger.py#L167-L169) maps
`credit → incoming` and `debit → outgoing`, which reads like a cash-side
mislabelling. It isn't, on screen: the grid binds
`Debit (Rs) → outgoing` and `Credit (Rs) → incoming`
([ledgers.js:493-505](frontend/js/ledgers.js#L493-L505)), so a debit entry
appears under Debit and a credit under Credit. `running += outgoing − incoming`
([ledgers.js:391](frontend/js/ledgers.js#L391)) is then exactly
`Σdebit − Σcredit`, matching `recalc_ledger_balance`. **The statement is
internally consistent and correctly labelled.**

What remains is a naming smell: `incoming` / `outgoing` are cash-side words
carrying account-side data, and they invite precisely the misreading above.
Folded into the A2 vocabulary purge — see the Phase 0 item.

#### 🟢 B2. Opening-balance row on the statement — withdrawn

*Also corrected.* [ledgers.js:383-384](frontend/js/ledgers.js#L383-L384) puts a
positive opening balance in the Debit column and a negative one in Credit.
Since `opening_balance` is stored debit-positive, that is the correct
placement, and the code comment above it says so. No change needed.

The substantive opening-balance problem is **A4** (no contra entry), which is
unaffected by this.

#### 🟠 B3. "Cash In Hand" is computed from one day's net movement, not a balance

[ledgers.js:45-50](frontend/js/ledgers.js#L45-L50):

```js
function getPhysicalCashInHand() {
    const closing = parseFloat(cashbookDailyBalance.closing_balance) || 0;
    const opening = parseFloat(cashbookDailyBalance.opening_balance) || 0;
    return closing - opening;          // ← that day's NET MOVEMENT, not a balance
}
```

Consequences:
- Open a date with no entries → physical cash reads **0** even though cash exists.
- Cash accumulated on earlier days is invisible.
- The figure changes as you browse dates, which a balance must never do.

The correct value is the cumulative `closing_balance` itself. (Verified: the
cash closing balance already nets out every rupee moved into a bank ledger, so
`closing_balance + Σ(included ledger balances)` is the coherent total liquid
position.) **This looks like a straightforward bug, not a design choice.**

Related footgun: nothing stops a user creating a ledger literally named "Cash"
and ticking `include_in_cash_in_hand`, which would then double-count against the
implicit cash pot.

#### 🟠 B4. Income/expense classification by substring match on ledger *names*

[get_month_summary_totals](supabase/migrations/20260730010000_get_month_summary_totals_function.sql)
buckets ledgers with:

```sql
WHEN position('shopify' in lower(l.name)) > 0 THEN 'shopify'
WHEN position('ad'      in lower(l.name)) > 0 THEN 'ad'
```

`'ad'` matches "Load Sheet", "Trade Supplies", "Adnan Traders", "Gadgets",
"Advance"… and **renaming a ledger silently changes the P&L**. Classification
must key off a stable account code or category id, never the display name.

#### 🟠 B5. No financial statements at all

Missing entirely: Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, AR/AP
Ageing, date-ranged Account Statement with opening/closing, Day Book.

"Month Summary" is an *order* report, not a financial statement — and it blends
order-level data with substring-matched cashbook data, so it can't be reconciled
against the ledgers.

#### 🟠 C1. Posted entries are freely editable and hard-deletable

`PUT /cashbook/entries/{id}` and `DELETE /cashbook/entries/{id}` mutate and
remove history in place. Bookkeeping convention is that a posted transaction is
corrected by a **reversing entry**, never by editing or erasing, so the audit
trail survives.

Today `cashbook_entry_audit_log` captures deletions only, with no "who" — a gap
already recorded in [TODO.md](TODO.md#L53-L64). **Edits leave no trace at all**,
which is the more dangerous half: an amount can be changed after a month has
been reported on and nothing anywhere records it.

#### 🟠 C2. No period locking, no financial year

Nothing prevents backdating an entry into a month already reported on, or into a
prior year. Both reference systems block this — Akaunting via reconciliations,
ERPNext via `Accounting Period` + `Fiscal Year` + a period-closing voucher.

#### 🟡 C3. Paired "two-sided" entries are not linked

The two-sided modal posts two independent rows
([cashbook.js:427,434](frontend/js/cashbook.js#L427)). The bulk endpoint inserts
them in one statement (good), but **nothing marks them as one transaction** — no
voucher number, no `journal_id`. Delete one leg and the books silently go wrong;
no constraint prevents it. There is also a "skip this side" checkbox, so
single-legged entries are a normal, expected input.

#### 🟡 C4. `recalc_ledger_balance` deletes the row when the balance is zero

Harmless as storage (missing row = 0), but it makes "account exists with a
genuine zero balance" indistinguishable from "account never used". A trial
balance built on `ledger_balances` would silently drop legitimately-zero
accounts. Worth remembering when the trial balance is built.

#### 🟡 C5. No soft delete on financial records

Akaunting soft-deletes every financial model. Here a hard `DELETE` is the only
option, with a trigger-populated audit table as the sole safety net.

#### 🟡 C6. `ORDERS_LEDGER_ID` is a hardcoded UUID in a multi-tenant app

[advance_status.py:36](backend/app/advance_status.py#L36) and
[cashbook.js:170](frontend/js/cashbook.js#L170) both hardcode
`4bc067af-cf91-4700-8b52-b70ad4a991df`. Since queries are org-scoped, **the
order-advance flow silently does nothing for every org except the one that
ledger belongs to.** Not an accounting error as such, but it will corrupt
`advance_status` reconciliation for any new org. Should become an org setting or
a system-account role.

#### 🟢 Things that are right and should be kept

Worth saying explicitly so they don't get "fixed" during the rework:

- `DECIMAL(12,2)` storage and aggregation in Postgres `NUMERIC` — correct.
- `amount > 0` plus a direction flag, rather than signed amounts — standard.
- Balances maintained by DB triggers rather than application code — right call;
  it survives writes that bypass the API.
- Idempotency keys on entry creation — genuinely good, keep it.
- A delete-audit trigger at the DB level rather than in the route — right layer.
- The closed `CHECK` constraint on ledger nature instead of free text — right.

---

## Part 2 — What's missing for an all-round finance module

Grouped by whether it's foundational, the modules you asked about, or optional.

### Foundational (nothing else works properly without these)

| # | Gap | Notes |
|---|---|---|
| 1 | **Chart of Accounts** | Account **code**, parent/child grouping, system-reserved accounts (Cash, Bank, AR, AP, Sales, COGS, Inventory, Opening Balance Equity), enabled/archived. Today: 5 flat natures, no codes. |
| 2 | **General journal (double entry)** | Voucher header + balanced lines. Fixes A1–A5 at the root. |
| 3 | **Contacts** — customers & suppliers | Nothing exists. A supplier is currently just a free-text ledger name, so there is no address, tax number, payment terms, or contact-level ageing. Akaunting: `contacts` with a `type`. |
| 4 | **Bank / cash accounts as first-class** | `include_in_cash_in_hand` is a user-toggleable checkbox bolted onto `ledgers`. Akaunting has a real `accounts` table (name, number, opening balance). |

### The modules you asked for

| # | Gap | Notes |
|---|---|---|
| 5 | **Purchase Bills (AP)** — *the one you named* | Header + line items + taxes + totals + status workflow (draft → received → partially paid → paid → cancelled) + due date + payments against the bill + attachment (receipt photo) + PDF + number series. |
| 6 | **Payments / receipts against a document** | Akaunting's `transactions.document_id`. Today the cashbook cannot say "this Rs 20,000 settles Bill #14" — so partial payments and AP ageing are impossible. |
| 7 | **Sales Invoices (AR)** | Shopify covers D2C, but there is no way to invoice a wholesale/B2B customer and no accounts-receivable balance anywhere. |
| 8 | **Expenses with real categories** | Currently an expense is a cashbook entry against an expense ledger, classified for reporting by name substring (B4). |
| 9 | **Inventory ↔ accounting link (COGS + stock valuation)** | The biggest structural gap after bills. `variants.quantity` moves and `orders.cost_price` snapshots cost, but **no journal is ever posted** — inventory is never an asset on a balance sheet and COGS is never an expense. Purchase bills should increase Inventory; delivered orders should post COGS. This is where the IMS and the finance module finally join up. |
| 10 | **Credit notes / returns / refunds** | Orders carry a `returned` status but there is no financial document behind it. |
| 11 | **Financial statements** | Trial Balance, P&L, Balance Sheet, Cash Flow, AR/AP Ageing, Account Statement, Day Book. |

### Controls & hygiene

| # | Gap |
|---|---|
| 12 | **Fiscal year + period locking** (C2) |
| 13 | **Reversing entries instead of edit/delete** (C1) |
| 14 | **`created_by` attribution on every financial write** — users exist now, so this is finally meaningful |
| 15 | **Bank reconciliation** — mark entries reconciled against a statement, then lock |
| 16 | **Number series** — `BILL-2026-0001`, `JV-2026-0042`, per org, gap-free |
| 17 | **Opening-balance entry + year-end closing entry** |
| 18 | **Taxes** — a tax master and tax-per-line. `orders.tax_amount` exists in isolation; relevant if you're filing sales tax |
| 19 | **Recurring transactions** — rent, salaries, subscriptions |

### Recommended to explicitly *defer* (protects the "keep it simple" goal)

| Item | Why defer |
|---|---|
| Fixed assets & depreciation | A handful of assets for a small clothing business; a manual annual journal is cheaper than a module |
| Multi-currency | Single-currency (PKR) is a safe assumption; adding it later is contained if amounts stay `NUMERIC` |
| Budgets | No demand until the P&L exists and is trusted |
| Cost centres / accounting dimensions | ERPNext has them; overkill for one business unit |
| Multi-company consolidation | Orgs are already tenants, not subsidiaries |

---

## Part 3 — The core design decision

Two viable models, from the two reference codebases:

**Akaunting's model** — `accounts` (bank), `contacts`, `categories`,
`documents` (invoices *and* bills sharing one table, discriminated by `type`),
`document_items`, `document_totals`, `transactions` (payments in/out, optionally
linked to a document), `transfers`, `reconciliations`. **There is no general
ledger in the core product** — double-entry is a paid add-on. Simple, fast to
build, and the screens are exactly the ones a small-business owner expects.

**ERPNext's model** — a full Chart of Accounts and a `GL Entry` table that every
document posts into, with fiscal years, accounting periods, and closing
vouchers. Correct, complete, and considerably heavier.

### Recommendation: Akaunting's screens on top of ERPNext's ledger

Build a **small** double-entry core (essentially two tables) and keep **every
screen document-shaped**. The user enters a bill, an expense, a receipt, or a
transfer — never a debit and a credit. The journal is posted for them, and is
only ever surfaced read-only in reports and a "view accounting entries" drawer.

Why this and not the pure-Akaunting route, given "keep it simple":

- Correct-by-construction. A `Σdebit = Σcredit` DB constraint makes A1–A5
  structurally impossible rather than a discipline the code has to remember.
- **Retrofitting a general ledger after AP, AR, and inventory exist is far more
  expensive than doing it now**, while the only financial data is cashbook
  entries and a handful of ledgers. This is the cheapest moment this change will
  ever be.
- It is *less* code than it sounds: two tables plus a posting helper replaces the
  two hand-rolled recalc functions, the sign-convention confusion, and the
  balance-caching table.
- Simplicity is preserved where it's actually felt — in the UI — not by
  simplifying the data model into something that can't represent a credit
  purchase.

The cost is one migration of existing cashbook data (Phase 1), which is small
and mechanical.

### 3.1 Balance presentation — Dr/Cr for now

**Decision: use a `Dr` / `Cr` suffix.** Flip the sign for credit-normal natures
(Liability, Equity, Revenue) so the displayed number is always positive, and
append the suffix to carry the direction:

| Account | Stored | Displayed |
|---|---|---|
| Meezan Bank (Asset) | `120,000` | `Rs 120,000 Dr` |
| Fabric Supplier (Liability) | `−50,000` | `Rs 50,000 Cr` |
| Sales (Revenue) | `−500,000` | `Rs 500,000 Cr` |
| Rent (Expense) | `60,000` | `Rs 60,000 Dr` |

The display rule is one helper — sign flip keyed on nature, plus a suffix — and
it is the smallest change that removes the "Sales shows −500,000" problem (A3).
The existing inverted `cellStyle` test
([ledgers.js:519-524](frontend/js/ledgers.js#L519-L524)) collapses to a plain
"negative is bad" rule once the sign is corrected at the source.

**Deferred: plainer wording.** Dr/Cr is accounting vocabulary, which cuts
against the "simple and easy to understand" goal. For reference when this is
revisited — **Akaunting's core never uses Dr or Cr anywhere**; its vocabulary is
*Current Balance*, *Amount Due*, *Total Income*, *Total Expenses*, "the balance
you owe your vendors" (`resources/lang/en-GB/{accounts,general,reports}.php`),
with Dr/Cr confined to its paid double-entry module. The alternatives sketched
if that trade proves wrong:

- **Per-nature labels**, paired for both directions so an overpaid supplier
  reads *Advance paid Rs 5,000* rather than *You owe Rs −5,000*: Asset →
  *Available* / *Overdrawn*; Receivable → *Owes you* / *Advance received*;
  Liability → *You owe* / *Advance paid*; Equity → *Invested* / *Withdrawn*;
  Revenue → *Earned*; Expense → *Spent*.
- **Section headings on the account list** — *What you own* · *What you owe* ·
  *Money coming in* · *Money going out* · *Owner's money* — which imply the
  direction before a number is read.

Either way, the **Trial Balance** and the read-only **journal-entry drawer**
keep Dr/Cr permanently: both are accountant-facing by definition, and a trial
balance without Dr/Cr columns is worse for its actual reader.

---

## Part 4 — Phased plan

Each phase is independently shippable. Per [CLAUDE.md](CLAUDE.md), **all schema
changes go through versioned Supabase migrations**, never hand-edits to
`supabase_schema.sql`.

### Phase 0 — Fix the current module — **shipped**

Closed A2, A3, B1, B3, B4 and C6. What later phases need to know:

- **The sign convention now lives in one place** — the "THE TWO PERSPECTIVES"
  block heading the Cashbook & ledgers section of `supabase_schema.sql`. Every
  deliberately-crossed filter in the codebase points back to it by name.
- **`incoming` / `outgoing` are gone** from `frontend/` and `backend/app/`.
  Cashbook grids and the entry modal are now Debit (receipts) / Credit
  (payments); the ledger statement was already correct. Migration
  `20260801030000` moved `cashbook_daily_balances.total_credit`/`total_debit`
  onto the cash side to match.
- **Bulk-parser `From:` / `To:` / `Cr:` / `Dr:` tokens were left as they were** —
  folio-side and already Dr/Cr. Changing input syntax would break users' saved
  paste formats, and Phase 1 dissolves the mismatch anyway.
- **`formatBalanceWithSide()` turned out simpler than planned**: balances are
  stored Debit-positive for every Nature, so the sign alone gives the side. No
  per-Nature branch is needed for the suffix — Nature is still consulted in
  `cellStyle`, where "red = wrong side of normal" remains correct.
- **Two new ledger columns**, both forerunners of Phase 1's `accounts` table:
  `report_category` (replaces the name-substring P&L buckets; backfill
  reproduces the old rules exactly so no reported month moved) and
  `is_orders_ledger` (replaces the hardcoded UUID; one per org, enforced by a
  partial unique index). Migrations `20260801040000` and `20260801050000`.
- **Only the original org's Orders ledger was backfilled.** Other orgs — for
  whom the advance flow was silently inert — now get an explicit "no Orders
  ledger set" message and can pick one.

### Phase 1 — Chart of accounts + double-entry core

- [ ] Extend `ledgers` → **`accounts`**: `code`, `parent_id`, `subtype`,
      `is_system`, `is_cash_equivalent`, `enabled`, `archived_at`.
      Keep `type` (nature) as-is — it's already the right closed set.
- [ ] **`journal_entries`** — `entry_date`, `voucher_no`, `voucher_type`,
      `narration`, `source_type` / `source_id` (bill, invoice, order, manual),
      `posted_at`, `created_by`, `reversal_of_id`.
- [ ] **`journal_lines`** — `journal_id`, `account_id`, `debit`, `credit`,
      `contact_id`, `description`. Constraint: exactly one of debit/credit > 0.
- [ ] **DB constraint/trigger: `Σdebit = Σcredit` per entry**, and posted
      entries are immutable.
- [ ] **`account_balances`** maintained from `journal_lines`, replacing
      `ledger_balances` and both `recalc_*` functions.
- [ ] **Seed system accounts**: Cash, Bank, Accounts Receivable, Accounts
      Payable, Sales, Sales Returns, COGS, Inventory, Opening Balance Equity.
- [ ] **Migrate existing data**: each `cashbook_entries` row becomes a journal
      entry with two lines (folio + Cash); all `ledgers.opening_balance` values
      become a **single balanced opening journal** against Opening Balance
      Equity (fixes A4).
- [ ] **Cashbook view becomes a read of journal lines on cash accounts** — the
      screen the user sees does not change.
- [ ] **Ship the Trial Balance** here, as the proof the migration was correct
      (A5).

### Phase 2 — Contacts + Purchase Bills (AP)

- [ ] **`contacts`** — customer / supplier / both, address, tax number, payment
      terms, opening balance (posted as a journal entry, not a loose column).
- [ ] **`bills`** + **`bill_items`** — following Akaunting's `documents` shape;
      status workflow, due date, number series, attachment, PDF.
- [ ] **Payments against a bill** — partial payments supported.
- [ ] **Posting rules:**
      - On bill submit: `Dr Inventory / Expense`, `Cr Accounts Payable`
      - On payment: `Dr Accounts Payable`, `Cr Cash / Bank`
- [ ] **Link bill lines to `products` / `variants`** — receiving stock updates
      quantity and cost price. This is where the IMS half of the app starts
      paying for the accounting half.
- [ ] **AP Ageing report**, **Supplier statement**.

### Phase 3 — Sales invoices (AR) + posting Shopify orders

- [ ] **`invoices`** + **`invoice_items`**, sharing the Phase 2 document shape.
- [ ] **Post Shopify orders to the journal**: `Dr AR / Cash`, `Cr Sales`,
      `Cr Tax`; on delivery `Dr COGS`, `Cr Inventory`.
- [ ] **Credit notes** for returns/refunds, replacing the status-only `returned`
      handling.
- [ ] **AR Ageing**, **Customer statement**.
- [ ] Retire the month-summary substring buckets in favour of real accounts.

### Phase 4 — Reports

All as Postgres RPCs, consistent with the existing `get_month_summary_*`
pattern:

- [ ] Trial Balance (moved up to Phase 1)
- [ ] Profit & Loss (period comparison)
- [ ] Balance Sheet
- [ ] Cash Flow (indirect)
- [ ] Account Statement — date range, opening and closing balance
- [ ] Day Book
- [ ] AR / AP Ageing (from Phases 2–3)
- [ ] Expense by category

### Phase 5 — Controls

- [ ] **Fiscal years + period locking** — block posting into a closed period.
- [ ] **Reversing entries** replace edit/delete on posted transactions (C1).
- [ ] **`created_by` on every financial write** + full create/update/delete audit
      with attribution — closes the open TODO item, now that users exist.
- [ ] **Bank reconciliation** — reconcile against a statement, then lock.
- [ ] **Recurring transactions.**
- [ ] **Soft delete** on financial records (C5).

---

## Part 5 — Open questions

Answers here would change the shape of Phases 2–4:

1. **Sales tax / GST** — is the business registered and filing? If yes, taxes
   move from Phase 5 into Phase 2 (they have to be on the bill from day one, not
   retrofitted).
2. **Inventory valuation method** — weighted average, FIFO, or a simple standard
   cost? Weighted average is the simplest that is still defensible, and matches
   how `products.cost_price` is used today.
3. **Wholesale / B2B sales** — do they exist? If all sales are Shopify D2C,
   Phase 3's invoice module shrinks to just posting orders, and AR barely
   matters.
4. **Who does the books** — the owner, or a bookkeeper/accountant? This decides
   how much the UI can lean on accounting vocabulary versus plain language.
5. **Historical data** — does the general ledger start from a cut-over date with
   opening balances, or should all existing cashbook history be migrated? The
   plan above assumes full migration, which is cleaner but only worth it if the
   existing data is trusted.
6. **Fixed assets** — confirming these are out of scope, per Part 2.

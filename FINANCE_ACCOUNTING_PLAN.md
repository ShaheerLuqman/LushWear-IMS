# Finance & Bookkeeping — Review and Plan

Review of the existing Transactions and Ledgers modules against standard bookkeeping
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

## Where this stands (2026-08-02)

| Phase | State |
|---|---|
| 0 — Fix the current module | **shipped** |
| 1 — Chart of accounts + double-entry core | **shipped** |
| 2 — Purchase bills (AP) | **shipped** |
| 2.5 — Transactions name both of its sides | **shipped** |
| 3 — Finish the transactions cutover | next |
| 4 — Statements from the journal | after 3 |
| 5 — Orders → journal (revenue + COGS) | the last structural gap |
| 6 — Controls | last |

**What the system is today.** Every posting in the app lands in one place:
`journal_entries` + `journal_lines`, balanced by a deferred constraint, with
`ledger_balances` derived from it by trigger. `ledgers` is the chart of accounts
— codes, parents, natures, system roles, party attributes. Four accounts are
created with each organization (Cash, Opening Balance Equity, Orders,
Inventory); Tax on Purchases appears the first time a bill carries tax.

Two documents post into the journal. A **bill** posts `Dr Inventory` /
`Dr Tax on Purchases` / `Cr supplier` on receive, and moves stock. A **transaction
entry** names both of its accounts and is projected to a journal entry by
trigger. Payments are ordinary transaction entries against the supplier's ledger;
what a bill still owes is derived FIFO from that ledger rather than stored.

Reports reading the journal: **Trial Balance**, **ledger statement**, **AP
Ageing**. Month Summary still blends order data with transaction data and is an
operations report, not a financial statement.

**The one incoherence in the current books:** Inventory is only ever debited.
Bills increase it; nothing decreases it, because delivered orders post no COGS
entry. Stock on the balance sheet therefore grows forever, and gross profit
lives only in the order grid. That is Phase 5, and it is the reason a Balance
Sheet is not worth building before it.

---

## Part 1 — Review

### 1.1 How the system worked at review time — *historical*

None of this is still true: the implicit cash side went in Phase 1, and
`folio` / `entry_type` in Phase 2.5. It is kept because it is why the design is
shaped the way it is, and Part 3 argues from it.

`transaction_entries` is a single table where each row has **one** `folio` (a
ledger) and **one** `entry_type` (`credit` / `debit`). Two different DB functions
read that same row with **opposite signs**:

| Function | Formula | Effect |
|---|---|---|
| `recalc_transaction_daily_balances` | `closing = opening + Σcredit − Σdebit` | `credit` **increases** the cash pot |
| `recalc_ledger_balance` | `balance = opening + Σdebit − Σcredit` | `credit` **decreases** the folio ledger |

So the system *is* doing double entry — but with an **implicit, invisible cash
account** as the permanent other side of every transaction. Arithmetically it
holds together (the cash closing balance is always exactly the negative of the
sum of all ledger movements). Conceptually it is a **single-entry system**,
and that limitation is the root cause of most of what follows.

---

### 1.2 Findings that are still live

Sixteen findings came out of the original review. Eleven are closed and their
write-ups have been removed; the five below are still true of the system today.
A one-line record of the closed ones follows, so the codes referenced elsewhere
in this document still resolve.

#### 🟠 B5. The statements that report on the books are still missing

Trial Balance, the per-ledger statement and AP Ageing exist and read the
journal. **Profit & Loss, Balance Sheet, Cash Flow, Day Book and AR Ageing do
not**, and neither does a date-ranged account statement with opening and closing
figures — the ledger statement always runs from the beginning.

"Month Summary" is an *order* report, not a financial statement: it blends
order-level data with transaction spending, so it cannot be reconciled against the
ledgers. Phase 4, with the Balance Sheet gated behind Phase 5 — see the note on
Inventory at the top of this document.

#### 🟠 C1. Posted entries are freely editable and hard-deletable

`PUT /transactions/entries/{id}` and `DELETE /transactions/entries/{id}` still mutate and
remove history in place. Bookkeeping convention is that a posted transaction is
corrected by a **reversing entry**, never by editing or erasing, so the audit
trail survives.

`transaction_entry_audit_log` captures deletions only, with no "who" — a gap
recorded in [TODO.md](TODO.md). **Edits leave no trace at all**, which is the
more dangerous half: an amount can be changed after a month has been reported on
and nothing anywhere records it.

Narrowed since the review: a document's journal entry is now *replaced*
idempotently when it is re-posted, and a bill has `unreceive` rather than an
edit-in-place path. The exposure is the transaction's own write path.

#### 🟠 C2. No period locking, no financial year

Nothing prevents backdating an entry into a month already reported on, or into a
prior year. Both reference systems block this — Akaunting via reconciliations,
ERPNext via `Accounting Period` + `Fiscal Year` + a period-closing voucher.

#### 🟡 C4. A genuinely-zero account disappears from the books

`recalc_ledger_balance` deletes the `ledger_balances` row when the balance is
zero, so "account exists with a real zero balance" is indistinguishable from
"account never used". Harmless as storage — a missing row reads as 0 — but the
same blind spot is now in the report as well: `get_trial_balance` filters
`WHERE net <> 0`, so an account that genuinely nets to zero is absent from the
trial balance rather than listed at 0.00.

Defensible for a long chart of accounts, wrong if a reader is checking that a
particular account is flat. Decide deliberately when Phase 4 builds the
statements, rather than inheriting it by accident.

#### 🟡 C5. No soft delete on financial records

Akaunting soft-deletes every financial model. Here a hard `DELETE` is the only
option, with a trigger-populated audit table as the sole safety net.

#### Closed findings

Kept as one line each so the references elsewhere in this document resolve.

| # | Finding | Closed by |
|---|---|---|
| A1 | Every transaction forced to touch cash | Phase 1 journal; Phase 2.5 let an entry name two non-cash accounts |
| A2 | `debit`/`credit` reversed on the cash side | Phase 0 relabelled; Phase 2.5 removed the concept — a side is an account, not a direction |
| A3 | Balances stored debit-positive regardless of nature | Phase 0, `formatBalanceWithSide()` |
| A4 | `opening_balance` had no contra entry | Phase 1, `sync_opening_balance_journal()` posts against Opening Balance Equity |
| A5 | No trial balance | Phase 1 |
| B1 | Ledger statement column naming | Phase 0 |
| B2 | Opening-balance row placement | Withdrawn — was not a defect |
| B3 | "Cash In Hand" was a daily delta, not a balance | Phase 0 used the cumulative closing balance; Phase 2.5 moved it onto the Cash account's own ledger balance |
| B4 | P&L buckets by ledger-name substring | Phase 0, `report_category` |
| C3 | Paired two-sided entries not linked | Phase 2.5 — a two-sided entry is one row, so there is no pair to break |
| C6 | `ORDERS_LEDGER_ID` hardcoded in a multi-tenant app | Phase 0, then folded into `system_key` |


#### 🟢 Things that are right and should be kept

Worth saying explicitly so they don't get "fixed" during the rework:

- `DECIMAL(12,2)` storage and aggregation in Postgres `NUMERIC` — correct.
- **No signed amounts.** `amount > 0`, with the direction carried by the two
  named sides (it was a direction flag at review time) — standard either way.
- Balances maintained by DB triggers rather than application code — right call;
  it survives writes that bypass the API. Same argument keeps the transaction's
  journal projection in a trigger (Phase 3).
- Idempotency keys on entry creation — genuinely good, keep it.
- A delete-audit trigger at the DB level rather than in the route — right layer.
- The closed `CHECK` constraint on ledger nature instead of free text — right.

---

## Part 2 — What's missing for an all-round finance module

Grouped by whether it's foundational, the modules you asked about, or optional.

### Foundational (nothing else works properly without these)

| # | Gap | Status | Notes |
|---|---|---|---|
| 1 | **Chart of Accounts** | **done** | Account **code**, parent/child grouping, system-reserved accounts, enabled/archived — all on `ledgers`, which *is* the chart of accounts. |
| 2 | **General journal (double entry)** | **done** | Voucher header + balanced lines. Fixed A1–A5 at the root. |
| 3 | **Contacts** — customers & suppliers | **superseded** | A supplier is a ledger carrying a real balance; party attributes live on `ledgers`. See the Phase 2 decision. |
| 4 | **Bank / cash accounts as first-class** | **partly** | `system_key = 'cash'` and `is_cash_equivalent` exist. `include_in_cash_in_hand` is still a user checkbox deciding what the header figure totals. |

### The modules you asked for

| # | Gap | Status | Notes |
|---|---|---|---|
| 5 | **Purchase Bills (AP)** — *the one you named* | **done** | Header + lines + tax + totals + `draft`/`received`/`cancelled` + due date + number series + stock on receive. Attachments and bill PDFs deferred. |
| 6 | **Payments / receipts against a document** | **superseded** | No allocation table: a payment is a transaction entry against the supplier, and settlement is derived FIFO from that ledger. Partial payments and AP ageing both work. |
| 7 | **Sales Invoices (AR)** | **open** | Shopify covers D2C; no way to invoice a wholesale/B2B customer, no AR balance. Gated on open question 3. |
| 8 | **Expenses with real categories** | **done** | `report_category` replaced the name-substring buckets. |
| 9 | **Inventory ↔ accounting link (COGS + stock valuation)** | **half** | Bills now debit Inventory and move stock. Nothing credits it — delivered orders post no COGS — so the asset only grows. The largest remaining gap; Phase 5. |
| 10 | **Credit notes / returns / refunds** | **open** | Orders carry a `returned` status with no financial document behind it. Phase 5. |
| 11 | **Financial statements** | **partly** | Trial Balance, Account statement (per ledger), AP Ageing done. P&L, Balance Sheet, Cash Flow, Day Book, AR Ageing outstanding. |

### Controls & hygiene

| # | Gap | Status |
|---|---|---|
| 12 | **Fiscal year + period locking** (C2) | open |
| 13 | **Reversing entries instead of edit/delete** (C1) | open |
| 14 | **`created_by` attribution on every financial write** | partly — bills carry it; transaction entries and journal entries do not |
| 15 | **Bank reconciliation** — mark entries reconciled against a statement, then lock | open |
| 16 | **Number series** — per org, gap-free | partly — bills have one; journal vouchers do not |
| 17 | **Opening-balance entry + year-end closing entry** | half — the opening entry posts (A4); no year-end close |
| 18 | **Taxes** — a tax master and tax-per-line | partly — a bill carries one tax amount posted to Tax on Purchases; no tax master, no per-line rates |
| 19 | **Recurring transactions** — rent, salaries, subscriptions | open |

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
  expensive than doing it now**, while the only financial data is transaction
  entries and a handful of ledgers. This is the cheapest moment this change will
  ever be.
- It is *less* code than it sounds: two tables plus a posting helper replaces the
  two hand-rolled recalc functions, the sign-convention confusion, and the
  balance-caching table.
- Simplicity is preserved where it's actually felt — in the UI — not by
  simplifying the data model into something that can't represent a credit
  purchase.

The cost is one migration of existing transaction data (Phase 1), which is small
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
  block heading the Transactions & ledgers section of `supabase_schema.sql`. Every
  deliberately-crossed filter in the codebase points back to it by name.
- **`incoming` / `outgoing` are gone** from `frontend/` and `backend/app/`.
  Transaction grids and the entry modal are now Debit (receipts) / Credit
  (payments); the ledger statement was already correct. Migration
  `20260801030000` moved `transaction_daily_balances.total_credit`/`total_debit`
  onto the cash side to match.
- **Bulk-parser tokens were left as they were** — folio-side and already Dr/Cr,
  and changing input syntax would break users' saved paste formats.
  *Superseded by Phase 2.5*, which had to change the format anyway: a line is now
  `<AMOUNT> from <LEDGER> to <LEDGER>`, either side omittable, an omitted side
  meaning cash.
- **`formatBalanceWithSide()` turned out simpler than planned**: balances are
  stored Debit-positive for every Nature, so the sign alone gives the side. No
  per-Nature branch is needed for the suffix — Nature is still consulted in
  `cellStyle`, where "red = wrong side of normal" remains correct.
- **Two new ledger columns**, both forerunners of Phase 1's `accounts` table:
  `report_category` (replaces the name-substring P&L buckets; backfill
  reproduces the old rules exactly so no reported month moved) and
  `is_orders_ledger` (replaces the hardcoded UUID; one per org, enforced by a
  partial unique index). Migrations `20260801040000` and `20260801050000`.
  *`is_orders_ledger` was later folded into `system_key` — see below.*
- **Only the original org's Orders ledger was backfilled.** Other orgs — for
  whom the advance flow was silently inert — now get an explicit "no Orders
  ledger set" message and can pick one.

**Fixed ledger roles were later unified onto `system_key`** (migration
`20260801140000`). There had been two mechanisms for "this account fills role X":
`system_key` for the app-created accounts, and a dedicated `is_orders_ledger`
boolean — an accident of sequencing, since the boolean shipped before
`system_key` existed. Each future role would have cost a column, an index, two
model fields, a guard helper and a checkbox; as a `system_key` value it costs one
line in `backend/app/ledger_roles.py`. It also closed a hole: the boolean's guard
only checked that no *other* ledger held the role, so the Cash account could be
flagged as the Orders ledger too. Roles were split into assignable (`orders`,
`inventory`, `tax_on_purchases`) and protected (`cash`,
`opening_balance_equity`) — re-pointing `cash` would orphan every entry the
journal projection has already posted. *Later simplified further:* every role is
server-managed and none are assignable, since the org-creation trigger fills them
all. The API no longer accepts `system_key` at all, and the role picker it fed
was removed.

### Phase 1 — Chart of accounts + double-entry core — **shipped**

Closes A1, A4 and A5. The journal is now the complete record of every posting,
and `ledger_balances` derives from it. What later phases need to know:

- **Post through `post_journal_entry()`, never by inserting rows.** The
  debits=credits check is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so
  header and lines must land in one transaction — two PostgREST calls are two
  transactions and the first would fail on its own. Phase 2's bill posting calls
  the same function with `p_source_type='bill'`.
- **`source_type` / `source_id` own the link back to a document**, and a partial
  unique index enforces one entry per source row. Re-posting a document replaces
  its entry instead of double-counting it — that is how the transaction projection
  stays idempotent, and Phase 2 should use it the same way.
- **Non-cash transactions are now possible** — the A1 unlock. `POST
  /api/journal/entries` takes any balanced set of lines. There is deliberately
  no manual-journal UI yet; the plan did not call for one and a multi-line entry
  form is the most complex screen in the app.
- **Trial Balance** at `GET /api/journal/trial-balance` and in the sidebar. It
  reports `balanced` explicitly rather than leaving the reader to compare two
  totals, and says "out of balance by X" loudly if they ever disagree.

Three deviations from the plan as written, all deliberate:

- **`ledgers` was not renamed to `accounts`.** The columns were added (`code`,
  `parent_id`, `subtype`, `system_key`, `is_cash_equivalent`, `enabled`,
  `archived_at`), but the rename would cascade through every route, the
  frontend, the RLS list and the org-scope lint for no functional gain, and
  "Ledgers" is what the UI and the user already call these. `ledgers` **is** the
  chart of accounts. Likewise `account_balances` stayed `ledger_balances` and was
  simply repointed at `journal_lines` — a second table holding the same numbers
  would only be something to drift.
- **System accounts are seeded on demand, not all nine up front**, via
  `ensure_system_ledger()` — otherwise every org's Ledgers screen fills with
  zero-balance accounts nothing writes to. *Later revised:* a trigger on
  `organizations` now creates the four an org always needs (`cash`,
  `opening_balance_equity`, `orders`, `inventory`), because seeding them
  piecemeal from whichever migration first needed one left newly created orgs
  with none. `tax_on_purchases` stayed on-demand — `receive_bill` creates it the
  first time a bill carries tax. `accounts_payable` was never seeded: Phase 2
  decided against a control account entirely.
- **Transactions still write `transaction_entries`,** projected into the journal by
  trigger, rather than being rewritten onto journal lines. That rewrite is the
  whole transaction write path (create/bulk/update/delete, daily-balance triggers,
  advance reconciliation) and would have landed unverifiable alongside the schema
  and the data migration. Projection gets the same single source of truth for
  balances and reporting with none of that risk. To finish the cutover later:
  drop `transaction_entries_journal_trigger` and post from the API directly.

**`cash` is created, never adopted from a same-named ledger.** The transaction's
implicit cash pot is a different account from any user-made ledger called
"Cash" — that one has entries posted against it as a folio, and merging the two
would double-count every one of them.

### Phase 2 — Purchase Bills (AP) — **shipped**

Closes gaps 5, 6 and half of 9. Bills, AP Ageing and the supplier's own ledger
statement are in the sidebar; `receive_bill()` posts `Dr Inventory` /
`Dr Tax on Purchases` / `Cr supplier` through `post_journal_entry()` and moves
stock in the same call, and `unreceive_bill()` undoes both.

**Decision: no `contacts` table — a supplier IS a ledger.** The plan originally
copied Akaunting's `contacts`, but Akaunting needs it because its core has no
general ledger: the contact row is its only record of who a party is and what
they owe. Since Phase 1 there is a real general ledger, so a supplier is already
an account carrying a real balance. That is the Tally model (party ledgers
grouped under Sundry Creditors), it is mainstream practice in this region, and
it is how this app has always worked — the original schema described ledgers as
"suppliers, customers, expense heads", with legacy types `Payable Vendors` /
`Receivable Vendors`.

Consequences of that decision, all simplifications:

- **No Accounts Payable control account.** The sum of the Liability-nature party
  ledgers *is* accounts payable. This removes a control-vs-subsidiary
  reconciliation that would otherwise have to be maintained forever, and
  supersedes the Phase 1 handoff note that said Phase 2 must seed
  `accounts_payable`. It does not: it seeds `inventory`, and creates
  `tax_on_purchases` on the first bill that carries tax.
- **No separate supplier statement.** The supplier's ledger statement already is
  one, and it now reads from the journal.
- **Party attributes live on `ledgers`** (phone, email, address, tax number,
  payment terms) rather than in their own table.
- **`parent_id` stops being speculative** — it is how party ledgers group under a
  "Sundry Creditors" heading.

When this would need revisiting: a few hundred suppliers (the trial balance
would fill with party accounts and want a control account), or one entity traded
with as both customer and supplier. Both are recoverable later — a contacts
table can be layered over existing party ledgers without redoing the bills or
the journal, because the accounting lives in the ledger either way. AP ageing is
*not* a reason: it comes from bill due dates, not from a party record.

Two further decisions taken while building it:

- **No per-line account on a bill.** Every line is stock and posts to Inventory.
  A bill records what is *owed*, not how spending is categorised; anything paid
  on the spot (ads, rent, packaging) stays a transaction entry against its expense
  ledger, which is fewer steps and already worked. Migration
  `20260801110000` removed the per-line account after it was first built.
- **No `bill_payments` table** (migration `20260801120000` removed the one built
  first, along with `pay_bill()` and the Pay button). A payment is an ordinary
  transaction entry against the supplier's ledger, and settlement is **derived FIFO**
  from that account: its debits are what has been settled, applied to its
  received bills oldest-first. Self-correcting — whatever is entered in the
  transaction, the ledger is the truth and the report follows it — and a payment
  does not have to name a bill, which is how paying a supplier a round sum
  actually behaves. `bills_with_paid` is the view; only `draft` / `received` /
  `cancelled` are stored.

Deferred, and why: **attachments** (needs a Supabase storage bucket, which is
not configured) and **bill PDFs** (the PDF service exists but a bill template is
its own piece of work, and nothing downstream needs it yet).

### Phase 2.5 — Transactions name both of its sides — **shipped**

Not in the original plan; it fell out of Phase 2. Paying a supplier from a bank
account is not a cash transaction, but the transaction could only express *one*
account plus an implicit cash side, so Cash in Hand absorbed every transfer that
never touched cash.

An entry now carries `from_account_id` (credited) and `to_account_id` (debited),
`NULL` on a side meaning cash — migration `20260801160000`. `folio` and
`entry_type` are gone: `entry_type` existed only to say which side the single
folio sat on, which two explicit columns make obvious, and keeping both would
have left two ways to express one fact.

What this closed beyond its own goal:

- **C3 dissolves.** A two-sided entry is one row, so there is no unlinked pair
  that deleting one leg can break, and the "skip this side" checkboxes are gone
  with the concept.
- **The A2 sharp edge dissolves.** A side is an account, not a direction, so no
  label has to describe two accounts at once.
- **Cash in Hand became the Cash account's own balance.** It was the transaction's
  daily `closing_balance`, which knows only about transaction entries — a bill paid
  in cash or a manual journal line moved the ledger without moving that figure.
  The headline now reads `ledger_balances` for `system_key = 'cash'`, so the two
  can no longer disagree, and a transaction write refreshes it by including the cash
  account in the balances it returns.

The UI followed: the two mirrored Debit/Credit grids showed the *same* entries
once each side was named, so they collapsed into one table — Description, From,
To, Amount — and the two-sided entry form collapsed into one, which also means
naming both sides now creates one entry rather than two. The Cash account was
renamed from "Cash in Hand" to **Cash** (the old name also named the *total* in
the header, one word for two different amounts), and it is not offered in the
account pickers, because leaving a side empty already means it.

---

### Phase 3 — Finish the transactions cutover — **next**

Small, mechanical, and it removes a class of bug rather than adding a feature.
Everything here is paying off debt Phase 1 and 2.5 knowingly took on.

- [ ] **Store the cash account explicitly on both sides.** `NULL`-means-cash is
      the last place where one account is stored differently from every other,
      and it costs more each time something reads an entry: the cash-account
      substitution in `_ledger_balances`, the bulk parser collapsing a typed
      "Cash" back to `NULL`, `cashSideLabel()` / `selectableLedgers()`, and a
      grid cell that rendered the cash side as "no account chosen". Backfill both
      columns per org, make them `NOT NULL`, and the CHECK collapses to *the two
      sides differ*. `project_transaction_entry_to_journal` becomes a straight copy
      with no `COALESCE` and no "org has no cash account" exception. The audit-log
      columns need the same backfill; bulk text entry defaults the unwritten side
      to cash instead of `NULL`.
- [ ] **Retire `transaction_daily_balances`.** Nothing reads it any more — the grid
      shows entries only and Cash in Hand comes from the ledger. It is a second
      cache of a number `ledger_balances` already holds, kept current by its own
      trigger, and free to drift from it. Drop the table, its triggers,
      `recalc_transaction_daily_balances()`, and `daily_balance` from
      `GET /transactions/day/{date}`. If a per-day cash figure is wanted later it is a
      query over the cash account's journal lines, not a stored total.
- [ ] **Keep the projection trigger — this supersedes the Phase 1 note** that
      said to finish the cutover by posting from the API directly. The trigger
      survives writes that bypass the API, which is the same argument that put
      balances in triggers in the first place; moving posting into the route
      would trade that for nothing. `transaction_entries` stays the document, the
      journal stays the record.

### Phase 4 — Statements from the journal

Everything here is now a read over `journal_lines` — the data exists, the
reports do not. All as Postgres RPCs, consistent with `get_month_summary_*` and
`get_trial_balance`.

- [ ] **Profit & Loss** for a period, with comparison. Groups by nature
      (Revenue − Expense) over the accounts that already carry `report_category`.
- [ ] **Day Book** — every journal entry for a date, cheap and useful for
      "what did we book yesterday".
- [ ] **Account statement with a date range** — the ledger statement exists but
      always runs from the beginning; it needs opening/closing figures for a
      window.
- [ ] **Balance Sheet** — deliberately *after* Phase 5. Until delivered orders
      credit Inventory, the asset side is wrong by the whole cost of everything
      ever sold, and a statement that is confidently wrong is worse than none.
- [ ] **Cash Flow (indirect)** — after the Balance Sheet, which it derives from.
- [ ] **Settle C4 while building these** — whether an account that nets to zero
      is listed at 0.00 or omitted. Today it is omitted twice over, by
      `recalc_ledger_balance` and by `get_trial_balance`'s `net <> 0` filter, and
      neither was a decision anyone made.
- [ ] **Decide what happens to Month Summary.** It blends order counts with
      transaction spending and cannot be reconciled against the ledgers. Once a real
      P&L exists, either it keeps its order-operations half and drops the money
      half, or it is retired. Not a code change until the P&L is trusted.

### Phase 5 — Orders → journal (revenue + COGS)

The last structural gap, and the one that makes the Balance Sheet honest. Today
an order affects stock quantity and the order grid; it posts nothing.

- [ ] **Post delivered orders**: `Dr Cash/Receivable`, `Cr Sales`, `Cr Tax` —
      plus `Dr COGS`, `Cr Inventory` from the `line_items` cost snapshot, which
      already exists per line for exactly this reason.
- [ ] **Decide the recognition point.** `delivered` is the honest one for COD:
      revenue when the customer accepts the goods, not when the order is placed.
      Everything before that is stock in transit, not a sale.
- [ ] **Returns as credit notes** — reverse the revenue and the COGS, replacing
      the status-only `returned` handling.
- [ ] **Order advances become real.** They are already tracked against the Orders
      liability account and reconciled by `advance_status`; posting the order
      should clear that liability rather than leaving it to accumulate.
- [ ] **Then retire `report_category`'s reporting role** where a real account
      does the job.

Sales invoices (AR) for wholesale/B2B stay parked until open question 3 is
answered — if every sale is Shopify D2C, this phase *is* the whole of AR.

### Phase 6 — Controls

Last deliberately: controls constrain a model, and the model is still changing.

- [ ] **Fiscal years + period locking** — block posting into a closed period (C2).
- [ ] **Reversing entries** replace edit/delete on posted transactions (C1). Note
      that `post_journal_entry` already replaces a document's entry idempotently,
      so this is about the *transaction's* edit/delete path, not the journal's.
- [ ] **`created_by` everywhere** — bills carry it; transaction and journal entries
      do not, and the transaction audit log still records deletions without a who.
- [ ] **Bank reconciliation** — reconcile against a statement, then lock.
- [ ] **Soft delete** on financial records (C5).
- [ ] **Recurring transactions** — rent, salaries, subscriptions.

---

## Part 5 — Open questions

1. **Sales tax / GST** — is the business registered and filing? *Partly
   overtaken:* a bill carries one tax amount and posts it to Tax on Purchases, so
   the input side exists. The answer now decides whether a tax master with
   per-line rates and an output-tax account are needed in Phase 5, or whether one
   amount per document stays sufficient.
2. **Inventory valuation method** — weighted average, FIFO, or standard cost?
   **Now blocking Phase 5**, which cannot post COGS without it. Weighted average
   is the simplest that is still defensible, and matches how
   `products.cost_price` is used today; the `line_items` cost snapshot is
   effectively standard cost at order time, which is the cheapest to implement
   because the number is already stored per line.
3. **Wholesale / B2B sales** — do they exist? Still open, and it is what decides
   whether AR is a module or just "post the Shopify orders".
4. **Who does the books** — the owner, or a bookkeeper? Still open. It decides
   whether the deferred plain-language wording in 3.1 ever replaces Dr/Cr, and
   how much Phase 4's statements can assume of their reader.
5. **Historical data** — ~~cut-over or full migration?~~ **Answered by shipping:**
   all existing transaction history was migrated into the journal, and the
   from/to backfill carried it again in Phase 2.5. The journal is complete from
   the beginning of the data.

New, arising from the current state:

6. **Does Month Summary survive the P&L?** See Phase 4. It is the only report
   that blends order data with transaction data, and once a real P&L exists it
   either sheds its money half or is retired.
7. **What should `include_in_cash_in_hand` mean now?** It is a free checkbox
   deciding which accounts join Cash in the header figure. With
   `is_cash_equivalent` also on `ledgers` and set for system accounts, there are
   two overlapping notions of "this is liquid" — worth collapsing to one before
   the Balance Sheet has to pick a definition of cash.
6. **Fixed assets** — confirming these are out of scope, per Part 2.
 As a payable aging page purpose payment. Transaction As a payable aging page purpose payment. Transaction accounting As a payable aging page purpose payment. Transaction accounting professional As a payable aging page, purpose payment transaction accounting professional. As a payable aging page, purpose payment transaction accounting professional. nine As a payable aging page, purpose payment transaction accounting professional. nine fourteen ninety As a payable aging page, purpose payment transaction accounting professional. nine fourteen ninety seven As a payable aging page, purpose payment. Transaction accounting professional, nine fourteen ninety-seven. As a payable aging page, purpose payment. Transaction accounting professional, nine fourteen ninety-seven. nine fourteen As a payable aging page, purpose payment. Transaction accounting professional, nine fourteen ninety-seven. nine fourteen Shop As a payable aging page, purpose payment. Transaction accounting professional, nine fourteen ninety-seven. nine fourteen Shopify As a payable aging page purpose payment. Transaction accounting professional nine fourteen ninety seven nine fourteen Shopify settings Shopify black and white and white purpose or parking purple
# Organization Onboarding Date — Implementation Plan

Status: implemented and migrated (2026-09-22). Supersedes the earlier draft of
this file, which predated the React frontend migration and proposed app-layer
validation only (see "Why the DB, not the routes" below for why that was wrong).
Still open: surfacing `onboarding_date` on `AccountPublic` (§1) was skipped - the
Settings endpoint is its only consumer, and it would cost a query on every /me.

## Goal

Give an org an `onboarding_date` — normally the day the customer starts using
the software — such that no transaction entry, journal entry (including receipt
and payment vouchers), or bill can ever exist before it. The org's
pre-onboarding financial position is carried by ledger opening balances as of
that date instead.

Out of scope here, deferred to the end of this document: bounding the Shopify
backfill window and reconciling the trailing pre-onboarding courier tail.

## Rules

| Where | Rule |
|---|---|
| Trigger on `finances_journal_entries` / `finances_transaction_entries` / `finances_bills` | reject when the row's date `< onboarding_date` |
| `PUT /org-settings/onboarding` | reject when `onboarding_date >` the org's earliest existing `entry_date`/`bill_date`, naming that date |
| `sync_opening_balance_journal(org_id)` | opening entry dated `onboarding_date` exactly; the existing `MIN(entry_date) - 1` heuristic survives only as the `onboarding_date IS NULL` fallback |
| `ledger_statement` view | order the opening voucher first within its date |

Entries are allowed **on** the onboarding date. The opening entry shares that
date with them, so it is kept first by voucher type in the statement ordering
rather than by being dated a day earlier.

## Why the DB, not the routes

Most dated financial rows in this codebase are written by Postgres functions,
not by Python: sales posting, COGS, courier payout journals, and the opening
balance rebuild all `INSERT INTO finances_journal_entries` from plpgsql. Only
`routes/journal.py` and `routes/transactions.py` insert from the app. A guard in
the route layer would therefore miss most writers, so the cutoff is enforced by
one trigger function attached to the three date-bearing tables — every caller,
app or RPC, routes through it.

Machine postings are **skipped** (`RETURN NULL`), not raised on: raising would
break the Shopify sync the moment it touches a pre-onboarding order.

Because nothing pre-onboarding is ever written, every existing read, report, RPC
and ledger balance is correct with no read-side date filtering anywhere. That is
the point of enforcing on write.

## 1. Data model

- New migration: `ALTER TABLE system_organizations ADD COLUMN IF NOT EXISTS onboarding_date DATE;`
  Same shape as `20260905000000_org_fiscal_settings.sql`.
- Nullable with no backfill. `NULL` means "no cutoff", so every existing org
  behaves exactly as it does today until an admin sets a date.
- Surface `onboarding_date` on `AccountPublic` so the frontend can read it
  without an extra fetch.

## 2. The cutoff trigger

Same migration. One `BEFORE INSERT` trigger function, attached to all three
tables, resolving the org's `onboarding_date` and returning `NULL` when the
row's date falls before it:

| Table | Date column |
|---|---|
| `finances_journal_entries` | `entry_date` |
| `finances_transaction_entries` | `entry_date` |
| `finances_bills` | `bill_date` |

Receipts are journal entries with `voucher_type = 'receipt'`, so they need no
separate handling.

Alongside it, a `400` check in `routes/transactions.py`
(`create_transaction_entry` and the bulk variant), `routes/journal.py`
(`create_journal_entry`) and `routes/bills.py` (`create_bill`), so a human
typing a pre-onboarding date gets a real error instead of a silent no-op. The
trigger is the correctness boundary; these checks only supply the message.

## 3. Opening balance entry

`sync_opening_balance_journal(org_id)` currently dates its synthetic entry
`COALESCE(MIN(entry_date), CURRENT_DATE) - 1` (see
`20260801070000_journal_seed_and_backfill.sql`). The `- 1` exists purely to sort
ahead of the first entry: the opening entry is deleted and reinserted on every
rebuild, so its `created_at` is always the newest and it would otherwise sort
last within its date.

- Date it `onboarding_date` when one is set; keep `MIN(entry_date) - 1` as the
  `NULL` fallback. Changing that fallback to something like ledger creation date
  would risk landing the opening entry after backdated entries in existing orgs.
- In the same migration, redefine the ledger statement view (latest definition:
  `20260819030000_ledger_statement_source_id.sql`) with
  `ORDER BY je.entry_date, (je.voucher_type = 'opening') DESC, je.created_at, jl.created_at`.
- The trigger compares with `<`, so an entry dated exactly `onboarding_date` —
  including this one — passes.

Existing orgs keep their current opening entry date until something rebuilds it.
A one-off `sync_opening_balance_journal` sweep can normalize them if the mixed
dating matters.

## 4. Settings module, endpoint, UI

- `backend/app/onboarding_settings.py` mirroring `fiscal_settings.py`:
  `get_org_onboarding_date` / `set_org_onboarding_date`, the latter carrying the
  "not later than the earliest existing entry" check.
- `GET/PUT /org-settings/onboarding` in `routes/org_settings.py`, same shape as
  the existing `/org-settings/fiscal` pair, with matching Pydantic models in
  `app/models.py`.
- Frontend: one `<input type="date">` in a "Danger zone" card at the bottom of
  `frontend/src/pages/settings/SettingsPage.tsx`, below Couriers — it is the only
  setting there that can destroy data (§6). Editable any time; no wizard, no lock.

## 5. What happens to orgs already using the app

Nothing is deleted, ever. The trigger only sees inserts, and the column defaults
to `NULL`, so deploying the migration changes no existing behavior.

When an admin later sets a date, the §4 set-check means they can only choose one
at or before their earliest existing entry. That makes "nothing before this
date" a true statement about their data rather than a retroactive edit: reports
don't change, and the opening entry still sorts first.

## 6. Moving the date forward onto existing history

Picking a date *later* than the org's oldest entry is the one destructive path,
so it does not go through the guarded setter at all:
`POST /org-settings/onboarding/cutoff` calls
`apply_onboarding_cutoff(org_id, date)`
(`20260922010000_onboarding_cutoff_purge.sql`, amended by
`20260922020000_cutoff_keeps_existing_opening_balance.sql`), which in one
transaction sets the new date, deletes the pre-cutoff transaction entries,
journal entries and bills, and rebuilds the opening voucher at the new date from
each ledger's **existing, unchanged** `opening_balance`.

The purge is deliberately **not** balance-preserving: the entries between the
old opening balance and the new date are discarded, not rolled forward, so every
ledger drops whatever they contributed. The opening balance is a figure the
admin maintains (it is what the courier/CSV reconciliation produces and what the
ledger edit modal writes), and the purge leaves it alone. Reviewing those
opening balances afterwards is part of the operation.

It also deletes the org's **pre-onboarding courier bills**. The purge removes
vouchers but not bill rows, so a stale one dated at the old onboarding date would
otherwise survive - and since only one such bill may exist per courier, the new
tail could never build its own, while the settlements that cleared the stale
bill's members are themselves purged. `courier_bill_id` is `ON DELETE SET NULL`,
so its orders detach and the next `assign_courier_bills` regroups them onto
ordinary pickup-date bills, which post nothing because they are pre-cutoff.

Scope is otherwise exactly the three tables the cutoff trigger guards. Orders, courier
bills and stock levels are untouched: stock added by a purged bill stays
applied, the inventory equivalent of preserving an opening balance. Deleted
transaction entries still land in `finances_transaction_entry_audit_log` via the
existing delete trigger.

The field lives in a "Danger zone" card at the bottom of Settings and has no
`max`, so a later date is reachable; submitting one routes through the shared
confirm dialog with `danger` and `holdSeconds: 5`
(`components/ConfirmContext.tsx`), which disables the confirm button and counts
down before it can be clicked. Nothing recovers the deleted rows afterwards.

## Trap: two-step inserts and the silent skip

The trigger suppresses a pre-onboarding row by returning NULL, so any function
that inserts a journal header and then its lines must check that the header
survived - otherwise the intended skip becomes a `23502` on
`journal_lines.journal_id` that rolls back whatever wrote it.

`post_journal_entry` hit this for real (resolving the last open order in a
pre-onboarding fiscal period makes `sync_period_cogs_journal` post that period's
COGS voucher) and was fixed in
`20260922030000_post_journal_entry_skips_pre_onboarding.sql`, which guards the
shared function so the courier bill and payout paths are covered too.

Two other functions have the same shape:

- `sync_opening_balance_journal` - safe. Its voucher is dated *at*
  `onboarding_date` and the trigger compares with `<`, so it always survives.
- `project_transaction_entry_to_journal` - **not currently reachable**, and
  deliberately left unguarded. Its only live caller is the BEFORE-trigger path,
  which never fires for a suppressed row, and a one-off re-projection `DO` block
  that has already run. Anyone writing another bulk re-projection sweep must
  either add the NULL check first or exclude pre-onboarding entries, or the
  migration will abort part-way through.

## 7. Planned change: `onboarding_date` becomes mandatory

Decided, not yet implemented. Nullable was only ever a way to ship the cutoff
without changing behaviour for existing orgs; once `journal_orders_from` is
removed (see `PRE_ONBOARDING_COURIER_PLAN.md`) this is the only gate left, and
NULL meaning "post everything" becomes a trap.

- **Migration**: backfill `onboarding_date = DATE '2026-01-01'` wherever it is
  NULL — the same date `journal_orders_from` has defaulted to since the
  sales-journal cutover, so nothing about what posts changes — then
  `SET NOT NULL` and `SET DEFAULT CURRENT_DATE`.
- **New orgs are asked for it at creation.** `SuperadminOrgCreate` gains a
  required `onboarding_date`, `POST /admin/organizations` writes it, and the
  Superadmin Portal's create-organization modal gets a date field defaulting to
  today.
- **The bootstrap path is not asked.** `auth_bootstrap` creates the very first
  org before there is anyone to ask, so it relies on the column default
  (`CURRENT_DATE`), which is right for an org being set up at that moment.
- **Clearing goes away.** `OrgOnboardingSettingsUpdate.onboarding_date` becomes
  required, `set_org_onboarding_date` no longer accepts `None`, and the Settings
  field loses its clear affordance and its "leave it empty" help text.
- The `IS NOT NULL` guards in `enforce_onboarding_cutoff`,
  `sync_opening_balance_journal` and `assign_courier_payouts` can stay as cheap
  defensive checks; they simply stop being reachable.

## 8. Check

One `backend/tests/test_onboarding_cutoff.py`: set a date, attempt a
pre-onboarding transaction entry, journal entry and bill, assert none landed;
insert one dated exactly on the onboarding date, assert it did.

## Deferred: Shopify window and the pre-onboarding courier tail

Superseded by `PRE_ONBOARDING_COURIER_PLAN.md`, which settles most of this:
the courier tail becomes a posted courier bill rather than an opening balance,
and the sync is a full backfill rather than a 60-day floor. The notes below are
kept only for the parts that plan still leaves open.

- `_compute_sync_window_start()` in `backend/app/services/shopify_sync.py`
  currently backfills `SHOPIFY_SYNC_WINDOW_DAYS = 60` days before *now* on a
  first sync. Flooring it at `onboarding_date - SHOPIFY_SYNC_WINDOW_DAYS`
  instead bounds how far back an org ever reaches, regardless of when it first
  syncs. Order *records* in that trailing window still land; their auto-postings
  are dropped by §2's trigger, which is the intended split.
- PostEx settlement lags orders by 1-2 months, so at onboarding there is a tail
  of orders placed but not yet settled. The existing CPR CSV upload
  (`POST /orders/upload-postex-csv`, `services/postex.py`) is the mechanism to
  reuse: orders the CSV shows as already settled net into the PostEx system
  ledger's `opening_balance`; orders still unsettled become normal open courier
  bills and flow through the ongoing machinery.
- No new opening-balance UI is needed for that. Every org gets a
  `system_key = 'courier_postex'` ledger at creation, `opening_balance` is
  editable via `PUT /ledgers/{id}` with no system-ledger restriction, and the
  ledger edit modal (`frontend/src/pages/finance/LedgerModals.tsx`) already
  exposes it.
- Small pre-existing gap worth fixing alongside: `SYSTEM_LEDGER_LABELS` in
  `frontend/src/logic/ledgers.ts` omits the courier system ledgers, so the edit
  modal's system banner shows the raw key ("System account (courier_postex)")
  instead of "PostEx". The backend already has the mapping
  (`COURIER_LEDGER_LABELS` in `app/couriers.py`).

Open question for that phase: should the CSV upload compute and pre-fill the
suggested PostEx opening balance, or should the admin read the CSV totals and
enter the number themselves?

# Organization Onboarding Date — Draft Plan

Status: draft, not yet implemented. Captures the design discussion before any
migrations/code are written.

## Goal

Let an org have an `onboarding_date` — normally the day the customer starts
using the software, but adjustable by an admin — such that:

- Transactions, journal entries, and ledgers start strictly from that date;
  opening balances are shown as of that date.
- Shopify order sync only reaches back to 2 months prior to that date (not
  further, and not based on "now").
- The 2-month trailing window is reconciled via admin-uploaded historical
  PostEx CSVs, producing (a) an opening balance and (b) a "remaining bill" of
  orders still unsettled with the courier at onboarding time.

## Grounding in the current codebase

- Per-org settings already follow one pattern: a column on
  `system_organizations`, a small dedicated module
  (`backend/app/fiscal_settings.py`), and a `GET/PUT /org-settings/<name>`
  pair in `backend/app/routes/org_settings.py` (see the existing
  `/org-settings/fiscal` endpoints). The onboarding date should follow the
  same shape.
- Ledgers (`finances_ledgers`) already have a per-account `opening_balance`
  column, rebuilt into a single synthetic journal entry per org by the DB
  function `sync_opening_balance_journal(org_id)`, currently dated
  `MIN(entry_date) - 1`.
- Shopify order sync (`backend/app/services/shopify_sync.py`,
  `_compute_sync_window_start()`) backfills `SHOPIFY_SYNC_WINDOW_DAYS = 60`
  days from *now* on first sync, then proceeds incrementally.
- PostEx CSV reconciliation already exists end-to-end: upload endpoint
  (`POST /orders/upload-postex-csv` in `backend/app/routes/orders.py`),
  parsing (`backend/app/services/postex.py`), settlement matching against
  `shopify_orders`, and posting via `assign_courier_payouts` +
  `post_courier_payout_journal`. This is the mechanism to reuse for the
  historical trailing-window reconciliation rather than building something new.

## 1. Data model

- Add `onboarding_date DATE` to `system_organizations` via a new migration
  (same format as `20260905000000_org_fiscal_settings.sql`).
- Backfill existing orgs' `onboarding_date` (candidate: `created_at::date`,
  or the earliest existing journal/order date if earlier — see Open
  Questions).
- New `backend/app/onboarding_settings.py` mirroring `fiscal_settings.py`:
  `get_org_onboarding_date` / `set_org_onboarding_date`.
- Add `GET/PUT /org-settings/onboarding` to `routes/org_settings.py`, same
  shape as `/org-settings/fiscal`.
- Surface `onboarding_date` on `AccountPublic` so the frontend can gate UI
  without an extra fetch.

## 2. Enforcing "nothing before onboarding_date"

- Validate at the app/route layer (consistent with how `org_table()` rather
  than RLS is the real tenant-isolation mechanism in this codebase): reject
  `entry_date < onboarding_date` in `routes/transactions.py`,
  `routes/journal.py`, and bill creation.
- Change `sync_opening_balance_journal(org_id)` so the synthetic
  opening-balance entry is dated at `onboarding_date` (falling back to the
  current "day before earliest transaction" heuristic only when
  `onboarding_date` is unset).

## 3. Bounding the Shopify order sync

- Change `_compute_sync_window_start()`'s backfill floor from
  "`SHOPIFY_SYNC_WINDOW_DAYS` days before now" to
  "`SHOPIFY_SYNC_WINDOW_DAYS` days before `onboarding_date`" — sync never
  reaches further back than that, regardless of when the org actually first
  syncs.
- This is the one deliberate exception to "nothing before onboarding_date":
  *order records* in the trailing 2 months get synced (so CSV reconciliation
  in step 4 has something to match against), but no *financial entries* get
  posted at their real, pre-onboarding dates because of the rule in §2.

## 4. Historical reconciliation for the trailing 2 months

Read on the intent: PostEx settlement lags orders by roughly 1-2 months, so
at onboarding there's a tail of orders already placed but not yet settled
with the courier. Plan is to reuse the existing `upload-postex-csv` flow
rather than build a parallel one:

- Admin uploads the same kind of CPR CSVs they'd use normally, covering the
  trailing 2-month window.
- Orders the CSV shows as **already settled** → don't post individual
  journal entries at their real (pre-onboarding) dates (barred by §2);
  instead **net their financial effect into the relevant ledgers'
  `opening_balance`** (Cash/Courier-receivable, Sales Returns, Delivery
  Charges, Withholding Tax), dated as of onboarding via the opening-balance
  journal.
- Orders the CSV shows as **still unsettled** → become a normal open
  `shopify_courier_bill` and flow through the existing ongoing
  reconciliation machinery after onboarding, same as any new order.

## 5. UX flow (draft)

1. Org admin sets/confirms `onboarding_date` (default = signup day) — a
   one-time "Getting Started" step, editable later from Settings.
2. Once confirmed, system runs the bounded Shopify sync (§3) to pull in the
   trailing 2-month + ongoing orders.
3. Admin is prompted to upload historical PostEx CSV(s) for that trailing
   window.
4. System shows a review screen with the computed opening-balance
   adjustments + the list of "remaining" unsettled orders, before posting
   (money is involved — avoid auto-posting silently).
5. Confirm → opening balances posted, remaining orders become live courier
   bills, normal operation begins.

## Open questions

- **Mandatory vs. optional**: is `onboarding_date` set once at org creation
  (superadmin, in `admin_portal.py`) and locked, or admin-editable anytime
  from Settings?
- **Changing it after data exists**: if an org already has journal entries,
  should changing `onboarding_date` be blocked/warned if it would move later
  than existing entries?
- **"2 months"**: exactly 60 days (matches the existing
  `SHOPIFY_SYNC_WINDOW_DAYS` constant) or calendar months?
- **Review step**: should the opening-balance numbers derived from the
  historical CSV be admin-reviewed/editable before posting, or fully
  automatic?
- **Reuse vs. new endpoint**: extend `upload-postex-csv` with an
  "onboarding mode" flag, or build a separate onboarding-specific upload
  endpoint, since the accounting treatment (net-into-opening-balance vs.
  per-order posting) differs?

## Next step

Once the open questions above are resolved, turn this into a concrete
implementation plan: migrations, endpoints, and frontend screens.

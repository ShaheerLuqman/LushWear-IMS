-- Replaces the hardcoded ORDERS_LEDGER_ID constant (backend/app/advance_status.py
-- and frontend/js/cashbook.js both carried the literal UUID
-- '4bc067af-cf91-4700-8b52-b70ad4a991df') with a per-org role flag on the ledger
-- itself. See FINANCE_ACCOUNTING_PLAN.md §C6.
--
-- The constant predates multi-tenancy. Every lookup that used it is org-scoped,
-- so for any org other than the one that UUID belongs to the advance flow
-- matched nothing and silently did nothing - order advances could not be
-- recorded and advance_status never reconciled.
--
-- A flag on the row rather than a settings key: it is self-describing, the
-- partial unique index below makes "at most one per org" an invariant the
-- database enforces, and it becomes accounts.is_system when the chart of
-- accounts lands in Phase 1.

ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS is_orders_ledger BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_one_orders_ledger_per_org
    ON ledgers (org_id) WHERE is_orders_ledger;

-- Backfill only the ledger the old constant pointed at, so the org that already
-- worked keeps working. Other orgs are deliberately left unset: the advance flow
-- was already inert for them, and silently activating it here (e.g. by matching
-- on a ledger named 'Orders') would start writing advance_status against a
-- ledger nobody chose. They now get a clear "no Orders ledger set" error and can
-- pick one from the edit-ledger UI.
UPDATE ledgers
SET is_orders_ledger = TRUE
WHERE id = '4bc067af-cf91-4700-8b52-b70ad4a991df';

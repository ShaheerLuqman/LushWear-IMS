-- Phase 1, part 1: the double-entry core. See FINANCE_ACCOUNTING_PLAN.md Phase 1.
--
-- Until now every transaction was a single cashbook_entries row with one folio
-- ledger and an implicit, invisible cash account on the other side. That made
-- non-cash transactions (credit purchase, accrual, stock write-off, opening AP)
-- literally unrepresentable, and meant nothing could prove the books balanced.
--
-- This migration adds the ledger every other module will post into. It does NOT
-- change how the Cashbook is written - part 2 projects existing and future
-- cashbook entries into the journal, so the app keeps working unchanged while
-- reports move onto the journal.

-- ---------------------------------------------------------------------------
-- Chart-of-accounts columns on `ledgers`
-- ---------------------------------------------------------------------------
-- Deliberately NOT renamed to `accounts`: the rename would cascade through
-- every route, the frontend, the RLS list and the org-scope lint for no
-- functional gain, and "Ledgers" is what the UI and the user already call
-- these. `ledgers` IS the chart of accounts.
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS code              VARCHAR(20);
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS parent_id         UUID REFERENCES ledgers(id);
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS subtype           VARCHAR(50);
-- System accounts are created by migration, referenced by posting code via
-- `system_key`, and must not be deleted or renamed away by a user.
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS system_key        VARCHAR(40);
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS is_cash_equivalent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS enabled           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS archived_at       TIMESTAMPTZ;

-- One account per system role per org (e.g. exactly one 'cash', one 'accounts_payable').
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_system_key
    ON ledgers (org_id, system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_code
    ON ledgers (org_id, code) WHERE code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- journal_entries: the voucher header
-- ---------------------------------------------------------------------------
-- source_type/source_id link a posted entry back to whatever produced it, so a
-- document can find (and re-post) its own accounting without guessing:
--   'cashbook_entry' -> cashbook_entries.id (written by the part-2 projection)
--   'opening_balance'-> NULL (the one per-org opening entry)
--   'manual'         -> NULL (hand-written journal)
-- Phase 2/3 add 'bill' and 'invoice'.
CREATE TABLE IF NOT EXISTS journal_entries (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES organizations(id),
    entry_date     DATE NOT NULL,
    voucher_type   VARCHAR(30) NOT NULL DEFAULT 'manual',
    narration      TEXT,
    source_type    VARCHAR(30),
    source_id      UUID,
    -- Set when the entry is posted; a reversal points at what it reverses.
    -- Posted entries are corrected by a reversing entry, never edited in place
    -- (FINANCE_ACCOUNTING_PLAN.md C1) - Phase 5 adds the immutability trigger.
    reversal_of_id UUID REFERENCES journal_entries(id),
    created_by     UUID REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one journal entry per source row, so re-projecting a cashbook entry
-- updates its entry instead of silently posting the amount twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_source
    ON journal_entries (org_id, source_type, source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date ON journal_entries (org_id, entry_date);

-- ---------------------------------------------------------------------------
-- journal_lines: the debits and credits
-- ---------------------------------------------------------------------------
-- Amounts are stored unsigned in two columns rather than one signed column:
-- that is the form every statement, trial balance and audit expects, and it
-- makes "exactly one side per line" a CHECK rather than a convention.
CREATE TABLE IF NOT EXISTS journal_lines (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES organizations(id),
    journal_id  UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id  UUID NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
    debit       DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (debit  >= 0),
    credit      DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (credit >= 0),
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A line is one side or the other, never both and never neither.
    CONSTRAINT journal_lines_one_side_only CHECK (
        (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_journal_id ON journal_lines (journal_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account_id ON journal_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_org_id     ON journal_lines (org_id);

-- ---------------------------------------------------------------------------
-- Debits = credits, enforced by the database
-- ---------------------------------------------------------------------------
-- DEFERRABLE INITIALLY DEFERRED so the check runs once at COMMIT, after all of
-- an entry's lines are in. Header and lines therefore have to be written in one
-- transaction - which is why posting goes through the post_journal_entry()
-- function rather than two PostgREST calls.
CREATE OR REPLACE FUNCTION trg_journal_entry_must_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_journal_id UUID;
    v_debit  NUMERIC(14, 2);
    v_credit NUMERIC(14, 2);
BEGIN
    v_journal_id := COALESCE(NEW.journal_id, OLD.journal_id);

    -- The whole entry may have been deleted in this transaction (lines cascade);
    -- there is nothing left to balance.
    IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = v_journal_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
      INTO v_debit, v_credit
      FROM journal_lines
     WHERE journal_id = v_journal_id;

    IF v_debit <> v_credit THEN
        RAISE EXCEPTION
            'Journal entry % does not balance: debits %, credits %',
            v_journal_id, v_debit, v_credit;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_must_balance ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_must_balance
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_journal_entry_must_balance();

-- A header with no lines would otherwise slip past the line trigger entirely.
CREATE OR REPLACE FUNCTION trg_journal_entry_must_have_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;
    IF (SELECT COUNT(*) FROM journal_lines WHERE journal_id = NEW.id) < 2 THEN
        RAISE EXCEPTION 'Journal entry % must have at least two lines', NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS journal_entries_must_have_lines ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_must_have_lines
AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_journal_entry_must_have_lines();

-- Defense-in-depth only; app.org_scope.org_table() is the real isolation
-- boundary (see 20260730100000_rls_default_deny_business_tables.sql).
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines   ENABLE ROW LEVEL SECURITY;

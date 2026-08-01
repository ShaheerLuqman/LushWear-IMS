-- Phase 1, part 2: seed the system accounts, move every existing transaction and
-- opening balance into the journal, and make ledger_balances read from it.
--
-- After this migration the journal is the complete record of every posting, and
-- `ledger_balances` is derived from it rather than from cashbook_entries - one
-- source of truth, no drift. cashbook_entries remains the *write* path for cash
-- transactions and is projected into the journal by trigger; part of Phase 1 as
-- planned was to rewrite the Cashbook UI onto journal lines directly, which is
-- deliberately deferred (see the note at the bottom of this file).

-- ---------------------------------------------------------------------------
-- 1. System accounts
-- ---------------------------------------------------------------------------
-- Only the two Phase 1 actually needs. Accounts Payable / Receivable, Sales,
-- COGS and Inventory are seeded by the phase that first posts to them, rather
-- than cluttering every org's Ledgers screen with zero-balance accounts that
-- nothing writes to yet.
--
-- `cash` is always CREATED, never adopted from a same-named existing ledger.
-- The cashbook's implicit cash pot is a different account from any user-made
-- ledger called "Cash": that ledger has its own entries posted against it as a
-- folio, and merging the two would double-count every one of them.
CREATE OR REPLACE FUNCTION ensure_system_ledger(
    p_org_id UUID,
    p_system_key VARCHAR,
    p_name VARCHAR,
    p_type VARCHAR,
    p_code VARCHAR,
    p_is_cash_equivalent BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id UUID;
    v_name VARCHAR := p_name;
    v_suffix INT := 1;
BEGIN
    SELECT id INTO v_id FROM ledgers WHERE org_id = p_org_id AND system_key = p_system_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    -- idx_ledgers_org_id_name_lower is a hard unique constraint, so fall back to
    -- a suffixed name rather than failing the migration on a name clash.
    WHILE EXISTS (
        SELECT 1 FROM ledgers WHERE org_id = p_org_id AND lower(name) = lower(v_name)
    ) LOOP
        v_suffix := v_suffix + 1;
        v_name := p_name || ' (' || v_suffix || ')';
    END LOOP;

    INSERT INTO ledgers (org_id, name, type, code, system_key, is_cash_equivalent, opening_balance)
    VALUES (p_org_id, v_name, p_type, p_code, p_system_key, p_is_cash_equivalent, 0)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'cash', 'Cash in Hand', 'Asset', '1000', TRUE);
        PERFORM ensure_system_ledger(org.id, 'opening_balance_equity', 'Opening Balance Equity', 'Equity', '3900');
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Opening balances become a real, balanced journal entry
-- ---------------------------------------------------------------------------
-- ledgers.opening_balance was a free-floating number with no contra entry: the
-- moment one was set, total debits stopped equalling total credits
-- (FINANCE_ACCOUNTING_PLAN.md A4). It now posts against Opening Balance Equity
-- like any other transaction. Rebuilt wholesale rather than patched line by
-- line so it is idempotent and re-runnable.
CREATE OR REPLACE FUNCTION sync_opening_balance_journal(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_obe_id     UUID;
    v_journal_id UUID;
    v_net        NUMERIC(14, 2);
    v_date       DATE;
BEGIN
    SELECT id INTO v_obe_id
      FROM ledgers WHERE org_id = p_org_id AND system_key = 'opening_balance_equity';
    IF v_obe_id IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM journal_entries
     WHERE org_id = p_org_id AND source_type = 'opening_balance';

    SELECT COALESCE(SUM(opening_balance), 0) INTO v_net
      FROM ledgers
     WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    -- Nothing to open with; the net being zero is not the same as there being
    -- no opening balances, so this tests for rows, not for v_net.
    IF NOT EXISTS (
        SELECT 1 FROM ledgers
         WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id
    ) THEN
        RETURN;
    END IF;

    -- Dated one day before the earliest transaction so opening balances always
    -- sort ahead of activity on a statement.
    SELECT COALESCE(MIN(entry_date), CURRENT_DATE) - 1 INTO v_date
      FROM cashbook_entries WHERE org_id = p_org_id;

    INSERT INTO journal_entries (org_id, entry_date, voucher_type, narration, source_type)
    VALUES (p_org_id, v_date, 'opening', 'Opening balances', 'opening_balance')
    RETURNING id INTO v_journal_id;

    -- opening_balance is stored Debit-positive, matching journal convention.
    INSERT INTO journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id, v_journal_id, id,
           CASE WHEN opening_balance > 0 THEN  opening_balance ELSE 0 END,
           CASE WHEN opening_balance < 0 THEN -opening_balance ELSE 0 END,
           'Opening balance'
      FROM ledgers
     WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    IF v_net <> 0 THEN
        INSERT INTO journal_lines (org_id, journal_id, account_id, debit, credit, description)
        VALUES (p_org_id, v_journal_id, v_obe_id,
                CASE WHEN v_net < 0 THEN -v_net ELSE 0 END,
                CASE WHEN v_net > 0 THEN  v_net ELSE 0 END,
                'Opening balance offset');
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Cashbook entries are projected into the journal
-- ---------------------------------------------------------------------------
-- One cashbook entry becomes one two-line journal entry between its folio
-- ledger and the system cash account. entry_type is the folio's side and cash
-- always takes the opposite one - see "THE TWO PERSPECTIVES" in
-- supabase_schema.sql.
CREATE OR REPLACE FUNCTION project_cashbook_entry_to_journal(p_entry_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    e            RECORD;
    v_cash_id    UUID;
    v_journal_id UUID;
BEGIN
    SELECT * INTO e FROM cashbook_entries WHERE id = p_entry_id;

    IF NOT FOUND THEN
        DELETE FROM journal_entries
         WHERE source_type = 'cashbook_entry' AND source_id = p_entry_id;
        RETURN;
    END IF;

    SELECT id INTO v_cash_id
      FROM ledgers WHERE org_id = e.org_id AND system_key = 'cash';
    IF v_cash_id IS NULL THEN
        RAISE EXCEPTION 'Organization % has no system cash account', e.org_id;
    END IF;

    -- Rebuild rather than patch: an edited entry can change date, amount,
    -- direction or folio, and re-posting from scratch cannot drift.
    DELETE FROM journal_entries
     WHERE source_type = 'cashbook_entry' AND source_id = p_entry_id;

    INSERT INTO journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id)
    VALUES
        (e.org_id, e.entry_date, 'cashbook', e.description, 'cashbook_entry', e.id)
    RETURNING id INTO v_journal_id;

    IF e.entry_type = 'credit' THEN
        -- Cash received: debit cash, credit the folio ledger.
        INSERT INTO journal_lines (org_id, journal_id, account_id, debit, credit, description)
        VALUES (e.org_id, v_journal_id, v_cash_id, e.amount, 0, e.description),
               (e.org_id, v_journal_id, e.folio,   0, e.amount, e.description);
    ELSE
        -- Cash paid: debit the folio ledger, credit cash.
        INSERT INTO journal_lines (org_id, journal_id, account_id, debit, credit, description)
        VALUES (e.org_id, v_journal_id, e.folio,   e.amount, 0, e.description),
               (e.org_id, v_journal_id, v_cash_id, 0, e.amount, e.description);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_project_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM journal_entries
         WHERE source_type = 'cashbook_entry' AND source_id = OLD.id;
        RETURN OLD;
    END IF;

    PERFORM project_cashbook_entry_to_journal(NEW.id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_journal_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_journal_trigger
AFTER INSERT OR UPDATE OF entry_date, entry_type, amount, folio, description OR DELETE
ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION trg_cashbook_entries_project_journal();

-- ---------------------------------------------------------------------------
-- 4. ledger_balances now derives from the journal
-- ---------------------------------------------------------------------------
-- Widened to match journal_lines' DECIMAL(14, 2). A balance is a sum over many
-- lines, so it can legitimately exceed the width of any single amount, and the
-- old DECIMAL(12, 2) would raise a numeric overflow rather than truncate.
ALTER TABLE ledger_balances ALTER COLUMN balance TYPE DECIMAL(14, 2);

-- Same formula and same Debit-positive convention as before, so every existing
-- consumer (Cash In Hand, the ledger statement, the Ledger API) keeps working -
-- but opening_balance is no longer added separately here, because it is now a
-- journal line of its own. Adding it again would double-count it.
CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC(14, 2);
    v_org_id  UUID;
BEGIN
    SELECT org_id INTO v_org_id FROM ledgers WHERE id = p_ledger_id;
    IF v_org_id IS NULL THEN
        DELETE FROM ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    SELECT COALESCE(SUM(debit) - SUM(credit), 0) INTO v_balance
      FROM journal_lines WHERE account_id = p_ledger_id;

    IF v_balance = 0 THEN
        DELETE FROM ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    INSERT INTO ledger_balances (ledger_id, org_id, balance, updated_at)
    VALUES (p_ledger_id, v_org_id, v_balance, NOW())
    ON CONFLICT (ledger_id) DO UPDATE SET
        balance    = EXCLUDED.balance,
        org_id     = EXCLUDED.org_id,
        updated_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION trg_journal_lines_recalc_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalc_ledger_balance(OLD.account_id);
        RETURN OLD;
    END IF;

    PERFORM recalc_ledger_balance(NEW.account_id);
    IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
        PERFORM recalc_ledger_balance(OLD.account_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_balance_trigger ON journal_lines;
CREATE TRIGGER journal_lines_balance_trigger
AFTER INSERT OR UPDATE OF account_id, debit, credit OR DELETE ON journal_lines
FOR EACH ROW
EXECUTE FUNCTION trg_journal_lines_recalc_balance();

-- Superseded: cashbook writes now reach ledger_balances through the journal
-- projection above. Leaving it in place would recompute the same balance from
-- the old source and race the new one.
DROP TRIGGER IF EXISTS cashbook_entries_ledger_balance_trigger ON cashbook_entries;
DROP FUNCTION IF EXISTS trg_cashbook_entries_recalc_ledger_balance();

-- Editing ledgers.opening_balance now rewrites the opening journal entry rather
-- than being folded straight into a balance.
CREATE OR REPLACE FUNCTION trg_ledgers_recalc_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_opening_balance_journal(NEW.org_id);
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    org   RECORD;
    entry RECORD;
BEGIN
    FOR org IN SELECT id FROM organizations LOOP
        PERFORM sync_opening_balance_journal(org.id);

        FOR entry IN
            SELECT id FROM cashbook_entries WHERE org_id = org.id ORDER BY entry_date, created_at
        LOOP
            PERFORM project_cashbook_entry_to_journal(entry.id);
        END LOOP;
    END LOOP;
END $$;

-- Recompute every balance from the journal, including ledgers whose only
-- contribution was an opening balance.
DO $$
DECLARE
    l RECORD;
BEGIN
    FOR l IN SELECT id FROM ledgers LOOP
        PERFORM recalc_ledger_balance(l.id);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Deliberately NOT done here
-- ---------------------------------------------------------------------------
-- Phase 1 as planned also had the Cashbook screen read journal lines directly
-- instead of cashbook_entries. That is a rewrite of the entire cashbook write
-- path (create/bulk/update/delete, the daily-balance triggers, advance
-- reconciliation) and would land unverifiable in the same change as the schema
-- and the data migration. Projecting instead keeps one source of truth for
-- balances and reporting, leaves the app's behaviour identical, and lets the
-- cutover happen on its own once the journal has been running in production.
-- When it does, drop cashbook_entries_journal_trigger and write journal entries
-- from the API directly.

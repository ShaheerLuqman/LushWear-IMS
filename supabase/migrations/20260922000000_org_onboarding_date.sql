-- Per-org onboarding date: the day the organization starts using the software.
-- Nothing financial may exist before it - transaction entries, journal entries
-- (receipts and payments included, they are journal vouchers) and bills dated
-- earlier are refused. The org's pre-onboarding position is carried by ledger
-- opening balances dated at onboarding_date instead.
--
-- NULL means "no cutoff", so every org already using the app is unaffected
-- until an admin sets a date (and app/onboarding_settings.py only lets them
-- pick one at or before their earliest existing entry, so setting it never
-- invalidates data that is already there).
ALTER TABLE system_organizations
    ADD COLUMN IF NOT EXISTS onboarding_date DATE;

-- Enforced here rather than in the routes because most dated financial rows are
-- written by plpgsql, not by Python: sales posting, COGS, courier payout
-- journals and sync_opening_balance_journal all insert into
-- finances_journal_entries directly. A route-layer guard would miss them; this
-- catches every writer. routes/{transactions,journal,bills}.py still check the
-- date first, purely so a human gets a 400 with a message instead of a silent
-- no-op.
--
-- Skipping the row (RETURN NULL) rather than raising: the Shopify sync posts
-- for whatever orders it pulls, and raising would abort the whole sync the
-- moment it touched a pre-onboarding order.
CREATE OR REPLACE FUNCTION enforce_onboarding_cutoff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_onboarding DATE;
BEGIN
    SELECT onboarding_date INTO v_onboarding
      FROM system_organizations WHERE id = NEW.org_id;

    IF v_onboarding IS NOT NULL
       AND (to_jsonb(NEW) ->> TG_ARGV[0])::DATE < v_onboarding THEN
        RETURN NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transaction_entries_onboarding_cutoff ON finances_transaction_entries;
CREATE TRIGGER trg_transaction_entries_onboarding_cutoff
    BEFORE INSERT OR UPDATE ON finances_transaction_entries
    FOR EACH ROW EXECUTE FUNCTION enforce_onboarding_cutoff('entry_date');

DROP TRIGGER IF EXISTS trg_journal_entries_onboarding_cutoff ON finances_journal_entries;
CREATE TRIGGER trg_journal_entries_onboarding_cutoff
    BEFORE INSERT OR UPDATE ON finances_journal_entries
    FOR EACH ROW EXECUTE FUNCTION enforce_onboarding_cutoff('entry_date');

DROP TRIGGER IF EXISTS trg_bills_onboarding_cutoff ON finances_bills;
CREATE TRIGGER trg_bills_onboarding_cutoff
    BEFORE INSERT OR UPDATE ON finances_bills
    FOR EACH ROW EXECUTE FUNCTION enforce_onboarding_cutoff('bill_date');

-- Opening balances are "as at" the onboarding date, so the synthetic entry is
-- dated there instead of a day before the earliest transaction. That older
-- heuristic stays as the fallback for orgs with no onboarding_date - switching
-- them to anything later could land the opening entry after backdated entries
-- and break their running balances.
--
-- Unchanged from 20260808120000_rename_cashbook_to_transactions.sql apart from
-- how v_date is chosen.
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
      FROM finances_ledgers WHERE org_id = p_org_id AND system_key = 'opening_balance_equity';
    IF v_obe_id IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM finances_journal_entries WHERE org_id = p_org_id AND source_type = 'opening_balance';

    SELECT COALESCE(SUM(opening_balance), 0) INTO v_net
      FROM finances_ledgers WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    IF NOT EXISTS (
        SELECT 1 FROM finances_ledgers
         WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id
    ) THEN
        RETURN;
    END IF;

    SELECT onboarding_date INTO v_date FROM system_organizations WHERE id = p_org_id;
    IF v_date IS NULL THEN
        SELECT COALESCE(MIN(entry_date), CURRENT_DATE) - 1 INTO v_date
          FROM finances_transaction_entries WHERE org_id = p_org_id;
    END IF;

    INSERT INTO finances_journal_entries (org_id, entry_date, voucher_type, narration, source_type)
    VALUES (p_org_id, v_date, 'opening', 'Opening balances', 'opening_balance')
    RETURNING id INTO v_journal_id;

    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id, v_journal_id, id,
           CASE WHEN opening_balance > 0 THEN  opening_balance ELSE 0 END,
           CASE WHEN opening_balance < 0 THEN -opening_balance ELSE 0 END,
           'Opening balance'
      FROM finances_ledgers
     WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    IF v_net <> 0 THEN
        INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
        VALUES (p_org_id, v_journal_id, v_obe_id,
                CASE WHEN v_net < 0 THEN -v_net ELSE 0 END,
                CASE WHEN v_net > 0 THEN  v_net ELSE 0 END,
                'Opening balance offset');
    END IF;
END;
$$;

-- The opening entry no longer sorts first by being dated a day earlier - with an
-- onboarding_date it shares its date with the org's first real entries, and it
-- is rebuilt (deleted and reinserted) on every opening-balance change, so its
-- created_at is always the newest and it would otherwise sort last within that
-- date. Ordering the opening voucher first fixes that; everything else is
-- unchanged from 20260819030000_ledger_statement_source_id.sql.
CREATE OR REPLACE FUNCTION get_ledger_statement(p_org_id UUID, p_ledger_id UUID)
RETURNS TABLE(
    id           UUID,
    entry_date   DATE,
    particulars  TEXT,
    debit        NUMERIC,
    credit       NUMERIC,
    voucher_type VARCHAR,
    source_type  VARCHAR,
    source_id    UUID
)
LANGUAGE sql
STABLE
AS $$
    SELECT jl.id,
           je.entry_date,
           COALESCE(NULLIF(jl.description, ''), je.narration, '') AS particulars,
           jl.debit,
           jl.credit,
           je.voucher_type,
           je.source_type,
           je.source_id
      FROM finances_journal_lines jl
      JOIN finances_journal_entries je ON je.id = jl.journal_id
     WHERE jl.org_id = p_org_id
       AND jl.account_id = p_ledger_id
     ORDER BY je.entry_date, (je.voucher_type = 'opening') DESC, je.created_at, jl.created_at;
$$;

-- Phase 1, part 3: the write path and the proof.
--
-- post_journal_entry is the only supported way to create a journal entry from
-- the application. Header and lines have to land in one transaction for the
-- deferred balance constraint to be checkable at all - two PostgREST calls are
-- two transactions, and the first would fail on its own.

CREATE OR REPLACE FUNCTION post_journal_entry(
    p_org_id       UUID,
    p_entry_date   DATE,
    p_lines        JSONB,
    p_narration    TEXT DEFAULT NULL,
    p_voucher_type VARCHAR DEFAULT 'manual',
    p_created_by   UUID DEFAULT NULL,
    p_source_type  VARCHAR DEFAULT NULL,
    p_source_id    UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_journal_id UUID;
    v_debit      NUMERIC(14, 2);
    v_credit     NUMERIC(14, 2);
    v_count      INT;
    v_foreign    INT;
BEGIN
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
        RAISE EXCEPTION 'lines must be a JSON array';
    END IF;

    SELECT COUNT(*),
           COALESCE(SUM((l->>'debit')::NUMERIC), 0),
           COALESCE(SUM((l->>'credit')::NUMERIC), 0)
      INTO v_count, v_debit, v_credit
      FROM jsonb_array_elements(p_lines) AS l;

    IF v_count < 2 THEN
        RAISE EXCEPTION 'A journal entry needs at least two lines, got %', v_count;
    END IF;

    IF v_debit <> v_credit THEN
        RAISE EXCEPTION
            'Journal entry does not balance: debits %, credits %', v_debit, v_credit;
    END IF;

    IF v_debit = 0 THEN
        RAISE EXCEPTION 'A journal entry must move a non-zero amount';
    END IF;

    -- Every account must belong to the posting org. Without this an org could
    -- post into another's chart of accounts by passing a foreign account_id -
    -- the id is client-supplied, unlike p_org_id.
    SELECT COUNT(*) INTO v_foreign
      FROM jsonb_array_elements(p_lines) AS l
     WHERE NOT EXISTS (
         SELECT 1 FROM ledgers
          WHERE id = (l->>'account_id')::UUID AND org_id = p_org_id
     );
    IF v_foreign > 0 THEN
        RAISE EXCEPTION 'Journal lines reference % account(s) outside this organization', v_foreign;
    END IF;

    INSERT INTO journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id, created_by)
    VALUES
        (p_org_id, p_entry_date, p_voucher_type, p_narration, p_source_type, p_source_id, p_created_by)
    RETURNING id INTO v_journal_id;

    INSERT INTO journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id,
           v_journal_id,
           (l->>'account_id')::UUID,
           COALESCE((l->>'debit')::NUMERIC, 0),
           COALESCE((l->>'credit')::NUMERIC, 0),
           l->>'description'
      FROM jsonb_array_elements(p_lines) AS l;

    RETURN v_journal_id;
END;
$$;


-- Trial balance as of a date: every account with a non-zero balance, split into
-- its Debit or Credit column. The two column totals being equal is the proof
-- that the books balance - the control that did not exist before Phase 1
-- (FINANCE_ACCOUNTING_PLAN.md A5).
--
-- Accounts whose balance nets to exactly zero are omitted, as on a conventional
-- trial balance; they contribute nothing to either total.
CREATE OR REPLACE FUNCTION get_trial_balance(p_org_id UUID, p_as_of DATE)
RETURNS TABLE(
    account_id   UUID,
    code         VARCHAR,
    name         VARCHAR,
    type         VARCHAR,
    debit        NUMERIC,
    credit       NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH balances AS (
        SELECT l.id, l.code, l.name, l.type,
               COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS net
          FROM ledgers l
          JOIN journal_lines jl    ON jl.account_id = l.id
          JOIN journal_entries je  ON je.id = jl.journal_id
         WHERE l.org_id = p_org_id
           AND je.org_id = p_org_id
           AND je.entry_date <= p_as_of
         GROUP BY l.id, l.code, l.name, l.type
    )
    SELECT id, code, name, type,
           CASE WHEN net > 0 THEN  net ELSE 0 END,
           CASE WHEN net < 0 THEN -net ELSE 0 END
      FROM balances
     WHERE net <> 0
     ORDER BY code NULLS LAST, name;
$$;

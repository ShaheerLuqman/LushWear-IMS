-- The ledger statement reads the journal, not cashbook_entries.
--
-- Phase 1 repointed recalc_ledger_balance at journal_lines but left
-- GET /ledgers/{id}/entries reading cashbook_entries, so anything posted to the
-- journal by something other than the cashbook was invisible on the statement
-- while still counting towards the balance. A received bill credits its
-- supplier, so the supplier's balance moved but no row explained why, and the
-- statement's running total no longer reconciled with the balance shown on the
-- ledger card, in Cash In Hand, or on the trial balance.
--
-- Reading the journal fixes all of it at once: bills, manual journal entries and
-- opening balances now appear alongside cashbook entries, because they are all
-- journal lines on the same account.

CREATE OR REPLACE FUNCTION get_ledger_statement(p_org_id UUID, p_ledger_id UUID)
RETURNS TABLE(
    id           UUID,
    entry_date   DATE,
    particulars  TEXT,
    debit        NUMERIC,
    credit       NUMERIC,
    voucher_type VARCHAR,
    source_type  VARCHAR
)
LANGUAGE sql
STABLE
AS $$
    SELECT jl.id,
           je.entry_date,
           -- The line's own description is the specific one ("Bill BILL-0001");
           -- the entry narration is the fallback for lines posted without one.
           COALESCE(NULLIF(jl.description, ''), je.narration, '') AS particulars,
           jl.debit,
           jl.credit,
           je.voucher_type,
           je.source_type
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_id
     WHERE jl.org_id = p_org_id
       AND jl.account_id = p_ledger_id
     -- created_at breaks ties within a date so the running balance is stable
     -- across reloads; the opening entry is dated a day earlier and sorts first.
     ORDER BY je.entry_date, je.created_at, jl.created_at;
$$;

-- Ledger statement rows now carry source_id alongside source_type, so a
-- statement line ("Bill BILL-0001", "Transaction ...") can link back to the
-- exact bill/transaction entry that produced it instead of only naming its kind.
--
-- Postgres won't let CREATE OR REPLACE change a table-returning function's
-- column list ("cannot change return type of existing function") - drop it first.
DROP FUNCTION IF EXISTS get_ledger_statement(UUID, UUID);

CREATE FUNCTION get_ledger_statement(p_org_id UUID, p_ledger_id UUID)
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
           -- The line's own description is the specific one ("Bill BILL-0001");
           -- the entry narration is the fallback for lines posted without one.
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
     -- created_at breaks ties within a date so the running balance is stable
     -- across reloads; the opening entry is dated a day earlier and sorts first.
     ORDER BY je.entry_date, je.created_at, jl.created_at;
$$;

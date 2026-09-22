-- Moving an org's onboarding date *forward*, onto a middle point of its own
-- history: everything financial before the new date is deleted and its net
-- effect is folded into each ledger's opening_balance, so the books still add
-- up to the same numbers - the removed entries simply collapse into the single
-- "Opening balances" voucher dated at the new onboarding date.
--
-- Irreversible. Setting the date backwards or onto untouched history needs none
-- of this and goes through app/onboarding_settings.py's plain setter instead.
--
-- Scope is exactly the three tables the cutoff trigger guards: transaction
-- entries, journal entries (receipts/payments included) and bills. Orders,
-- courier bills and stock levels are left alone - stock added by a purged bill
-- stays applied, which is the inventory equivalent of preserving an opening
-- balance. Deleted transaction entries are captured by the existing
-- finances_transaction_entry_audit_log trigger.
CREATE OR REPLACE FUNCTION apply_onboarding_cutoff(p_org_id UUID, p_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_current  DATE;
    v_obe_id   UUID;
    v_entries  INT;
    v_journals INT;
    v_bills    INT;
BEGIN
    SELECT onboarding_date INTO v_current FROM system_organizations WHERE id = p_org_id;
    IF v_current IS NOT NULL AND p_date <= v_current THEN
        RAISE EXCEPTION 'Onboarding date is already %; use the plain setter to move it back', v_current;
    END IF;

    SELECT id INTO v_obe_id
      FROM finances_ledgers WHERE org_id = p_org_id AND system_key = 'opening_balance_equity';

    -- Set first so the opening voucher rebuilt below is dated at the new cutoff
    -- and the enforce_onboarding_cutoff trigger starts refusing stragglers.
    UPDATE system_organizations SET onboarding_date = p_date WHERE id = p_org_id;

    -- Each ledger's new opening balance is its whole pre-cutoff journal
    -- position. The old opening voucher's own lines are part of that sum, which
    -- is why the previous opening_balance is not added again (recalc_ledger_balance
    -- deliberately excludes it too). Opening Balance Equity is skipped: it is the
    -- balancing plug that sync_opening_balance_journal re-derives.
    UPDATE finances_ledgers l
       SET opening_balance = c.balance
      FROM (
          SELECT jl.account_id, SUM(jl.debit - jl.credit) AS balance
            FROM finances_journal_lines jl
            JOIN finances_journal_entries je ON je.id = jl.journal_id
           WHERE jl.org_id = p_org_id
             AND je.entry_date < p_date
           GROUP BY jl.account_id
      ) c
     WHERE l.id = c.account_id
       AND l.id IS DISTINCT FROM v_obe_id
       -- Every row touched here fires ledgers_opening_balance_trigger, which
       -- rebuilds the whole opening voucher - skip the rows that would not change.
       AND l.opening_balance IS DISTINCT FROM c.balance;

    DELETE FROM finances_transaction_entries
     WHERE org_id = p_org_id AND entry_date < p_date;
    GET DIAGNOSTICS v_entries = ROW_COUNT;

    -- A surviving reversal pointing at a purged entry would block the delete
    -- (reversal_of_id has no ON DELETE action); the link is meaningless once its
    -- target is gone.
    UPDATE finances_journal_entries
       SET reversal_of_id = NULL
     WHERE org_id = p_org_id
       AND reversal_of_id IN (
           SELECT id FROM finances_journal_entries
            WHERE org_id = p_org_id AND entry_date < p_date
       );

    DELETE FROM finances_journal_entries
     WHERE org_id = p_org_id AND entry_date < p_date;
    GET DIAGNOSTICS v_journals = ROW_COUNT;

    DELETE FROM finances_bills
     WHERE org_id = p_org_id AND bill_date < p_date;
    GET DIAGNOSTICS v_bills = ROW_COUNT;

    -- The UPDATE above already rebuilt it via the trigger, unless no ledger's
    -- balance actually changed (an org with nothing before the cutoff).
    PERFORM sync_opening_balance_journal(p_org_id);

    RETURN jsonb_build_object(
        'onboarding_date', p_date,
        'transaction_entries_deleted', v_entries,
        'journal_entries_deleted', v_journals,
        'bills_deleted', v_bills
    );
END;
$$;

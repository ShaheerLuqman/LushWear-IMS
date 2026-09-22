-- apply_onboarding_cutoff no longer rolls pre-cutoff activity into each ledger's
-- opening_balance. The opening balance is a figure the admin maintains (it is
-- what the courier/CSV reconciliation produces, and what the ledger edit modal
-- writes); the purge keeps it exactly as it stands and simply discards the
-- entries between it and the new onboarding date.
--
-- Consequence, deliberately accepted: this is NOT balance-preserving. Every
-- ledger loses whatever the deleted entries contributed, so the trial balance
-- after a purge reflects the stored opening balances plus post-cutoff activity
-- only. Setting those opening balances to the right figures is the admin's job,
-- through the ledger edit modal, as before.
--
-- Everything else is unchanged from 20260922010000_onboarding_cutoff_purge.sql.
CREATE OR REPLACE FUNCTION apply_onboarding_cutoff(p_org_id UUID, p_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_current  DATE;
    v_entries  INT;
    v_journals INT;
    v_bills    INT;
BEGIN
    SELECT onboarding_date INTO v_current FROM system_organizations WHERE id = p_org_id;
    IF v_current IS NOT NULL AND p_date <= v_current THEN
        RAISE EXCEPTION 'Onboarding date is already %; use the plain setter to move it back', v_current;
    END IF;

    -- Set first so the opening voucher rebuilt below is dated at the new cutoff
    -- and the enforce_onboarding_cutoff trigger starts refusing stragglers.
    UPDATE system_organizations SET onboarding_date = p_date WHERE id = p_org_id;

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

    -- This also removes the old opening voucher, which is pre-cutoff by
    -- definition; the rebuild below re-posts it from the unchanged
    -- opening_balance columns, dated at the new onboarding date.
    DELETE FROM finances_journal_entries
     WHERE org_id = p_org_id AND entry_date < p_date;
    GET DIAGNOSTICS v_journals = ROW_COUNT;

    DELETE FROM finances_bills
     WHERE org_id = p_org_id AND bill_date < p_date;
    GET DIAGNOSTICS v_bills = ROW_COUNT;

    PERFORM sync_opening_balance_journal(p_org_id);

    RETURN jsonb_build_object(
        'onboarding_date', p_date,
        'transaction_entries_deleted', v_entries,
        'journal_entries_deleted', v_journals,
        'bills_deleted', v_bills
    );
END;
$$;

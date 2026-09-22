-- Moving the onboarding date forward must clear out any pre-onboarding bill.
--
-- The purge deletes vouchers, not bill rows, so without this an org that already
-- built a pre-onboarding bill and then moves its date forward is left with a
-- stale one dated at the *old* onboarding date. Three things break:
--
-- 1. idx_courier_bills_pre_onboarding allows one per (org, courier), so
--    sync_pre_onboarding_bill would reuse the stale bill instead of creating one
--    at the new date, and post it at the old date - where enforce_onboarding_cutoff
--    drops the header and post_journal_entry returns NULL. The new tail would
--    silently never get a receivable.
-- 2. If it did post, the settlements that cleared its members were themselves
--    deleted by the purge, so the courier ledger would carry that receivable
--    forever.
-- 3. It shows in the Courier Payment Report dated before the org's own start.
--
-- Deleting is right rather than re-dating: everything before the new date is
-- being discarded, so the bill's members belong to the discarded period too. The
-- FK is ON DELETE SET NULL, so their courier_bill_id clears and the next
-- assign_courier_bills regroups them onto ordinary pickup-date bills, which post
-- nothing because they are pre-cutoff. A fresh bill for the new tail is built by
-- the onboarding flow at the new date.
--
-- Unchanged from 20260922020000_cutoff_keeps_existing_opening_balance.sql apart
-- from that delete.
CREATE OR REPLACE FUNCTION apply_onboarding_cutoff(p_org_id UUID, p_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_current  DATE;
    v_entries  INT;
    v_journals INT;
    v_bills    INT;
    v_pre      INT;
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

    DELETE FROM shopify_courier_bills
     WHERE org_id = p_org_id AND is_pre_onboarding;
    GET DIAGNOSTICS v_pre = ROW_COUNT;

    PERFORM sync_opening_balance_journal(p_org_id);

    RETURN jsonb_build_object(
        'onboarding_date', p_date,
        'transaction_entries_deleted', v_entries,
        'journal_entries_deleted', v_journals,
        'bills_deleted', v_bills,
        'pre_onboarding_bills_cleared', v_pre
    );
END;
$$;

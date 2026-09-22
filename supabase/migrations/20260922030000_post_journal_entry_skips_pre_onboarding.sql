-- enforce_onboarding_cutoff suppresses a pre-onboarding entry by returning NULL
-- from its BEFORE INSERT trigger, deliberately skipping the row rather than
-- raising (see 20260922000000_org_onboarding_date.sql - raising would abort a
-- whole Shopify sync the moment it touched one old order). post_journal_entry
-- never checked whether the header survived, so the suppressed insert left
-- v_journal_id NULL and the lines insert hit journal_lines.journal_id NOT NULL
-- instead - turning the intended silent skip into a 23502 that rolls back
-- whatever wrote the order.
--
-- Reached today by sync_period_cogs_journal: resolving the last open order in a
-- pre-onboarding fiscal period makes it post that period's COGS voucher, dated
-- before the cutoff. Guarding here rather than in that function covers
-- post_courier_bill_journal/post_courier_payout_journal too, which are shielded
-- only by journal_orders_from happening to sit at the same date.
--
-- Unchanged from supabase_schema.sql apart from the NULL check.
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
        RAISE EXCEPTION 'Journal entry does not balance: debits %, credits %', v_debit, v_credit;
    END IF;

    IF v_debit = 0 THEN
        RAISE EXCEPTION 'A journal entry must move a non-zero amount';
    END IF;

    -- Every account must belong to the posting org - account_id is
    -- client-supplied, unlike p_org_id.
    SELECT COUNT(*) INTO v_foreign
      FROM jsonb_array_elements(p_lines) AS l
     WHERE NOT EXISTS (
         SELECT 1 FROM finances_ledgers WHERE id = (l->>'account_id')::UUID AND org_id = p_org_id
     );
    IF v_foreign > 0 THEN
        RAISE EXCEPTION 'Journal lines reference % account(s) outside this organization', v_foreign;
    END IF;

    INSERT INTO finances_journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id, created_by)
    VALUES
        (p_org_id, p_entry_date, p_voucher_type, p_narration, p_source_type, p_source_id, p_created_by)
    RETURNING id INTO v_journal_id;

    IF v_journal_id IS NULL THEN
        RETURN NULL;
    END IF;

    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id, v_journal_id, (l->>'account_id')::UUID,
           COALESCE((l->>'debit')::NUMERIC, 0),
           COALESCE((l->>'credit')::NUMERIC, 0),
           l->>'description'
      FROM jsonb_array_elements(p_lines) AS l;

    RETURN v_journal_id;
END;
$$;

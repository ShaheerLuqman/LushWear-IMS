-- onboarding_date becomes mandatory: every org has a day its books start on.
-- Nullable was only ever a way to deploy the cutoff without changing behaviour
-- for orgs that predated it. Once journal_orders_from is gone (next migration)
-- this is the only gate left, and NULL meaning "post everything" is a trap.
--
-- Existing orgs take 2026-01-01, the date journal_orders_from has defaulted to
-- since the sales-journal cutover, so nothing about what posts changes.
--
-- The two dates do not mean the same thing, though: journal_orders_from gated
-- only order/courier postings, while onboarding_date also blocks transaction
-- entries, journal entries and bills. An org holding any of those before the
-- date would end up with rows sitting before its own cutoff - the state
-- set_org_onboarding_date's "not later than the earliest existing entry" check
-- exists to prevent, with a mis-sorted opening voucher as the visible symptom.
-- Such an org needs a deliberate decision (an earlier date, or a purge), so
-- this refuses to migrate it silently.
DO $$
DECLARE
    v_bad TEXT;
BEGIN
    SELECT string_agg(o.name || ' (earliest ' || e.earliest::TEXT || ')', ', ')
      INTO v_bad
      FROM system_organizations o
      CROSS JOIN LATERAL (
          SELECT MIN(d) AS earliest FROM (
              SELECT MIN(entry_date) AS d FROM finances_transaction_entries WHERE org_id = o.id
              UNION ALL
              SELECT MIN(entry_date) FROM finances_journal_entries WHERE org_id = o.id
              UNION ALL
              SELECT MIN(bill_date) FROM finances_bills WHERE org_id = o.id
          ) dates
      ) e
     WHERE o.onboarding_date IS NULL
       AND e.earliest IS NOT NULL
       AND e.earliest < o.journal_orders_from;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot default onboarding_date for org(s) holding finance rows before their journal_orders_from: %. Set each one deliberately first.', v_bad;
    END IF;
END $$;

UPDATE system_organizations
   SET onboarding_date = journal_orders_from
 WHERE onboarding_date IS NULL;

ALTER TABLE system_organizations
    ALTER COLUMN onboarding_date SET NOT NULL,
    -- New orgs are asked for it at creation (Superadmin Portal). The default
    -- covers auth_bootstrap, which creates the very first org before there is
    -- anyone to ask - "today" is right for an org being set up right now.
    ALTER COLUMN onboarding_date SET DEFAULT CURRENT_DATE;

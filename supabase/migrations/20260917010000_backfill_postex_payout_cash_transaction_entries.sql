-- One-time backfill: every courier payout posted before
-- 20260917000000_postex_payout_cash_as_transaction_entry.sql has its "Cash
-- Received" leg as a plain journal entry (source_type = 'courier_payout_cash'
-- on finances_journal_entries), which never showed up on the Transactions page.
--
-- post_courier_payout_journal rebuilds all of a payout's entries from scratch
-- (it deletes its own rows first, in both tables, before reposting), so simply
-- re-running it for every existing payout converts that leg to the new
-- finances_transaction_entries form - no separate DELETE needed here.
DO $$
DECLARE
    v_id UUID;
BEGIN
    ALTER TABLE finances_journal_lines DISABLE TRIGGER journal_lines_balance_trigger;

    FOR v_id IN SELECT id FROM finances_courier_payouts ORDER BY payout_date
    LOOP
        PERFORM post_courier_payout_journal(v_id);
    END LOOP;

    SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;
    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l;
END $$;

-- Full reset of courier payout postings, at the user's explicit request: drop every
-- receipt voucher regardless of what settled it, not just the ones tainted by
-- API-derived orders (20260913000000_remove_api_derived_payout_receipts.sql only caught
-- payouts still linked to a tax_amount_derived order - plenty of stale/incorrect receipts
-- predate that flag or lost their order link, and stayed behind).
--
-- Correct payouts are expected to come back by re-uploading each CPR CSV: that path
-- (upload_postex_csv -> assign_courier_payouts -> post_courier_payout_journal) rebuilds a
-- payout's voucher from the orders on it, so nothing here needs to reconstruct figures by
-- hand.
DELETE FROM finances_journal_entries
 WHERE voucher_type = 'receipt';

DO $$
BEGIN
    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l;
END;
$$;

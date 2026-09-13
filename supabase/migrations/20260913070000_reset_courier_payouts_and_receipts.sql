-- At the user's explicit request: full reset of courier payout postings and the
-- finances_courier_payouts rows themselves, ahead of re-running the reimplemented
-- upload/posting logic from a clean slate.
--
-- Deleting finances_courier_payouts (not just its journal entries) matters because
-- assign_courier_payouts() does ON CONFLICT (org_id, courier, folio) DO NOTHING - a
-- stale payout row would silently survive a re-run and keep its old cash_ledger_id
-- and payout_date instead of picking up whatever the reimplemented logic now computes.
-- shopify_orders.courier_payout_id is ON DELETE SET NULL, so orders unlink themselves;
-- their own settlement fields (folio, is_order_settled, delivery_charge, tax_amount,
-- tracking_number) are untouched here, matching what was asked.
DELETE FROM finances_journal_entries
 WHERE voucher_type = 'receipt';

DELETE FROM finances_courier_payouts;

DO $$
BEGIN
    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l;
END;
$$;

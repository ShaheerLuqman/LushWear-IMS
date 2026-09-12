-- Remove "receipt" ledger entries touched by API-derived settlement, without touching
-- the orders themselves (is_order_settled and courier_payout_id stay as they are -
-- fetch-postex-settlements just no longer posts, or lets these join, going forward: see
-- backend/app/routes/orders.py).
--
-- Any payout with even one tax_amount_derived order is in scope, not just all-derived
-- ones: the whole voucher was posted from one SUM() over every order on it, so a single
-- unverified figure taints the total, not just its own share. Re-uploading the real CPR
-- CSV clears tax_amount_derived on every order it actually settles and re-triggers
-- assign_courier_payouts/post_courier_payout_journal, which rebuilds the voucher from
-- clean data - this is a one-time wipe of the tainted version, not a permanent exclusion.
DELETE FROM finances_journal_entries
 WHERE source_type = 'courier_payout'
   AND source_id IN (
       SELECT DISTINCT y.id
         FROM finances_courier_payouts y
         JOIN shopify_orders o ON o.courier_payout_id = y.id
        WHERE o.tax_amount_derived
   );

DO $$
BEGIN
    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l;
END;
$$;

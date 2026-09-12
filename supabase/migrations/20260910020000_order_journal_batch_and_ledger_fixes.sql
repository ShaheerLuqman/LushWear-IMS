-- Batch posting, plus the chart-of-accounts corrections Phase 5 posting depends on.

-- 1. The Orders account holds customer advances - money owed against goods not yet
--    delivered - and the seeding function has always said Liability. An org carried
--    over from before that seeding can still have it typed Revenue, which puts every
--    advance on the P&L instead of the balance sheet. Balances are Dr - Cr regardless
--    of type, so this reclassifies without moving a number.
UPDATE finances_ledgers
   SET type = 'Liability', updated_at = NOW()
 WHERE system_key = 'orders' AND type <> 'Liability';

-- 2. A courier's system ledger is the COD it holds on our behalf: an Asset, always.
--    enable_courier_system_ledger adopts by name, so an org that already kept an
--    EXPENSE ledger named after a courier (its delivery charges) had that account
--    claimed as the receivable. Release it - the expense account goes back to being
--    an ordinary expense account, and the courier gets a real Asset account the next
--    time it is enabled.
UPDATE finances_ledgers
   SET system_key = NULL, updated_at = NOW()
 WHERE system_key LIKE 'courier\_%' AND type <> 'Asset';

-- ... and stop the adoption from doing it again. Same function as
-- 20260909000000_courier_system_ledgers.sql with an Asset guard on the name match.
CREATE OR REPLACE FUNCTION enable_courier_system_ledger(
    p_org_id     UUID,
    p_system_key VARCHAR,
    p_name       VARCHAR,
    p_code       VARCHAR
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id UUID;
BEGIN
    SELECT id INTO v_id
      FROM finances_ledgers
     WHERE org_id = p_org_id AND system_key = p_system_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    SELECT id INTO v_id
      FROM finances_ledgers
     WHERE org_id = p_org_id
       AND system_key IS NULL
       AND type = 'Asset'
       AND lower(trim(name)) = lower(trim(p_name))
     LIMIT 1;
    IF v_id IS NOT NULL THEN
        UPDATE finances_ledgers SET system_key = p_system_key WHERE id = v_id;
        RETURN v_id;
    END IF;

    RETURN ensure_system_ledger(p_org_id, p_system_key, p_name, 'Asset', p_code);
END;
$$;

-- 3. "CNS" is Couriers Next, and carries that courier's whole history, but the name
--    does not match the catalog label so adoption would leave it stranded and build a
--    second, empty account. Claim it by hand; the name stays as its owner knows it.
UPDATE finances_ledgers l
   SET system_key = 'courier_couriers_next', updated_at = NOW()
 WHERE l.type = 'Asset'
   AND l.system_key IS NULL
   AND lower(trim(l.name)) = 'cns'
   AND NOT EXISTS (
       SELECT 1 FROM finances_ledgers x
        WHERE x.org_id = l.org_id AND x.system_key = 'courier_couriers_next'
   );


-- 4. Post many orders in one call.
--
-- journal_lines_balance_trigger is FOR EACH ROW and recalc_ledger_balance re-sums an
-- account's ENTIRE history, so posting N orders one line at a time is quadratic: a
-- backfill of ~8,000 orders is ~50,000 lines, nearly all landing on the same handful
-- of accounts. Suspending the trigger for the batch and recalculating each account
-- once at the end is the difference between minutes and not finishing.
--
-- ALTER TABLE is transactional, so a failure anywhere in the loop rolls the trigger
-- back on with the postings. SECURITY DEFINER because disabling a trigger needs table
-- ownership, which the API role does not have.
--
-- p_order_ids NULL means every order the org could post - the backfill entry point.
CREATE OR REPLACE FUNCTION post_orders_journal(p_org_id UUID, p_order_ids UUID[] DEFAULT NULL)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID;
    v_n  INT := 0;
BEGIN
    ALTER TABLE finances_journal_lines DISABLE TRIGGER journal_lines_balance_trigger;

    FOR v_id IN
        SELECT o.id
          FROM shopify_orders o
         WHERE o.org_id = p_org_id
           AND (p_order_ids IS NULL OR o.id = ANY(p_order_ids))
           AND (p_order_ids IS NOT NULL
                OR COALESCE(o.courier_pickup_date, o.fulfilled_at) IS NOT NULL)
         ORDER BY COALESCE(o.courier_pickup_date, o.fulfilled_at)
    LOOP
        PERFORM post_order_journal(v_id);
        v_n := v_n + 1;
    END LOOP;

    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l WHERE l.org_id = p_org_id;

    RETURN v_n;
END;
$$;


-- Undo for the backfill: drop every order-sourced voucher for an org, under the same
-- trigger suspension, then put the balances back. Exists so a backfill can be re-run
-- from a clean slate, and so a benchmark leaves nothing behind.
CREATE OR REPLACE FUNCTION unpost_orders_journal(p_org_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_n INT;
BEGIN
    ALTER TABLE finances_journal_lines DISABLE TRIGGER journal_lines_balance_trigger;

    WITH gone AS (
        DELETE FROM finances_journal_entries
         WHERE org_id = p_org_id
           AND source_type IN ('order_sale', 'order_return', 'order_return_stock', 'courier_payout')
        RETURNING 1
    )
    SELECT COUNT(*)::INT INTO v_n FROM gone;

    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l WHERE l.org_id = p_org_id;

    RETURN v_n;
END;
$$;

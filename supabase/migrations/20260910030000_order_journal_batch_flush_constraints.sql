-- post_orders_journal/unpost_orders_journal failed with 55006, "cannot ALTER TABLE
-- because it has pending trigger events".
--
-- journal_lines_must_balance and journal_entries_must_have_lines are DEFERRABLE
-- INITIALLY DEFERRED, so every line the batch posts queues a constraint event that
-- is not settled until COMMIT - and Postgres refuses to ALTER a table with events
-- pending. Settling those two by name just before re-enabling the recalc trigger
-- clears the queue. The checks still run and still cover every posting; they run at
-- that point rather than at COMMIT.
--
-- Named rather than SET CONSTRAINTS ALL: making every constraint in the transaction
-- immediate would break post_journal_entry, which relies on the header being allowed
-- to exist line-less until its lines land.
--
-- Only journal_lines_balance_trigger is suspended, so the balance rule is enforced
-- throughout - it is the per-row recalc, not the correctness check, that is skipped.

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

    SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;
    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l WHERE l.org_id = p_org_id;

    RETURN v_n;
END;
$$;


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

    SET CONSTRAINTS journal_lines_must_balance, journal_entries_must_have_lines IMMEDIATE;
    ALTER TABLE finances_journal_lines ENABLE TRIGGER journal_lines_balance_trigger;

    PERFORM recalc_ledger_balance(l.id) FROM finances_ledgers l WHERE l.org_id = p_org_id;

    RETURN v_n;
END;
$$;

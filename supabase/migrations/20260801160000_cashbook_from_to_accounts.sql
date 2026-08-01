-- A cashbook entry names both of its sides, so only entries that actually move
-- cash reach the Cash in Hand account.
--
-- Until now every entry was one `folio` ledger plus an implicit cash side, so
-- Cash in Hand absorbed everything - including transfers that never touched
-- cash, like paying a supplier from a bank account. An entry now records:
--
--   from_account_id  the account money came FROM  (credited)
--   to_account_id    the account money went TO    (debited)
--
-- with NULL meaning cash on that side. So:
--   from = Sales,       to = NULL          cash received from sales
--   from = NULL,        to = Rent          rent paid in cash
--   from = Meezan Bank, to = Fabric Supp.  bank payment - cash untouched
--
-- This replaces folio + entry_type entirely. entry_type existed only to say
-- which side the single folio sat on, which two explicit columns make obvious;
-- keeping it would leave two ways to express the same thing, free to disagree.

ALTER TABLE cashbook_entries ADD COLUMN IF NOT EXISTS from_account_id UUID REFERENCES ledgers(id) ON DELETE RESTRICT;
ALTER TABLE cashbook_entries ADD COLUMN IF NOT EXISTS to_account_id   UUID REFERENCES ledgers(id) ON DELETE RESTRICT;

-- entry_type was the FOLIO's side: 'credit' = credit the folio, so money came
-- from it into cash; 'debit' = debit the folio, so cash paid out to it.
--
-- Guarded and run through EXECUTE so this file still applies to a database that
-- has already been carried over by supabase_schema.sql (which performs the same
-- change): plpgsql only parses the statement when it runs, so naming a dropped
-- column inside the string is harmless once the guard is false.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cashbook_entries'
           AND column_name = 'entry_type'
    ) THEN
        EXECUTE $q$
            UPDATE cashbook_entries
               SET from_account_id = CASE WHEN entry_type = 'credit' THEN folio ELSE NULL END,
                   to_account_id   = CASE WHEN entry_type = 'debit'  THEN folio ELSE NULL END
             WHERE from_account_id IS NULL AND to_account_id IS NULL
        $q$;
    END IF;
END $$;

-- Both NULL would be cash-to-cash, which moves nothing; both equal would be an
-- account paying itself.
ALTER TABLE cashbook_entries DROP CONSTRAINT IF EXISTS cashbook_entries_two_sides_check;
ALTER TABLE cashbook_entries ADD CONSTRAINT cashbook_entries_two_sides_check
    CHECK (
        (from_account_id IS NOT NULL OR to_account_id IS NOT NULL)
        AND from_account_id IS DISTINCT FROM to_account_id
    );

CREATE INDEX IF NOT EXISTS idx_cashbook_entries_from_account ON cashbook_entries(from_account_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_to_account   ON cashbook_entries(to_account_id);
-- Order advances are money received from the Orders account; advance
-- reconciliation looks them up by that side plus the order number.
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_from_order_number
    ON cashbook_entries(from_account_id, order_number);

-- ---------------------------------------------------------------------------
-- Daily balances: cash only
-- ---------------------------------------------------------------------------
-- A NULL side IS cash, so an entry only moves the cash balance when one of its
-- sides is NULL. An entry with both sides named is invisible here, which is the
-- whole point of the change.
CREATE OR REPLACE FUNCTION recalc_cashbook_daily_balances(p_from_date DATE, p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_opening NUMERIC(12, 2);
BEGIN
    SELECT closing_balance INTO v_opening
    FROM cashbook_daily_balances
    WHERE org_id = p_org_id AND balance_date < p_from_date
    ORDER BY balance_date DESC
    LIMIT 1;

    v_opening := COALESCE(v_opening, 0);

    DELETE FROM cashbook_daily_balances
    WHERE org_id = p_org_id
      AND balance_date >= p_from_date
      AND balance_date NOT IN (
          SELECT DISTINCT entry_date FROM cashbook_entries
          WHERE org_id = p_org_id AND entry_date >= p_from_date
      );

    WITH day_totals AS (
        SELECT entry_date AS balance_date,
               -- Cash is the destination: cash received, a debit to cash.
               COALESCE(SUM(amount) FILTER (WHERE to_account_id IS NULL), 0)   AS total_debit,
               -- Cash is the source: cash paid out, a credit to cash.
               COALESCE(SUM(amount) FILTER (WHERE from_account_id IS NULL), 0) AS total_credit
        FROM cashbook_entries
        WHERE org_id = p_org_id AND entry_date >= p_from_date
        GROUP BY entry_date
    ),
    running AS (
        SELECT balance_date,
               total_debit,
               total_credit,
               v_opening + SUM(total_debit - total_credit)
                   OVER (ORDER BY balance_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS closing_balance
        FROM day_totals
    )
    INSERT INTO cashbook_daily_balances
        (org_id, balance_date, opening_balance, total_debit, total_credit, closing_balance, updated_at)
    SELECT p_org_id,
           balance_date,
           closing_balance - total_debit + total_credit,
           total_debit,
           total_credit,
           closing_balance,
           NOW()
    FROM running
    ON CONFLICT (org_id, balance_date) DO UPDATE SET
        opening_balance = EXCLUDED.opening_balance,
        total_debit      = EXCLUDED.total_debit,
        total_credit     = EXCLUDED.total_credit,
        closing_balance  = EXCLUDED.closing_balance,
        updated_at       = NOW();
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_balance_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_balance_trigger
AFTER INSERT OR UPDATE OF entry_date, from_account_id, to_account_id, amount OR DELETE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION trg_cashbook_entries_recalc_balances();

-- ---------------------------------------------------------------------------
-- Journal projection: two named sides, no implicit one
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION project_cashbook_entry_to_journal(p_entry_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    e            RECORD;
    v_cash_id    UUID;
    v_from       UUID;
    v_to         UUID;
    v_journal_id UUID;
BEGIN
    SELECT * INTO e FROM cashbook_entries WHERE id = p_entry_id;

    IF NOT FOUND THEN
        DELETE FROM journal_entries
         WHERE source_type = 'cashbook_entry' AND source_id = p_entry_id;
        RETURN;
    END IF;

    -- Only looked up when a side is actually cash, so an org with no cash
    -- account can still record transfers between two named ledgers.
    IF e.from_account_id IS NULL OR e.to_account_id IS NULL THEN
        SELECT id INTO v_cash_id FROM ledgers WHERE org_id = e.org_id AND system_key = 'cash';
        IF v_cash_id IS NULL THEN
            RAISE EXCEPTION 'Organization % has no system cash account', e.org_id;
        END IF;
    END IF;

    v_from := COALESCE(e.from_account_id, v_cash_id);
    v_to   := COALESCE(e.to_account_id, v_cash_id);

    -- Rebuild rather than patch: an edited entry can change date, amount or
    -- either side, and re-posting from scratch cannot drift.
    DELETE FROM journal_entries
     WHERE source_type = 'cashbook_entry' AND source_id = p_entry_id;

    INSERT INTO journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id)
    VALUES
        (e.org_id, e.entry_date, 'cashbook', e.description, 'cashbook_entry', e.id)
    RETURNING id INTO v_journal_id;

    -- Money goes TO the debit side and comes FROM the credit side.
    INSERT INTO journal_lines (org_id, journal_id, account_id, debit, credit, description)
    VALUES (e.org_id, v_journal_id, v_to,   e.amount, 0, e.description),
           (e.org_id, v_journal_id, v_from, 0, e.amount, e.description);
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_journal_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_journal_trigger
AFTER INSERT OR UPDATE OF entry_date, from_account_id, to_account_id, amount, description OR DELETE
ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION trg_cashbook_entries_project_journal();

-- ---------------------------------------------------------------------------
-- Deletion audit log
-- ---------------------------------------------------------------------------
ALTER TABLE cashbook_entry_audit_log ADD COLUMN IF NOT EXISTS from_account_id UUID;
ALTER TABLE cashbook_entry_audit_log ADD COLUMN IF NOT EXISTS to_account_id   UUID;
-- Only if they are still there: an already-carried-over database has dropped
-- neither NOT NULL nor the columns, but a fresh one never had them.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cashbook_entry_audit_log'
           AND column_name = 'entry_type'
    ) THEN
        ALTER TABLE cashbook_entry_audit_log ALTER COLUMN entry_type DROP NOT NULL;
        ALTER TABLE cashbook_entry_audit_log ALTER COLUMN folio      DROP NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cashbook_entry_audit_log'
           AND column_name = 'entry_type'
    ) THEN
        EXECUTE $q$
            UPDATE cashbook_entry_audit_log
               SET from_account_id = CASE WHEN entry_type = 'credit' THEN folio ELSE NULL END,
                   to_account_id   = CASE WHEN entry_type = 'debit'  THEN folio ELSE NULL END
             WHERE from_account_id IS NULL AND to_account_id IS NULL AND folio IS NOT NULL
        $q$;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO cashbook_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number, deleted_at)
    VALUES
        (OLD.org_id, OLD.id, OLD.entry_date, OLD.amount, OLD.description,
         OLD.from_account_id, OLD.to_account_id, OLD.order_number, NOW());
    RETURN OLD;
END;
$$;

-- Row-level triggers never fire on TRUNCATE, so this path snapshots the table
-- separately and needs the same treatment.
CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_before_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO cashbook_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number)
    SELECT org_id, id, entry_date, amount, description,
           from_account_id, to_account_id, order_number
    FROM cashbook_entries;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Month Summary expense buckets
-- ---------------------------------------------------------------------------
-- Spending on a ledger is money that went TO it.
CREATE OR REPLACE FUNCTION get_month_summary_totals(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_entry_start DATE,
    p_entry_end DATE,
    p_org_id UUID
)
RETURNS TABLE(
    total_orders INT,
    total_gross_sale NUMERIC,
    total_return_amount NUMERIC,
    return_orders_count INT,
    delivered_orders_count INT,
    enroute_orders_count INT,
    unfulfilled_orders_count INT,
    net_sales NUMERIC,
    net_profit NUMERIC,
    dc_charges_delivered NUMERIC,
    dc_charges_returned NUMERIC,
    dc_charges_total NUMERIC,
    shopify_expense NUMERIC,
    ad_expense NUMERIC,
    other_expense NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH period_orders AS (
        SELECT *
        FROM orders
        WHERE org_id = p_org_id
          AND order_receiving_date >= p_period_start
          AND order_receiving_date <  p_period_end
          AND COALESCE(lower(trim(order_status)), '') <> 'cancelled'
    ),
    order_totals AS (
        SELECT
            COUNT(*)::INT AS total_orders,
            COALESCE(SUM(total_amount), 0) AS total_gross_sale,
            COALESCE(SUM(total_amount) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS total_return_amount,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'returned')::INT AS return_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) IN ('fulfilled', 'cna', 'rfd', 'ica'))::INT AS enroute_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'unfulfilled')::INT AS unfulfilled_orders_count,
            COALESCE(SUM(total_amount) FILTER (WHERE delivery_charge IS NOT NULL), 0) AS gross_with_delivery,
            COALESCE(SUM(total_amount) FILTER (WHERE delivery_charge IS NOT NULL AND lower(trim(order_status)) = 'returned'), 0) AS return_amount_with_delivery,
            COALESCE(SUM(cost_price) FILTER (WHERE delivery_charge IS NOT NULL), 0) AS cost_with_delivery,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'delivered'), 0) AS dc_charges_delivered,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS dc_charges_returned
        FROM period_orders
    ),
    ledger_totals AS (
        SELECT
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'shopify'), 0) AS shopify_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'ad'), 0)      AS ad_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'other'), 0)   AS other_expense
        FROM ledgers l
        JOIN cashbook_entries ce ON ce.to_account_id = l.id
        WHERE l.org_id = p_org_id AND ce.org_id = p_org_id
          AND ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
    )
    SELECT
        ot.total_orders,
        ot.total_gross_sale,
        ot.total_return_amount,
        ot.return_orders_count,
        ot.delivered_orders_count,
        ot.enroute_orders_count,
        ot.unfulfilled_orders_count,
        (ot.total_gross_sale - ot.total_return_amount) AS net_sales,
        ((ot.gross_with_delivery - ot.return_amount_with_delivery) - ot.cost_with_delivery) AS net_profit,
        ot.dc_charges_delivered,
        ot.dc_charges_returned,
        (ot.dc_charges_delivered + ot.dc_charges_returned) AS dc_charges_total,
        lt.shopify_expense,
        lt.ad_expense,
        lt.other_expense
    FROM order_totals ot, ledger_totals lt;
$$;

-- ---------------------------------------------------------------------------
-- Retire folio / entry_type
-- ---------------------------------------------------------------------------
-- Everything above now reads the two explicit sides. Leaving these would mean
-- two representations of the same fact, free to disagree.
DROP INDEX IF EXISTS idx_cashbook_entries_folio_order_number;
DROP INDEX IF EXISTS idx_cashbook_entries_type;
ALTER TABLE cashbook_entries DROP CONSTRAINT IF EXISTS cashbook_entries_entry_type_check;
ALTER TABLE cashbook_entries DROP COLUMN IF EXISTS folio;
ALTER TABLE cashbook_entries DROP COLUMN IF EXISTS entry_type;

-- Re-project every entry: the journal must match the new two-sided reading, and
-- the daily balances must drop entries that never touched cash.
DO $$
DECLARE
    entry RECORD;
    org   RECORD;
BEGIN
    FOR entry IN SELECT id FROM cashbook_entries ORDER BY entry_date, created_at LOOP
        PERFORM project_cashbook_entry_to_journal(entry.id);
    END LOOP;

    FOR org IN SELECT id FROM organizations LOOP
        PERFORM recalc_cashbook_daily_balances('1900-01-01'::DATE, org.id);
    END LOOP;
END $$;

DO $$
DECLARE
    l RECORD;
BEGIN
    FOR l IN SELECT id FROM ledgers LOOP
        PERFORM recalc_ledger_balance(l.id);
    END LOOP;
END $$;

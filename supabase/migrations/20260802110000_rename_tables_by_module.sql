-- ============================================================================
-- Prefix every table by module: system_ (org/user/platform), shopify_ (order
-- management), finances_ (accounting) - so a table's name says what it's for.
-- See supabase_schema.sql for the full canonical (fresh-install) definitions;
-- this migration carries an existing database over to the same names.
--
-- ALTER TABLE RENAME moves FKs, indexes, constraints, RLS and triggers with
-- the table automatically - views too (their query tree is resolved by OID,
-- not by the name text). Only functions need to be redefined here: a
-- function body is stored as plain text and re-resolves identifiers by name
-- on every call, so any function whose body names a renamed table would
-- start failing the next time it runs.
-- ============================================================================

ALTER TABLE IF EXISTS organizations            RENAME TO system_organizations;
ALTER TABLE IF EXISTS users                     RENAME TO system_users;
ALTER TABLE IF EXISTS org_memberships           RENAME TO system_org_memberships;
ALTER TABLE IF EXISTS org_integration_settings  RENAME TO system_integration_settings;
ALTER TABLE IF EXISTS login_lockouts            RENAME TO system_login_lockouts;

ALTER TABLE IF EXISTS products                  RENAME TO shopify_products;
ALTER TABLE IF EXISTS variants                  RENAME TO shopify_variants;
ALTER TABLE IF EXISTS orders                    RENAME TO shopify_orders;
ALTER TABLE IF EXISTS load_sheet_logs           RENAME TO shopify_load_sheet_logs;
ALTER TABLE IF EXISTS sync_status               RENAME TO shopify_sync_status;

ALTER TABLE IF EXISTS ledgers                   RENAME TO finances_ledgers;
ALTER TABLE IF EXISTS cashbook_entries          RENAME TO finances_cashbook_entries;
ALTER TABLE IF EXISTS cashbook_daily_balances   RENAME TO finances_cashbook_daily_balances;
ALTER TABLE IF EXISTS ledger_balances           RENAME TO finances_ledger_balances;
ALTER TABLE IF EXISTS cashbook_entry_audit_log  RENAME TO finances_cashbook_entry_audit_log;
ALTER TABLE IF EXISTS journal_entries           RENAME TO finances_journal_entries;
ALTER TABLE IF EXISTS journal_lines             RENAME TO finances_journal_lines;
ALTER TABLE IF EXISTS bills                     RENAME TO finances_bills;
ALTER TABLE IF EXISTS bill_items                RENAME TO finances_bill_items;

-- A view's query tree is resolved by OID, so the SELECT text needs no
-- changes - only the view's own name.
ALTER VIEW IF EXISTS bills_with_paid RENAME TO finances_bills_with_paid;


-- ============================================================================
-- Functions whose bodies reference a renamed table, redefined with the new
-- names. Unchanged otherwise from supabase_schema.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION record_login_lockout_failure(
    p_email TEXT,
    p_max_attempts INT,
    p_window_seconds INT
)
RETURNS TABLE(locked_until TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_fails INT;
    v_first_fail TIMESTAMPTZ;
    v_locked_until TIMESTAMPTZ;
BEGIN
    SELECT fails, first_fail_at INTO v_fails, v_first_fail
    FROM system_login_lockouts WHERE email = p_email
    FOR UPDATE;

    IF v_fails IS NULL OR v_now - v_first_fail > (p_window_seconds || ' seconds')::INTERVAL THEN
        v_fails := 1;
        v_first_fail := v_now;
    ELSE
        v_fails := v_fails + 1;
    END IF;

    v_locked_until := CASE WHEN v_fails >= p_max_attempts
        THEN v_now + (p_window_seconds || ' seconds')::INTERVAL
        ELSE NULL END;

    INSERT INTO system_login_lockouts (email, fails, first_fail_at, locked_until, updated_at)
    VALUES (p_email, v_fails, v_first_fail, v_locked_until, v_now)
    ON CONFLICT (email) DO UPDATE SET
        fails = EXCLUDED.fails,
        first_fail_at = EXCLUDED.first_fail_at,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at;

    RETURN QUERY SELECT v_locked_until;
END;
$$;

CREATE OR REPLACE FUNCTION trg_journal_entry_must_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_journal_id UUID;
    v_debit  NUMERIC(14, 2);
    v_credit NUMERIC(14, 2);
BEGIN
    v_journal_id := COALESCE(NEW.journal_id, OLD.journal_id);

    IF NOT EXISTS (SELECT 1 FROM finances_journal_entries WHERE id = v_journal_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
      INTO v_debit, v_credit
      FROM finances_journal_lines WHERE journal_id = v_journal_id;

    IF v_debit <> v_credit THEN
        RAISE EXCEPTION 'Journal entry % does not balance: debits %, credits %',
            v_journal_id, v_debit, v_credit;
    END IF;

    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_journal_entry_must_have_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM finances_journal_entries WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;
    IF (SELECT COUNT(*) FROM finances_journal_lines WHERE journal_id = NEW.id) < 2 THEN
        RAISE EXCEPTION 'Journal entry % must have at least two lines', NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_system_ledger(
    p_org_id UUID,
    p_system_key VARCHAR,
    p_name VARCHAR,
    p_type VARCHAR,
    p_code VARCHAR,
    p_is_cash_equivalent BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id     UUID;
    v_name   VARCHAR := p_name;
    v_suffix INT := 1;
BEGIN
    SELECT id INTO v_id FROM finances_ledgers WHERE org_id = p_org_id AND system_key = p_system_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    WHILE EXISTS (
        SELECT 1 FROM finances_ledgers WHERE org_id = p_org_id AND lower(name) = lower(v_name)
    ) LOOP
        v_suffix := v_suffix + 1;
        v_name := p_name || ' (' || v_suffix || ')';
    END LOOP;

    INSERT INTO finances_ledgers (org_id, name, type, code, system_key, is_cash_equivalent, opening_balance)
    VALUES (p_org_id, v_name, p_type, p_code, p_system_key, p_is_cash_equivalent, 0)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION sync_opening_balance_journal(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_obe_id     UUID;
    v_journal_id UUID;
    v_net        NUMERIC(14, 2);
    v_date       DATE;
BEGIN
    SELECT id INTO v_obe_id
      FROM finances_ledgers WHERE org_id = p_org_id AND system_key = 'opening_balance_equity';
    IF v_obe_id IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM finances_journal_entries WHERE org_id = p_org_id AND source_type = 'opening_balance';

    SELECT COALESCE(SUM(opening_balance), 0) INTO v_net
      FROM finances_ledgers WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    -- Tests for rows, not for v_net: a net of zero is not the same as having no
    -- opening balances at all.
    IF NOT EXISTS (
        SELECT 1 FROM finances_ledgers
         WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id
    ) THEN
        RETURN;
    END IF;

    -- One day before the earliest transaction, so opening balances always sort
    -- ahead of activity on a statement.
    SELECT COALESCE(MIN(entry_date), CURRENT_DATE) - 1 INTO v_date
      FROM finances_cashbook_entries WHERE org_id = p_org_id;

    INSERT INTO finances_journal_entries (org_id, entry_date, voucher_type, narration, source_type)
    VALUES (p_org_id, v_date, 'opening', 'Opening balances', 'opening_balance')
    RETURNING id INTO v_journal_id;

    -- opening_balance is stored Debit-positive, matching journal convention.
    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id, v_journal_id, id,
           CASE WHEN opening_balance > 0 THEN  opening_balance ELSE 0 END,
           CASE WHEN opening_balance < 0 THEN -opening_balance ELSE 0 END,
           'Opening balance'
      FROM finances_ledgers
     WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    IF v_net <> 0 THEN
        INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
        VALUES (p_org_id, v_journal_id, v_obe_id,
                CASE WHEN v_net < 0 THEN -v_net ELSE 0 END,
                CASE WHEN v_net > 0 THEN  v_net ELSE 0 END,
                'Opening balance offset');
    END IF;
END;
$$;

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
    SELECT * INTO e FROM finances_cashbook_entries WHERE id = p_entry_id;

    IF NOT FOUND THEN
        DELETE FROM finances_journal_entries
         WHERE source_type = 'cashbook_entry' AND source_id = p_entry_id;
        RETURN;
    END IF;

    -- Only looked up when a side is actually cash, so an org with no cash
    -- account can still record transfers between two named ledgers.
    IF e.from_account_id IS NULL OR e.to_account_id IS NULL THEN
        SELECT id INTO v_cash_id FROM finances_ledgers WHERE org_id = e.org_id AND system_key = 'cash';
        IF v_cash_id IS NULL THEN
            RAISE EXCEPTION 'Organization % has no system cash account', e.org_id;
        END IF;
    END IF;

    v_from := COALESCE(e.from_account_id, v_cash_id);
    v_to   := COALESCE(e.to_account_id, v_cash_id);

    -- Rebuild rather than patch: an edited entry can change date, amount or
    -- either side, and re-posting from scratch cannot drift.
    DELETE FROM finances_journal_entries
     WHERE source_type = 'cashbook_entry' AND source_id = p_entry_id;

    INSERT INTO finances_journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id)
    VALUES
        (e.org_id, e.entry_date, 'cashbook', e.description, 'cashbook_entry', e.id)
    RETURNING id INTO v_journal_id;

    -- Money goes TO the debit side and comes FROM the credit side.
    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    VALUES (e.org_id, v_journal_id, v_to,   e.amount, 0, e.description),
           (e.org_id, v_journal_id, v_from, 0, e.amount, e.description);
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_project_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM finances_journal_entries
         WHERE source_type = 'cashbook_entry' AND source_id = OLD.id;
        RETURN OLD;
    END IF;

    PERFORM project_cashbook_entry_to_journal(NEW.id);
    RETURN NEW;
END;
$$;

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

    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id, v_journal_id, (l->>'account_id')::UUID,
           COALESCE((l->>'debit')::NUMERIC, 0),
           COALESCE((l->>'credit')::NUMERIC, 0),
           l->>'description'
      FROM jsonb_array_elements(p_lines) AS l;

    RETURN v_journal_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_ledger_statement(p_org_id UUID, p_ledger_id UUID)
RETURNS TABLE(
    id           UUID,
    entry_date   DATE,
    particulars  TEXT,
    debit        NUMERIC,
    credit       NUMERIC,
    voucher_type VARCHAR,
    source_type  VARCHAR
)
LANGUAGE sql
STABLE
AS $$
    SELECT jl.id,
           je.entry_date,
           -- The line's own description is the specific one ("Bill BILL-0001");
           -- the entry narration is the fallback for lines posted without one.
           COALESCE(NULLIF(jl.description, ''), je.narration, '') AS particulars,
           jl.debit,
           jl.credit,
           je.voucher_type,
           je.source_type
      FROM finances_journal_lines jl
      JOIN finances_journal_entries je ON je.id = jl.journal_id
     WHERE jl.org_id = p_org_id
       AND jl.account_id = p_ledger_id
     -- created_at breaks ties within a date so the running balance is stable
     -- across reloads; the opening entry is dated a day earlier and sorts first.
     ORDER BY je.entry_date, je.created_at, jl.created_at;
$$;

CREATE OR REPLACE FUNCTION get_trial_balance(p_org_id UUID, p_as_of DATE)
RETURNS TABLE(
    account_id UUID,
    code       VARCHAR,
    name       VARCHAR,
    type       VARCHAR,
    debit      NUMERIC,
    credit     NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH balances AS (
        SELECT l.id, l.code, l.name, l.type,
               COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS net
          FROM finances_ledgers l
          JOIN finances_journal_lines jl   ON jl.account_id = l.id
          JOIN finances_journal_entries je ON je.id = jl.journal_id
         WHERE l.org_id = p_org_id
           AND je.org_id = p_org_id
           AND je.entry_date <= p_as_of
         GROUP BY l.id, l.code, l.name, l.type
    )
    SELECT id, code, name, type,
           CASE WHEN net > 0 THEN  net ELSE 0 END,
           CASE WHEN net < 0 THEN -net ELSE 0 END
      FROM balances
     WHERE net <> 0
     ORDER BY code NULLS LAST, name;
$$;

CREATE OR REPLACE FUNCTION recalc_cashbook_daily_balances(p_from_date DATE, p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_opening NUMERIC(12, 2);
BEGIN
    SELECT closing_balance INTO v_opening
    FROM finances_cashbook_daily_balances
    WHERE org_id = p_org_id AND balance_date < p_from_date
    ORDER BY balance_date DESC
    LIMIT 1;

    v_opening := COALESCE(v_opening, 0);

    DELETE FROM finances_cashbook_daily_balances
    WHERE org_id = p_org_id
      AND balance_date >= p_from_date
      AND balance_date NOT IN (
          SELECT DISTINCT entry_date FROM finances_cashbook_entries
          WHERE org_id = p_org_id AND entry_date >= p_from_date
      );

    WITH day_totals AS (
        SELECT entry_date AS balance_date,
               -- Cash is the destination: cash received, a debit to cash.
               COALESCE(SUM(amount) FILTER (WHERE to_account_id IS NULL), 0)   AS total_debit,
               -- Cash is the source: cash paid out, a credit to cash.
               COALESCE(SUM(amount) FILTER (WHERE from_account_id IS NULL), 0) AS total_credit
        FROM finances_cashbook_entries
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
    INSERT INTO finances_cashbook_daily_balances
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

CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC(14, 2);
    v_org_id  UUID;
BEGIN
    SELECT org_id INTO v_org_id FROM finances_ledgers WHERE id = p_ledger_id;
    IF v_org_id IS NULL THEN
        DELETE FROM finances_ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    SELECT COALESCE(SUM(debit) - SUM(credit), 0) INTO v_balance
      FROM finances_journal_lines WHERE account_id = p_ledger_id;

    IF v_balance = 0 THEN
        DELETE FROM finances_ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    INSERT INTO finances_ledger_balances (ledger_id, org_id, balance, updated_at)
    VALUES (p_ledger_id, v_org_id, v_balance, NOW())
    ON CONFLICT (ledger_id) DO UPDATE SET
        balance    = EXCLUDED.balance,
        org_id     = EXCLUDED.org_id,
        updated_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_truncate_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    TRUNCATE finances_cashbook_daily_balances;
    TRUNCATE finances_ledger_balances;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO finances_cashbook_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number, deleted_at)
    VALUES
        (OLD.org_id, OLD.id, OLD.entry_date, OLD.amount, OLD.description,
         OLD.from_account_id, OLD.to_account_id, OLD.order_number, NOW());
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_before_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO finances_cashbook_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number)
    SELECT org_id, id, entry_date, amount, description,
           from_account_id, to_account_id, order_number
    FROM finances_cashbook_entries;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION get_month_summary_periods(p_org_id UUID)
RETURNS TABLE(month INT, year INT)
LANGUAGE sql
STABLE
AS $$
    WITH local_dates AS (
        SELECT
            EXTRACT(DAY FROM local_ts)::INT   AS day,
            EXTRACT(MONTH FROM local_ts)::INT AS mon,
            EXTRACT(YEAR FROM local_ts)::INT  AS yr
        FROM (
            SELECT order_receiving_date AT TIME ZONE INTERVAL '+05:00' AS local_ts
            FROM shopify_orders
            WHERE org_id = p_org_id
        ) t
    )
    SELECT DISTINCT
        CASE WHEN day < 22 THEN (CASE WHEN mon = 1 THEN 12 ELSE mon - 1 END) ELSE mon END AS month,
        CASE WHEN day < 22 AND mon = 1 THEN yr - 1 ELSE yr END AS year
    FROM local_dates
    ORDER BY year DESC, month DESC;
$$;

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
        FROM shopify_orders
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
        FROM finances_ledgers l
        JOIN finances_cashbook_entries ce ON ce.to_account_id = l.id
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

CREATE OR REPLACE FUNCTION get_month_summary_carrier_health(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_org_id UUID
)
RETURNS TABLE(
    courier TEXT,
    delivered_count INT,
    total_count INT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        courier,
        COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_count,
        COUNT(*)::INT AS total_count
    FROM shopify_orders
    WHERE org_id = p_org_id
      AND order_receiving_date >= p_period_start
      AND order_receiving_date <  p_period_end
      AND COALESCE(lower(trim(order_status)), '') <> 'cancelled'
      AND courier IS NOT NULL
      AND trim(courier) <> ''
    GROUP BY courier
    ORDER BY total_count DESC, courier ASC;
$$;

CREATE OR REPLACE FUNCTION next_bill_number(p_org_id UUID)
RETURNS VARCHAR
LANGUAGE sql
STABLE
AS $$
    SELECT 'BILL-' || LPAD(
        (COALESCE(MAX(SUBSTRING(bill_number FROM 6)::INT), 0) + 1)::TEXT, 4, '0')
      FROM finances_bills
     WHERE org_id = p_org_id AND bill_number ~ '^BILL-[0-9]+$';
$$;

CREATE OR REPLACE FUNCTION recalc_bill_totals(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_subtotal NUMERIC(14, 2);
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_subtotal
      FROM finances_bill_items WHERE bill_id = p_bill_id;

    UPDATE finances_bills
       SET subtotal   = v_subtotal,
           total      = v_subtotal + tax_amount,
           updated_at = NOW()
     WHERE id = p_bill_id;
END;
$$;

CREATE OR REPLACE FUNCTION apply_bill_stock(p_bill_id UUID, p_sign INT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- variants.quantity is INTEGER while a bill line can be fractional (fabric
    -- by the metre), so the movement is rounded to whole units.
    UPDATE shopify_variants v
       SET quantity   = v.quantity + (p_sign * ROUND(agg.qty))::INT,
           updated_at = NOW()
      FROM (
          SELECT variant_id, SUM(quantity) AS qty
            FROM finances_bill_items
           WHERE bill_id = p_bill_id AND variant_id IS NOT NULL
           GROUP BY variant_id
      ) agg
     WHERE v.id = agg.variant_id;

    IF p_sign > 0 THEN
        UPDATE shopify_products p
           SET cost_price = agg.unit_cost,
               updated_at = NOW()
          FROM (
              SELECT DISTINCT ON (product_id) product_id, unit_cost
                FROM finances_bill_items
               WHERE bill_id = p_bill_id AND product_id IS NOT NULL
               ORDER BY product_id, created_at DESC
          ) agg
         WHERE p.id = agg.product_id;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION receive_bill(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b             RECORD;
    v_inventory   UUID;
    v_tax_account UUID;
    v_lines       JSONB;
BEGIN
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % not found', p_bill_id;
    END IF;
    IF b.status = 'received' THEN
        RETURN;
    END IF;
    IF b.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cannot receive a cancelled bill';
    END IF;

    PERFORM recalc_bill_totals(p_bill_id);
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;

    IF b.total <= 0 THEN
        RAISE EXCEPTION 'Bill % has nothing to post - add at least one line', b.bill_number;
    END IF;

    -- Every line is stock, so the whole subtotal is one Inventory debit.
    v_inventory := ensure_system_ledger(b.org_id, 'inventory', 'Inventory', 'Asset', '1400');
    v_lines := jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory,
        'debit',      b.subtotal,
        'credit',     0,
        'description', 'Bill ' || b.bill_number));

    IF b.tax_amount > 0 THEN
        v_tax_account := ensure_system_ledger(
            b.org_id, 'tax_on_purchases', 'Tax on Purchases', 'Expense', '5900');
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', v_tax_account,
            'debit',      b.tax_amount,
            'credit',     0,
            'description', 'Tax on bill ' || b.bill_number));
    END IF;

    -- The supplier's own ledger is the credit side - there is no separate
    -- Accounts Payable control account (FINANCE_ACCOUNTING_PLAN.md Phase 2).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', b.supplier_id,
        'debit',      0,
        'credit',     b.total,
        'description', 'Bill ' || b.bill_number));

    -- Defensive: post_journal_entry does not replace an existing entry for the
    -- same source, and idx_journal_entries_source would reject a duplicate.
    DELETE FROM finances_journal_entries
     WHERE org_id = b.org_id AND source_type = 'bill' AND source_id = p_bill_id;

    PERFORM post_journal_entry(
        b.org_id,
        b.bill_date,
        v_lines,
        'Bill ' || b.bill_number || COALESCE(' (' || b.supplier_ref || ')', ''),
        'bill',
        b.created_by,
        'bill',
        b.id);

    IF NOT b.stock_applied THEN
        PERFORM apply_bill_stock(p_bill_id, 1);
        UPDATE finances_bills SET stock_applied = TRUE WHERE id = p_bill_id;
    END IF;

    UPDATE finances_bills SET status = 'received', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

CREATE OR REPLACE FUNCTION unreceive_bill(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b RECORD;
BEGIN
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % not found', p_bill_id;
    END IF;
    IF b.status <> 'received' THEN
        RETURN;
    END IF;

    DELETE FROM finances_journal_entries
     WHERE org_id = b.org_id AND source_type = 'bill' AND source_id = p_bill_id;

    IF b.stock_applied THEN
        PERFORM apply_bill_stock(p_bill_id, -1);
        UPDATE finances_bills SET stock_applied = FALSE WHERE id = p_bill_id;
    END IF;

    UPDATE finances_bills SET status = 'draft', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_ap_ageing(p_org_id UUID, p_as_of DATE)
RETURNS TABLE(
    supplier_id   UUID,
    supplier_name VARCHAR,
    outstanding   NUMERIC,
    not_due       NUMERIC,
    d1_30         NUMERIC,
    d31_60        NUMERIC,
    d61_90        NUMERIC,
    d90_plus      NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH open_bills AS (
        SELECT b.supplier_id,
               b.outstanding,
               -- No due date means due on receipt.
               p_as_of - COALESCE(b.due_date, b.bill_date) AS days_overdue
          FROM finances_bills_with_paid b
         WHERE b.org_id = p_org_id
           AND b.status = 'received'
           AND b.bill_date <= p_as_of
           AND b.outstanding > 0
    )
    SELECT l.id,
           l.name,
           SUM(ob.outstanding),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue <= 0), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue BETWEEN  1 AND 30), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue BETWEEN 31 AND 60), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue BETWEEN 61 AND 90), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_overdue > 90), 0)
      FROM open_bills ob
      JOIN finances_ledgers l ON l.id = ob.supplier_id
     GROUP BY l.id, l.name
     ORDER BY l.name;
$$;


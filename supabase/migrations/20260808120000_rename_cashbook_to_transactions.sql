-- ============================================================================
-- Rename Cashbook to Transactions.
-- ----------------------------------------------------------------------------
-- "Cashbook" undersold what this table has been since the two-sided rewrite:
-- most rows never touch cash at all (a transfer between two named ledgers).
-- "Transaction" is what the row actually is.
--
-- ALTER TABLE RENAME carries FKs, RLS and the physical index/constraint/trigger
-- objects with it automatically - only their NAMES need this migration to say
-- transaction_entries instead of cashbook_entries, and only function BODIES
-- (stored as plain text, re-resolved by name on every call) need to be
-- redefined so they keep pointing at the renamed table.
--
-- Trigger/constraint/index renames use ALTER ... RENAME rather than drop and
-- recreate, so the objects themselves (and any bloat-avoiding statistics on
-- them) aren't rebuilt for what is purely a label change.
-- ============================================================================

ALTER TABLE finances_cashbook_entries         RENAME TO finances_transaction_entries;
ALTER TABLE finances_cashbook_daily_balances  RENAME TO finances_transaction_daily_balances;
ALTER TABLE finances_cashbook_entry_audit_log RENAME TO finances_transaction_entry_audit_log;

ALTER INDEX idx_cashbook_entries_date              RENAME TO idx_transaction_entries_date;
ALTER INDEX idx_cashbook_entries_from_account       RENAME TO idx_transaction_entries_from_account;
ALTER INDEX idx_cashbook_entries_to_account         RENAME TO idx_transaction_entries_to_account;
ALTER INDEX idx_cashbook_entries_order_number       RENAME TO idx_transaction_entries_order_number;
ALTER INDEX idx_cashbook_entries_org_id             RENAME TO idx_transaction_entries_org_id;
ALTER INDEX idx_cashbook_entries_from_order_number  RENAME TO idx_transaction_entries_from_order_number;
ALTER INDEX idx_cashbook_entries_idempotency_key    RENAME TO idx_transaction_entries_idempotency_key;
ALTER INDEX idx_cashbook_daily_balances_org_id      RENAME TO idx_transaction_daily_balances_org_id;
ALTER INDEX idx_cashbook_entry_audit_log_entry_id   RENAME TO idx_transaction_entry_audit_log_entry_id;
ALTER INDEX idx_cashbook_entry_audit_log_deleted_at RENAME TO idx_transaction_entry_audit_log_deleted_at;
ALTER INDEX idx_cashbook_entry_audit_log_org_id     RENAME TO idx_transaction_entry_audit_log_org_id;

ALTER TABLE finances_transaction_entries
    RENAME CONSTRAINT cashbook_entries_two_sides_check TO transaction_entries_two_sides_check;
ALTER TABLE finances_transaction_daily_balances
    RENAME CONSTRAINT cashbook_daily_balances_org_id_balance_date_key TO transaction_daily_balances_org_id_balance_date_key;

ALTER TRIGGER cashbook_entries_journal_trigger              ON finances_transaction_entries RENAME TO transaction_entries_journal_trigger;
ALTER TRIGGER cashbook_entries_balance_trigger               ON finances_transaction_entries RENAME TO transaction_entries_balance_trigger;
ALTER TRIGGER cashbook_entries_truncate_trigger               ON finances_transaction_entries RENAME TO transaction_entries_truncate_trigger;
ALTER TRIGGER cashbook_entries_audit_delete_trigger           ON finances_transaction_entries RENAME TO transaction_entries_audit_delete_trigger;
ALTER TRIGGER cashbook_entries_audit_before_truncate_trigger  ON finances_transaction_entries RENAME TO transaction_entries_audit_before_truncate_trigger;

ALTER FUNCTION project_cashbook_entry_to_journal(UUID)        RENAME TO project_transaction_entry_to_journal;
ALTER FUNCTION trg_cashbook_entries_project_journal()          RENAME TO trg_transaction_entries_project_journal;
ALTER FUNCTION recalc_cashbook_daily_balances(DATE, UUID)      RENAME TO recalc_transaction_daily_balances;
ALTER FUNCTION trg_cashbook_entries_recalc_balances()           RENAME TO trg_transaction_entries_recalc_balances;
ALTER FUNCTION trg_cashbook_entries_truncate_balances()         RENAME TO trg_transaction_entries_truncate_balances;
ALTER FUNCTION trg_cashbook_entries_audit_delete()               RENAME TO trg_transaction_entries_audit_delete;
ALTER FUNCTION trg_cashbook_entries_audit_before_truncate()      RENAME TO trg_transaction_entries_audit_before_truncate;

-- ============================================================================
-- Function bodies: redefined under their new names (and get_month_summary_totals
-- / sync_opening_balance_journal, unchanged names but bodies that reference the
-- renamed table), unchanged otherwise from supabase_schema.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION project_transaction_entry_to_journal(p_entry_id UUID)
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
    SELECT * INTO e FROM finances_transaction_entries WHERE id = p_entry_id;

    IF NOT FOUND THEN
        DELETE FROM finances_journal_entries
         WHERE source_type = 'transaction_entry' AND source_id = p_entry_id;
        RETURN;
    END IF;

    IF e.from_account_id IS NULL OR e.to_account_id IS NULL THEN
        SELECT id INTO v_cash_id FROM finances_ledgers WHERE org_id = e.org_id AND system_key = 'cash';
        IF v_cash_id IS NULL THEN
            RAISE EXCEPTION 'Organization % has no system cash account', e.org_id;
        END IF;
    END IF;

    v_from := COALESCE(e.from_account_id, v_cash_id);
    v_to   := COALESCE(e.to_account_id, v_cash_id);

    DELETE FROM finances_journal_entries
     WHERE source_type = 'transaction_entry' AND source_id = p_entry_id;

    INSERT INTO finances_journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id)
    VALUES
        (e.org_id, e.entry_date, 'transaction', e.description, 'transaction_entry', e.id)
    RETURNING id INTO v_journal_id;

    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    VALUES (e.org_id, v_journal_id, v_to,   e.amount, 0, e.description),
           (e.org_id, v_journal_id, v_from, 0, e.amount, e.description);
END;
$$;

CREATE OR REPLACE FUNCTION trg_transaction_entries_project_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM finances_journal_entries
         WHERE source_type = 'transaction_entry' AND source_id = OLD.id;
        RETURN OLD;
    END IF;

    PERFORM project_transaction_entry_to_journal(NEW.id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION recalc_transaction_daily_balances(p_from_date DATE, p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_opening NUMERIC(12, 2);
BEGIN
    SELECT closing_balance INTO v_opening
    FROM finances_transaction_daily_balances
    WHERE org_id = p_org_id AND balance_date < p_from_date
    ORDER BY balance_date DESC
    LIMIT 1;

    v_opening := COALESCE(v_opening, 0);

    DELETE FROM finances_transaction_daily_balances
    WHERE org_id = p_org_id
      AND balance_date >= p_from_date
      AND balance_date NOT IN (
          SELECT DISTINCT entry_date FROM finances_transaction_entries
          WHERE org_id = p_org_id AND entry_date >= p_from_date
      );

    WITH day_totals AS (
        SELECT entry_date AS balance_date,
               COALESCE(SUM(amount) FILTER (WHERE to_account_id IS NULL), 0)   AS total_debit,
               COALESCE(SUM(amount) FILTER (WHERE from_account_id IS NULL), 0) AS total_credit
        FROM finances_transaction_entries
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
    INSERT INTO finances_transaction_daily_balances
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

CREATE OR REPLACE FUNCTION trg_transaction_entries_recalc_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_from DATE;
    v_org_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_from := OLD.entry_date;
        v_org_id := OLD.org_id;
    ELSIF TG_OP = 'UPDATE' THEN
        v_from := LEAST(OLD.entry_date, NEW.entry_date);
        v_org_id := NEW.org_id;
    ELSE
        v_from := NEW.entry_date;
        v_org_id := NEW.org_id;
    END IF;

    PERFORM recalc_transaction_daily_balances(v_from, v_org_id);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION trg_transaction_entries_truncate_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    TRUNCATE finances_transaction_daily_balances;
    TRUNCATE finances_ledger_balances;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_transaction_entries_audit_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO finances_transaction_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number, deleted_at)
    VALUES
        (OLD.org_id, OLD.id, OLD.entry_date, OLD.amount, OLD.description,
         OLD.from_account_id, OLD.to_account_id, OLD.order_number, NOW());
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION trg_transaction_entries_audit_before_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO finances_transaction_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number)
    SELECT org_id, id, entry_date, amount, description,
           from_account_id, to_account_id, order_number
    FROM finances_transaction_entries;
    RETURN NULL;
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

    IF NOT EXISTS (
        SELECT 1 FROM finances_ledgers
         WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id
    ) THEN
        RETURN;
    END IF;

    SELECT COALESCE(MIN(entry_date), CURRENT_DATE) - 1 INTO v_date
      FROM finances_transaction_entries WHERE org_id = p_org_id;

    INSERT INTO finances_journal_entries (org_id, entry_date, voucher_type, narration, source_type)
    VALUES (p_org_id, v_date, 'opening', 'Opening balances', 'opening_balance')
    RETURNING id INTO v_journal_id;

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
        JOIN finances_transaction_entries ce ON ce.to_account_id = l.id
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

-- Existing rows still carry the old voucher_type/source_type values written by
-- the pre-rename function bodies; the new bodies above write 'transaction'/
-- 'transaction_entry' going forward, so backfill history to match.
UPDATE finances_journal_entries SET voucher_type = 'transaction' WHERE voucher_type = 'cashbook';
UPDATE finances_journal_entries SET source_type = 'transaction_entry' WHERE source_type = 'cashbook_entry';

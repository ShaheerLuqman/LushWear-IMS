-- Cost of Goods Sold was only ever computed live in Month Summary
-- (SUM(cost_price) FILTER (order_status = 'delivered')), never posted anywhere.
-- Inventory (system_key = 'inventory') was debited on purchase (receive_bill)
-- but never credited on sale, so the books never reflected stock leaving.
--
-- Adds a system "Cost of Goods Sold" ledger and posts one journal entry per
-- org per fiscal month (Debit COGS, Credit Inventory) totalling that period's
-- delivered orders - not one entry per order, to match how a real books
-- would summarize COGS and to keep the journal from growing one row per sale.
-- Rebuilt from scratch (delete + repost) whenever an order's status/cost_price
-- change could move its period's total, so delivered->returned/cancelled or a
-- cost_price correction is picked up automatically.

DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM system_organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000');
    END LOOP;
END $$;

-- Purge any per-order 'order_cogs' entries and function from an earlier
-- revision of this migration (superseded by the one-entry-per-month
-- 'order_cogs_month' below).
DELETE FROM finances_journal_entries WHERE source_type = 'order_cogs';
DROP FUNCTION IF EXISTS sync_order_cogs_journal(UUID);

-- (month, year) of the fiscal period containing a PKT instant, given the org's
-- fiscal_month_start_day. Mirrors backend/app/routes/orders.py's
-- _period_containing exactly (period runs start_day .. next month's start_day - 1).
CREATE OR REPLACE FUNCTION fiscal_period_of(p_at TIMESTAMPTZ, p_start_day INT)
RETURNS TABLE(period_month INT, period_year INT)
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT
        CASE WHEN d >= p_start_day THEN m ELSE ((m - 2 + 12) % 12) + 1 END,
        CASE WHEN d >= p_start_day THEN y
             WHEN m = 1 THEN y - 1
             ELSE y
        END
    FROM (
        SELECT
            EXTRACT(DAY   FROM p_at AT TIME ZONE 'Asia/Karachi')::INT AS d,
            EXTRACT(MONTH FROM p_at AT TIME ZONE 'Asia/Karachi')::INT AS m,
            EXTRACT(YEAR  FROM p_at AT TIME ZONE 'Asia/Karachi')::INT AS y
    ) x
$$;

-- Posts (or retracts) org's Cost of Goods Sold journal entry for one fiscal
-- month: Debit COGS, Credit Inventory, for the sum of cost_price across every
-- currently-delivered order whose order_receiving_date falls in that period.
-- Always deletes the existing entry for (org, period) first and reposts only
-- if the total is > 0 - same rebuild-from-scratch idiom as receive_bill.
CREATE OR REPLACE FUNCTION sync_month_cogs_journal(p_org_id UUID, p_period_month INT, p_period_year INT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_start_day   INT;
    v_period_start DATE;
    v_total       NUMERIC(14, 2);
    v_cogs        UUID;
    v_inventory   UUID;
    v_lines       JSONB;
BEGIN
    SELECT fiscal_month_start_day INTO v_start_day
      FROM system_organizations WHERE id = p_org_id;
    v_period_start := make_date(p_period_year, p_period_month, v_start_day);

    DELETE FROM finances_journal_entries
     WHERE org_id = p_org_id AND source_type = 'order_cogs_month' AND entry_date = v_period_start;

    SELECT COALESCE(SUM(o.cost_price), 0) INTO v_total
      FROM shopify_orders o, fiscal_period_of(o.order_receiving_date, v_start_day) fp
     WHERE o.org_id = p_org_id
       AND lower(trim(o.order_status)) = 'delivered'
       AND fp.period_month = p_period_month
       AND fp.period_year  = p_period_year;

    IF v_total <= 0 THEN
        RETURN;
    END IF;

    v_cogs      := ensure_system_ledger(p_org_id, 'cost_of_goods_sold', 'COGS', 'Expense', '5000');
    v_inventory := ensure_system_ledger(p_org_id, 'inventory', 'Inventory', 'Asset', '1400');

    v_lines := jsonb_build_array(
        jsonb_build_object('account_id', v_cogs,      'debit', v_total, 'credit', 0,
                            'description', 'Cost of goods sold - ' || to_char(v_period_start, 'FMMonth YYYY')),
        jsonb_build_object('account_id', v_inventory, 'debit', 0, 'credit', v_total,
                            'description', 'Cost of goods sold - ' || to_char(v_period_start, 'FMMonth YYYY'))
    );

    PERFORM post_journal_entry(
        p_org_id,
        v_period_start,
        v_lines,
        'Cost of goods sold - ' || to_char(v_period_start, 'FMMonth YYYY'),
        'order_cogs_month',
        NULL,
        'order_cogs_month',
        NULL);
END;
$$;

CREATE OR REPLACE FUNCTION trg_shopify_orders_sync_cogs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_start_day INT;
    v_row       RECORD;
    fp          RECORD;
BEGIN
    v_row := COALESCE(NEW, OLD);
    SELECT fiscal_month_start_day INTO v_start_day
      FROM system_organizations WHERE id = v_row.org_id;

    SELECT * INTO fp FROM fiscal_period_of(v_row.order_receiving_date, v_start_day);
    PERFORM sync_month_cogs_journal(v_row.org_id, fp.period_month, fp.period_year);
    RETURN v_row;
END;
$$;

DROP TRIGGER IF EXISTS shopify_orders_cogs_journal_trigger ON shopify_orders;
CREATE TRIGGER shopify_orders_cogs_journal_trigger
AFTER INSERT OR UPDATE OF order_status, cost_price OR DELETE ON shopify_orders
FOR EACH ROW
EXECUTE FUNCTION trg_shopify_orders_sync_cogs();

-- Backfill: post one COGS journal entry per (org, period) that predates this trigger.
DO $$
DECLARE
    grp RECORD;
BEGIN
    FOR grp IN
        SELECT DISTINCT o.org_id, fp.period_month, fp.period_year
        FROM shopify_orders o
        JOIN system_organizations s ON s.id = o.org_id,
             LATERAL fiscal_period_of(o.order_receiving_date, s.fiscal_month_start_day) fp
        WHERE lower(trim(o.order_status)) = 'delivered'
    LOOP
        PERFORM sync_month_cogs_journal(grp.org_id, grp.period_month, grp.period_year);
    END LOOP;
END $$;

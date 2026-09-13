-- shopify_orders_cogs_journal_trigger is FOR EACH ROW, and sync_month_cogs_journal
-- re-sums cost_price across the org's entire shopify_orders table each call. A CSV
-- upsert that flips order_status on N rows in one batch statement fires that full
-- table scan N times synchronously inside the statement, which is how a 351-row
-- PostEx CPR upload timed out (57014) - same quadratic shape already fixed for
-- journal_lines_balance_trigger in 20260910020000_order_journal_batch_and_ledger_fixes.sql.
--
-- Fix: move the trigger to statement level with transition tables, and call
-- sync_month_cogs_journal once per distinct (org, period) touched by the whole
-- statement instead of once per row. Postgres requires a transition table's
-- REFERENCING clause to match what fired (NEW TABLE only for INSERT, OLD TABLE only
-- for DELETE, both for UPDATE), so INSERT/DELETE/UPDATE each need their own trigger,
-- but they can share one function branching on TG_OP.
DROP TRIGGER IF EXISTS shopify_orders_cogs_journal_trigger ON shopify_orders;
DROP FUNCTION IF EXISTS trg_shopify_orders_sync_cogs();

-- No column list on the UPDATE trigger below - transition tables and
-- "UPDATE OF col_list" cannot be combined (0A000). Filter to rows where
-- order_status or cost_price actually changed here instead.
CREATE OR REPLACE FUNCTION trg_shopify_orders_sync_cogs_stmt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_month_cogs_journal(p.org_id, p.period_month, p.period_year)
      FROM (
          SELECT DISTINCT r.org_id, fp.period_month, fp.period_year
            FROM (
                SELECT o.org_id, o.order_receiving_date
                  FROM old_rows o
                  JOIN new_rows n ON n.id = o.id
                 WHERE o.order_status IS DISTINCT FROM n.order_status
                    OR o.cost_price IS DISTINCT FROM n.cost_price
                 UNION
                SELECT n.org_id, n.order_receiving_date
                  FROM new_rows n
                  JOIN old_rows o ON o.id = n.id
                 WHERE o.order_status IS DISTINCT FROM n.order_status
                    OR o.cost_price IS DISTINCT FROM n.cost_price
            ) r
            JOIN system_organizations so ON so.id = r.org_id
            CROSS JOIN LATERAL fiscal_period_of(r.order_receiving_date, so.fiscal_month_start_day) fp
      ) p;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_shopify_orders_sync_cogs_stmt_ins()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_month_cogs_journal(p.org_id, p.period_month, p.period_year)
      FROM (
          SELECT DISTINCT r.org_id, fp.period_month, fp.period_year
            FROM new_rows r
            JOIN system_organizations so ON so.id = r.org_id
            CROSS JOIN LATERAL fiscal_period_of(r.order_receiving_date, so.fiscal_month_start_day) fp
      ) p;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION trg_shopify_orders_sync_cogs_stmt_del()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_month_cogs_journal(p.org_id, p.period_month, p.period_year)
      FROM (
          SELECT DISTINCT r.org_id, fp.period_month, fp.period_year
            FROM old_rows r
            JOIN system_organizations so ON so.id = r.org_id
            CROSS JOIN LATERAL fiscal_period_of(r.order_receiving_date, so.fiscal_month_start_day) fp
      ) p;
    RETURN NULL;
END;
$$;

CREATE TRIGGER shopify_orders_cogs_journal_trigger_ins
AFTER INSERT ON shopify_orders
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_shopify_orders_sync_cogs_stmt_ins();

CREATE TRIGGER shopify_orders_cogs_journal_trigger_upd
AFTER UPDATE ON shopify_orders
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_shopify_orders_sync_cogs_stmt();

CREATE TRIGGER shopify_orders_cogs_journal_trigger_del
AFTER DELETE ON shopify_orders
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION trg_shopify_orders_sync_cogs_stmt_del();

-- Org-scoping cutover, part 1 (ORGANIZATIONS_USERS_PLAN.md Phase 2): adds
-- org_id to every business table, backfills existing rows to a single
-- resolved "LushWear" org (creating one if Phase 1's bootstrap hasn't run
-- yet, so this migration works regardless of ordering), then locks it NOT
-- NULL + indexed. Also fixes constraints/trigger functions that were written
-- assuming a single tenant and would otherwise let a second org collide with
-- or corrupt the first org's data - see the inline notes below for each.
--
-- orders.order_number's own UNIQUE-per-org fix is a separate migration
-- (20260730080000) since it depends on orders.org_id existing first.

ALTER TABLE products                ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE variants                ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE orders                  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE load_sheet_logs         ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE ledgers                 ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE cashbook_entries        ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE cashbook_daily_balances ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE ledger_balances         ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE cashbook_entry_audit_log ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);
ALTER TABLE sync_status             ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

-- Resolve "the" org to backfill into: whichever org already exists (Phase 1's
-- bootstrap may have already run), or create "LushWear" if none does yet.
-- Self-sufficient either way, so this migration doesn't depend on bootstrap
-- ordering.
DO $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT id INTO v_org_id FROM organizations ORDER BY created_at LIMIT 1;
    IF v_org_id IS NULL THEN
        INSERT INTO organizations (name) VALUES ('LushWear') RETURNING id INTO v_org_id;
    END IF;

    UPDATE products                 SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE variants                 SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE orders                   SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE load_sheet_logs          SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE ledgers                  SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE cashbook_entries         SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE cashbook_daily_balances  SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE ledger_balances          SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE cashbook_entry_audit_log SET org_id = v_org_id WHERE org_id IS NULL;
    UPDATE sync_status              SET org_id = v_org_id WHERE org_id IS NULL;
END $$;

ALTER TABLE products                 ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE variants                 ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE orders                   ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE load_sheet_logs          ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE ledgers                  ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE cashbook_entries         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE cashbook_daily_balances  ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE ledger_balances          ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE cashbook_entry_audit_log ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE sync_status              ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_org_id                 ON products(org_id);
CREATE INDEX IF NOT EXISTS idx_variants_org_id                 ON variants(org_id);
CREATE INDEX IF NOT EXISTS idx_orders_org_id                   ON orders(org_id);
CREATE INDEX IF NOT EXISTS idx_load_sheet_logs_org_id          ON load_sheet_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_ledgers_org_id                  ON ledgers(org_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_org_id         ON cashbook_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_daily_balances_org_id  ON cashbook_daily_balances(org_id);
CREATE INDEX IF NOT EXISTS idx_ledger_balances_org_id          ON ledger_balances(org_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_entry_audit_log_org_id ON cashbook_entry_audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_sync_status_org_id              ON sync_status(org_id);

-- sync_status was a global singleton keyed by `id` alone (e.g. 'shopify_orders').
-- Each org now syncs its own Shopify store independently, so the key becomes
-- (org_id, id) - otherwise a second org's sync would violate the old PK the
-- moment it tried to write its own 'shopify_orders' row.
ALTER TABLE sync_status DROP CONSTRAINT IF EXISTS sync_status_pkey;
ALTER TABLE sync_status ADD PRIMARY KEY (org_id, id);

-- cashbook_daily_balances.balance_date was globally UNIQUE - two orgs both
-- posting entries on the same calendar date would collide on the old
-- constraint. Move the uniqueness to (org_id, balance_date), and repoint
-- recalc_cashbook_daily_balances's ON CONFLICT target at it below.
ALTER TABLE cashbook_daily_balances DROP CONSTRAINT IF EXISTS cashbook_daily_balances_balance_date_key;
ALTER TABLE cashbook_daily_balances ADD CONSTRAINT cashbook_daily_balances_org_id_balance_date_key UNIQUE (org_id, balance_date);

-- ledgers' case-insensitive name uniqueness was global - two different orgs
-- each wanting a ledger named "Bank" would collide on the old constraint.
-- Move it to (org_id, lower(name)). The index is the enforcement itself, not
-- just a lookup aid - Postgres can't promote a UNIQUE constraint onto an
-- expression like lower(name) (ADD CONSTRAINT ... USING INDEX rejects
-- expression indexes), so there is no separate named constraint.
ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_name_unique;
DROP INDEX IF EXISTS idx_ledgers_name_lower;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_id_name_lower ON ledgers (org_id, lower(name));

-- ledger_balances and cashbook_entry_audit_log keep their existing UUID
-- primary keys unchanged - ledger_id/id are already globally unique (Postgres
-- UUIDs), so unlike sync_status/cashbook_daily_balances/ledgers above there's
-- no realistic cross-org collision to fix; org_id is added purely so
-- app.org_scope.org_table() has a column to filter on, same as every other
-- business table.

-- recalc_cashbook_daily_balances aggregated across the WHOLE cashbook_entries
-- table with no org filter - the single most important trigger-function fix
-- in this migration, since without it a second org's transactions would
-- silently be summed into (and corrupt) every org's daily cashbook balances.
--
-- Postgres identifies functions by name + argument types, so CREATE OR REPLACE
-- with a different argument list creates a second overload instead of
-- replacing the old one - the old single-argument version must be dropped
-- explicitly, or it lingers in the schema forever (unused, but not gone).
DROP FUNCTION IF EXISTS recalc_cashbook_daily_balances(DATE);

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
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'credit'), 0) AS total_credit,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debit'), 0)  AS total_debit
        FROM cashbook_entries
        WHERE org_id = p_org_id AND entry_date >= p_from_date
        GROUP BY entry_date
    ),
    running AS (
        SELECT balance_date,
               total_credit,
               total_debit,
               v_opening + SUM(total_credit - total_debit)
                   OVER (ORDER BY balance_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS closing_balance
        FROM day_totals
    )
    INSERT INTO cashbook_daily_balances
        (org_id, balance_date, opening_balance, total_credit, total_debit, closing_balance, updated_at)
    SELECT p_org_id,
           balance_date,
           closing_balance - total_credit + total_debit,
           total_credit,
           total_debit,
           closing_balance,
           NOW()
    FROM running
    ON CONFLICT (org_id, balance_date) DO UPDATE SET
        opening_balance = EXCLUDED.opening_balance,
        total_credit     = EXCLUDED.total_credit,
        total_debit      = EXCLUDED.total_debit,
        closing_balance  = EXCLUDED.closing_balance,
        updated_at       = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_recalc_balances()
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

    PERFORM recalc_cashbook_daily_balances(v_from, v_org_id);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

-- Audit log rows need org_id too now that the column is NOT NULL on
-- cashbook_entry_audit_log - both triggers below now carry it through from
-- the row(s) being deleted/truncated.
CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO cashbook_entry_audit_log
        (org_id, entry_id, entry_date, entry_type, amount, description, folio, order_number)
    VALUES
        (OLD.org_id, OLD.id, OLD.entry_date, OLD.entry_type, OLD.amount, OLD.description, OLD.folio, OLD.order_number);
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_before_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO cashbook_entry_audit_log
        (org_id, entry_id, entry_date, entry_type, amount, description, folio, order_number)
    SELECT org_id, id, entry_date, entry_type, amount, description, folio, order_number
    FROM cashbook_entries;
    RETURN NULL;
END;
$$;

-- recalc_ledger_balance/trg_ledgers_recalc_balance/trg_cashbook_entries_recalc_ledger_balance
-- and trg_cashbook_entries_truncate_balances are unchanged: the first three
-- already scope correctly via p_ledger_id (a UUID unique to one org's ledger,
-- not a value that can collide across orgs), and the truncate-balances
-- trigger only fires on a manual TRUNCATE cashbook_entries - already a
-- whole-table, cross-org-destructive operator action outside the app's API
-- surface, not something this phase changes.

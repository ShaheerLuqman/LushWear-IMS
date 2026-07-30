-- ============================================================================
-- LushWear IMS — Supabase (Postgres) schema
-- ----------------------------------------------------------------------------
-- Canonical, replicable definition of the database. Running this whole file
-- against a fresh project recreates the schema; running it against an existing
-- database is safe (every statement is IF NOT EXISTS / idempotent).
--
-- Tables are declared in dependency order (a table appears before anything that
-- references it). See DATABASE.md for the rationale behind indexes/constraints.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================================
-- Products & variants
-- ============================================================================

-- Products (one row per product).
CREATE TABLE IF NOT EXISTS products (
    id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    shopify_product_id  BIGINT UNIQUE,                 -- Shopify sync key
    name                VARCHAR(255) NOT NULL,
    price               DECIMAL(10, 2) DEFAULT 0.00,   -- Selling price (same across variants)
    cost_price          DECIMAL(10, 2),                -- Cost price (same across variants)
    collection          VARCHAR(255),                  -- Collection name (e.g. from Shopify)
    image_url           TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Variants (one row per variant, linked to a product).
CREATE TABLE IF NOT EXISTS variants (
    id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    product_id          UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    shopify_variant_id  BIGINT UNIQUE,                 -- Shopify sync key
    title               VARCHAR(255) NOT NULL,         -- e.g. "S", "M", "Red"
    quantity            INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- Orders
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
    id                       UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    order_number             INTEGER NOT NULL UNIQUE,
    courier                  VARCHAR(100) NOT NULL,
    tracking_number          VARCHAR(255),
    folio                    VARCHAR(255),
    order_status             VARCHAR(50) NOT NULL,
    delivery_status          JSONB,
    total_amount             DECIMAL(10, 2) NOT NULL,
    advance_amount           DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    -- Advance reconciliation (Shopify advance_amount vs cashbook order-advance entries):
    -- 1 = no advance, 2 = shopify only, 3 = cashbook only, 4 = both match, 5 = both mismatch
    advance_status           SMALLINT NOT NULL DEFAULT 1,
    delivery_charge          DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    tax_amount               DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    cost_price               DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    order_receiving_date     TIMESTAMPTZ NOT NULL,
    -- Structured order lines (one object per line). Shape: [{ variant_id, product_id, name,
    -- variant_title, qty, unit_price, cost_price }]. name/variant_title/cost_price are
    -- snapshots (survive product rename/delete/later cost changes); ids link to products/variants.
    line_items               JSONB NOT NULL DEFAULT '[]',
    piece_received           TEXT NOT NULL DEFAULT 'Pending'
                                 CHECK (piece_received IN ('Pending', 'Done', 'Received')),
    replacement_of_order_no  INTEGER,
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- Legacy items[] (flat "Name - Variant" strings), superseded by structured line_items
-- (JSONB) above. Verified every order either has line_items populated or has no item
-- data in either column (see TODO.md §6) before dropping - safe to re-run, no-ops once
-- the column is gone.
    ALTER TABLE orders DROP COLUMN IF EXISTS items;


-- ============================================================================
-- Load sheet logs (courier assignment records)
-- ============================================================================

CREATE TABLE IF NOT EXISTS load_sheet_logs (
    id                 UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    assignment_number  VARCHAR(100) NOT NULL,
    rider_name         VARCHAR(255) NOT NULL,
    order_numbers      JSONB NOT NULL DEFAULT '[]',   -- e.g. ["2721", "2722"]
    delivery_charge    DECIMAL(10, 2),                -- applied to all orders in this load sheet
    created_at         TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- App unlock PIN (bcrypt hash only; single row, id = 'default')
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_pin (
    id          TEXT PRIMARY KEY DEFAULT 'default',
    pin_hash    TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- App-PIN brute-force lockout (per-client failed-attempt counters). Externalized
-- from an in-memory, per-process dict so it survives restarts/redeploys and works
-- across replicas. See supabase/migrations/20260730020000_pin_lockouts_table.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pin_lockouts (
    client_key    TEXT PRIMARY KEY,
    fails         INTEGER NOT NULL DEFAULT 0,
    first_fail_at TIMESTAMPTZ NOT NULL,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Atomically records one failed /verify attempt for p_client_key and returns the
-- resulting lockout expiry (NULL if not locked). Row-locked via SELECT ... FOR
-- UPDATE so concurrent failed attempts from the same key can't race past
-- p_max_attempts - the in-memory version had a threading.Lock for the same reason.
CREATE OR REPLACE FUNCTION record_pin_lockout_failure(
    p_client_key TEXT,
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
    FROM pin_lockouts WHERE client_key = p_client_key
    FOR UPDATE;

    -- No row yet, or the previous failure window has already expired: start a
    -- fresh window instead of accumulating against a stale count.
    IF v_fails IS NULL OR v_now - v_first_fail > (p_window_seconds || ' seconds')::INTERVAL THEN
        v_fails := 1;
        v_first_fail := v_now;
    ELSE
        v_fails := v_fails + 1;
    END IF;

    v_locked_until := CASE WHEN v_fails >= p_max_attempts
        THEN v_now + (p_window_seconds || ' seconds')::INTERVAL
        ELSE NULL END;

    INSERT INTO pin_lockouts (client_key, fails, first_fail_at, locked_until, updated_at)
    VALUES (p_client_key, v_fails, v_first_fail, v_locked_until, v_now)
    ON CONFLICT (client_key) DO UPDATE SET
        fails = EXCLUDED.fails,
        first_fail_at = EXCLUDED.first_fail_at,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at;

    RETURN QUERY SELECT v_locked_until;
END;
$$;


-- ============================================================================
-- Sync status (single row per sync type; currently just the Shopify orders
-- sync). Lets the API expose "last synced" and gate the periodic backend sync
-- on staleness. in_progress/lock_acquired_at are a lock so the periodic sync,
-- a manual sync, and multiple instances can't run concurrently - acquired via
-- a conditional UPDATE, not an advisory lock (unusable through PostgREST).
-- See supabase/migrations/20260728000000_create_sync_status.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_status (
    id               TEXT PRIMARY KEY,
    last_synced_at   TIMESTAMPTZ,
    in_progress      BOOLEAN NOT NULL DEFAULT FALSE,
    lock_acquired_at TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- Cashbook & ledgers
-- ----------------------------------------------------------------------------
-- Records daily debit/credit entries with carried-forward balances.
-- Ledger summaries are derived from cashbook_entries where folio = ledger.id
-- (there is no separate ledger_entries table).
-- ============================================================================

-- Ledgers: individual accounts (suppliers, customers, expense heads, …).
-- type: standard accounting Nature — drives display grouping only (see
-- recalc_ledger_balance below, whose formula is the same for every ledger
-- regardless of Nature) — a fixed, closed set rather than free text, since a
-- typo here silently creates an untracked bucket.
CREATE TABLE IF NOT EXISTS ledgers (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    type        VARCHAR(100) NOT NULL
                CONSTRAINT ledgers_type_check
                CHECK (type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Migrates an existing table that still has the old `section` column: add
-- `type`, backfill from `section` (legacy "Vendors" defaults to "Payable
-- Vendors" — the common case for this business; reclassify manually via the
-- edit-ledger UI if any existing vendor ledger is actually receivable), then
-- drop `section`. A no-op on a fresh install (no `section` column to find)
-- or a re-run (already migrated).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ledgers' AND column_name = 'section'
    ) THEN
        ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS type VARCHAR(100);
        UPDATE ledgers
        SET type = CASE WHEN section = 'Vendors' THEN 'Payable Vendors' ELSE section END
        WHERE type IS NULL;
        ALTER TABLE ledgers ALTER COLUMN type SET NOT NULL;
        ALTER TABLE ledgers DROP COLUMN section;
    END IF;
END $$;

-- Migrates the old business-category `type` values to standard accounting
-- Nature categories. Self-guarding via the WHERE clause — a no-op once no
-- rows carry the old values.
UPDATE ledgers SET type = CASE type
    WHEN 'Bank' THEN 'Asset'
    WHEN 'Receivable Vendors' THEN 'Asset'
    WHEN 'Payable Vendors' THEN 'Liability'
    WHEN 'Investors' THEN 'Equity'
    WHEN 'Sales' THEN 'Revenue'
    ELSE type
END
WHERE type IN ('Bank', 'Receivable Vendors', 'Payable Vendors', 'Investors', 'Sales');

-- Idempotent either way: applies the CHECK constraint after a migration
-- (the inline CREATE TABLE definition only ran on a fresh install).
ALTER TABLE ledgers DROP CONSTRAINT IF EXISTS ledgers_type_check;
ALTER TABLE ledgers ADD CONSTRAINT ledgers_type_check
    CHECK (type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense'));

-- Whether this ledger's balance is included in the Cash In Hand total (set via
-- a checkbox on the create/edit ledger UI, not implied by `type`). Backfill
-- only runs the first time the column is added, so it preserves the
-- pre-existing Bank-only behavior without clobbering manual toggles on re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ledgers' AND column_name = 'include_in_cash_in_hand'
    ) THEN
        ALTER TABLE ledgers ADD COLUMN include_in_cash_in_hand BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE ledgers SET include_in_cash_in_hand = TRUE WHERE type = 'Bank';
    END IF;
END $$;

-- Opening balance, set once at ledger creation (rarely changed after). Folded
-- into ledger_balances by recalc_ledger_balance so the running balance always
-- starts from this instead of 0 — see the ledgers_opening_balance_trigger
-- below, which recalculates whenever this column is inserted/updated.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ledgers' AND column_name = 'opening_balance'
    ) THEN
        ALTER TABLE ledgers ADD COLUMN opening_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00;
    END IF;
END $$;

-- Cashbook entries: all transactions. folio is required and links to a ledger.
CREATE TABLE IF NOT EXISTS cashbook_entries (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    entry_date    DATE NOT NULL,
    entry_type    VARCHAR(10) NOT NULL CHECK (entry_type IN ('credit', 'debit')),
    amount        DECIMAL(12, 2) NOT NULL CHECK (amount > 0),
    description   TEXT,
    folio         UUID NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
    -- Set only for order-advance entries (created via the order advance modal);
    -- links the entry to an order so advance amounts can be reconciled.
    order_number  VARCHAR(20),
    -- Client-generated per submission. A create request replayed with the same
    -- key (double-click, retry after a dropped response) returns the original
    -- row instead of inserting a duplicate. NULL for older rows; Postgres UNIQUE
    -- allows any number of NULLs, so legacy rows don't collide with each other.
    idempotency_key UUID,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Safe to re-run against an existing table: adds the column if this schema
-- was applied before idempotency_key existed.
ALTER TABLE cashbook_entries ADD COLUMN IF NOT EXISTS idempotency_key UUID;

-- Daily balances: opening/closing balance per day (auto-maintained by a DB
-- trigger on cashbook_entries — see "Triggers" section below).
CREATE TABLE IF NOT EXISTS cashbook_daily_balances (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    balance_date     DATE NOT NULL UNIQUE,
    opening_balance  DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_credit     DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_debit      DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    closing_balance  DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Per-ledger running balance (opening_balance + incoming - outgoing),
-- auto-maintained by DB triggers on cashbook_entries and on ledgers.opening_balance
-- — see "Triggers" section below. Only ledgers with a non-zero balance have a
-- row; treat a missing row as 0.
CREATE TABLE IF NOT EXISTS ledger_balances (
    ledger_id   UUID PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
    balance     DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Immutable log of cashbook_entries deletions (DELETE /cashbook/entries/{id}
-- is a hard delete with no other record). Auto-populated by a DB trigger —
-- see "Triggers" section below — so it captures every deletion path, not
-- just the API, including a bulk TRUNCATE from the SQL editor. Records what
-- was deleted and when; not who — there's no per-user identity yet (see
-- Organizations & Users backlog), so this closes the "what/when" half of the
-- gap only.
CREATE TABLE IF NOT EXISTS cashbook_entry_audit_log (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    entry_id      UUID NOT NULL,
    entry_date    DATE NOT NULL,
    entry_type    VARCHAR(10) NOT NULL,
    amount        DECIMAL(12, 2) NOT NULL,
    description   TEXT,
    folio         UUID NOT NULL,
    order_number  VARCHAR(20),
    deleted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- Indexes
-- ============================================================================

-- Products & variants
CREATE INDEX IF NOT EXISTS idx_products_name                ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id  ON products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_variants_product_id          ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_shopify_variant_id  ON variants(shopify_variant_id);

-- Orders
CREATE INDEX IF NOT EXISTS idx_orders_number                 ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_order_status           ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_piece_received         ON orders(piece_received);
-- Period/month views filter and paginate on order_receiving_date (largest, hottest scan).
CREATE INDEX IF NOT EXISTS idx_orders_order_receiving_date   ON orders(order_receiving_date);
-- Shopify sync links NNNN-R replacement orders back to their originals via this column.
CREATE INDEX IF NOT EXISTS idx_orders_replacement_of_order_no ON orders(replacement_of_order_no);
-- NOTE: delivery_status is JSONB; a plain btree index on it cannot search inside the
-- JSON and provides no benefit, so it is intentionally omitted. To query into it, use GIN:
--   CREATE INDEX IF NOT EXISTS idx_orders_delivery_status_gin ON orders USING GIN (delivery_status);

-- Load sheet logs
CREATE INDEX IF NOT EXISTS idx_load_sheet_logs_created_at    ON load_sheet_logs(created_at DESC);

-- Ledgers: case-insensitive uniqueness so "Bank" and "bank" can't both exist
-- (matches the case-insensitive name match already used by the bulk-entry
-- ledger lookup, frontend/renderer.js findLedgerByName). If this fails to
-- create, an existing pair of ledgers already differs only by case —
-- rename or merge them first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_name_lower ON ledgers (lower(name));

-- Promotes the index above into a real named constraint (Postgres can't put
-- a UNIQUE constraint directly on an expression like lower(name), only on
-- plain columns — this attaches the constraint to the existing index instead
-- of creating a second one). ADD CONSTRAINT has no IF NOT EXISTS, so guard
-- manually for idempotency.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ledgers_name_unique'
    ) THEN
        ALTER TABLE ledgers ADD CONSTRAINT ledgers_name_unique UNIQUE USING INDEX idx_ledgers_name_lower;
    END IF;
END $$;

-- Cashbook
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_date         ON cashbook_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_type         ON cashbook_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_order_number ON cashbook_entries(order_number);
-- Advance reconciliation (advance_status.py) filters on (folio, order_number) together.
-- This composite also serves queries that filter on folio alone (leading-column prefix),
-- so a standalone idx_cashbook_entries_folio is redundant and intentionally omitted.
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_folio_order_number
    ON cashbook_entries(folio, order_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cashbook_entries_idempotency_key
    ON cashbook_entries(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_daily_balances_date           ON cashbook_daily_balances(balance_date);
CREATE INDEX IF NOT EXISTS idx_cashbook_entry_audit_log_entry_id   ON cashbook_entry_audit_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_entry_audit_log_deleted_at ON cashbook_entry_audit_log(deleted_at DESC);


-- ============================================================================
-- Triggers: cashbook_daily_balances / ledger_balances / cashbook_entry_audit_log
-- kept in sync by the database, not the app
-- ----------------------------------------------------------------------------
-- Previously an app-layer job (backend/app/routes/cashbook.py) recalculated
-- cashbook_daily_balances after every entry write. Any write that didn't go
-- through those FastAPI routes (Supabase table editor, a raw SQL delete, a
-- restore) left the balances table stale with nothing to self-heal it — the
-- manual repair endpoint even no-op'd once cashbook_entries was empty. Moving
-- this into the database means it fires for every writer, not just the API.
-- ============================================================================

-- Recomputes cashbook_daily_balances for balance_date >= p_from_date, chaining
-- the running balance forward from the prior day's closing balance, and drops
-- any balance row left with no entries for its date.
CREATE OR REPLACE FUNCTION recalc_cashbook_daily_balances(p_from_date DATE)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_opening NUMERIC(12, 2);
BEGIN
    SELECT closing_balance INTO v_opening
    FROM cashbook_daily_balances
    WHERE balance_date < p_from_date
    ORDER BY balance_date DESC
    LIMIT 1;

    v_opening := COALESCE(v_opening, 0);

    -- Drop balance rows on/after from_date that no longer have any entries
    -- (covers deletes, including "the last entry on that date was removed").
    DELETE FROM cashbook_daily_balances
    WHERE balance_date >= p_from_date
      AND balance_date NOT IN (
          SELECT DISTINCT entry_date FROM cashbook_entries WHERE entry_date >= p_from_date
      );

    WITH day_totals AS (
        SELECT entry_date AS balance_date,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'credit'), 0) AS total_credit,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debit'), 0)  AS total_debit
        FROM cashbook_entries
        WHERE entry_date >= p_from_date
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
        (balance_date, opening_balance, total_credit, total_debit, closing_balance, updated_at)
    SELECT balance_date,
           closing_balance - total_credit + total_debit,
           total_credit,
           total_debit,
           closing_balance,
           NOW()
    FROM running
    ON CONFLICT (balance_date) DO UPDATE SET
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
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_from := OLD.entry_date;
    ELSIF TG_OP = 'UPDATE' THEN
        v_from := LEAST(OLD.entry_date, NEW.entry_date);
    ELSE
        v_from := NEW.entry_date;
    END IF;

    PERFORM recalc_cashbook_daily_balances(v_from);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_balance_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_balance_trigger
AFTER INSERT OR UPDATE OF entry_date, entry_type, amount OR DELETE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION trg_cashbook_entries_recalc_balances();

-- Recomputes ledger_balances for a single ledger from scratch, seeded from
-- ledgers.opening_balance. Consistent for every ledger regardless of Nature:
-- New Balance = Previous Balance + Debit - Credit. Deletes the row on a zero
-- balance (missing row already means 0, so there's nothing to gain by
-- keeping a zero row around).
CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC(12, 2);
BEGIN
    SELECT
        (SELECT opening_balance FROM ledgers WHERE id = p_ledger_id)
      + COALESCE(SUM(amount) FILTER (WHERE entry_type = 'debit'), 0)
      - COALESCE(SUM(amount) FILTER (WHERE entry_type = 'credit'), 0)
    INTO v_balance
    FROM cashbook_entries
    WHERE folio = p_ledger_id;

    IF v_balance = 0 THEN
        DELETE FROM ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    INSERT INTO ledger_balances (ledger_id, balance, updated_at)
    VALUES (p_ledger_id, v_balance, NOW())
    ON CONFLICT (ledger_id) DO UPDATE SET
        balance    = EXCLUDED.balance,
        updated_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION trg_cashbook_entries_recalc_ledger_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalc_ledger_balance(OLD.folio);
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM recalc_ledger_balance(OLD.folio);
        IF NEW.folio IS DISTINCT FROM OLD.folio THEN
            PERFORM recalc_ledger_balance(NEW.folio);
        END IF;
        RETURN NEW;
    ELSE
        PERFORM recalc_ledger_balance(NEW.folio);
        RETURN NEW;
    END IF;
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_ledger_balance_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_ledger_balance_trigger
AFTER INSERT OR UPDATE OF folio, entry_type, amount OR DELETE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION trg_cashbook_entries_recalc_ledger_balance();

-- Keeps ledger_balances in sync when a ledger is created with a non-zero
-- opening_balance, or when opening_balance is edited later.
CREATE OR REPLACE FUNCTION trg_ledgers_recalc_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM recalc_ledger_balance(NEW.id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledgers_opening_balance_trigger ON ledgers;
CREATE TRIGGER ledgers_opening_balance_trigger
AFTER INSERT OR UPDATE OF opening_balance ON ledgers
FOR EACH ROW
EXECUTE FUNCTION trg_ledgers_recalc_balance();

-- Row-level triggers never fire on TRUNCATE; cover that path explicitly so a
-- "truncate table" from the SQL editor can't leave balances stale either.
CREATE OR REPLACE FUNCTION trg_cashbook_entries_truncate_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    TRUNCATE cashbook_daily_balances;
    TRUNCATE ledger_balances;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_truncate_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_truncate_trigger
AFTER TRUNCATE ON cashbook_entries
FOR EACH STATEMENT
EXECUTE FUNCTION trg_cashbook_entries_truncate_balances();

-- Logs every deleted row to cashbook_entry_audit_log — fires for any DELETE,
-- not just the API, closing the "hard delete with no record" gap.
CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO cashbook_entry_audit_log
        (entry_id, entry_date, entry_type, amount, description, folio, order_number)
    VALUES
        (OLD.id, OLD.entry_date, OLD.entry_type, OLD.amount, OLD.description, OLD.folio, OLD.order_number);
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_audit_delete_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_audit_delete_trigger
AFTER DELETE ON cashbook_entries
FOR EACH ROW
EXECUTE FUNCTION trg_cashbook_entries_audit_delete();

-- TRUNCATE is effectively a bulk delete but row-level triggers don't fire for
-- it and by the time an AFTER TRUNCATE trigger runs the rows are already
-- gone, so this has to run BEFORE TRUNCATE and snapshot the whole table
-- while it's still there.
CREATE OR REPLACE FUNCTION trg_cashbook_entries_audit_before_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO cashbook_entry_audit_log
        (entry_id, entry_date, entry_type, amount, description, folio, order_number)
    SELECT id, entry_date, entry_type, amount, description, folio, order_number
    FROM cashbook_entries;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cashbook_entries_audit_before_truncate_trigger ON cashbook_entries;
CREATE TRIGGER cashbook_entries_audit_before_truncate_trigger
BEFORE TRUNCATE ON cashbook_entries
FOR EACH STATEMENT
EXECUTE FUNCTION trg_cashbook_entries_audit_before_truncate();


-- ============================================================================
-- Reporting RPCs
-- ----------------------------------------------------------------------------
-- Pushes get_month_summary_list's bucketing (backend/app/routes/orders.py) into
-- Postgres: instead of fetching order_receiving_date for every order and grouping
-- in Python, this returns the distinct (month, year) reporting periods directly.
-- Period = a month's 22nd through the next month's 21st, in PKT (fixed UTC+5, no
-- DST) - mirrors _period_start_end's day-based rollback logic in orders.py.
-- order_receiving_date is NOT NULL, so no created_at fallback is needed here,
-- unlike the Python version this replaces.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_month_summary_periods()
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
            FROM orders
        ) t
    )
    SELECT DISTINCT
        CASE WHEN day < 22 THEN (CASE WHEN mon = 1 THEN 12 ELSE mon - 1 END) ELSE mon END AS month,
        CASE WHEN day < 22 AND mon = 1 THEN yr - 1 ELSE yr END AS year
    FROM local_dates
    ORDER BY year DESC, month DESC;
$$;

-- Pushes get_month_summary_detail's order/ledger aggregation (backend/app/routes/orders.py)
-- into Postgres: instead of fetching every order (select "*") and every matching
-- cashbook entry for the period and summing/counting in Python, this returns the
-- computed totals directly. Mirrors the Python logic term-for-term, including the
-- (now effectively always-true, since delivery_charge/total_amount/cost_price are
-- NOT NULL) "delivery_charge IS NOT NULL" filter on the net-profit terms - kept for
-- literal parity rather than silently changing behavior if that constraint is ever
-- relaxed. products_sold_by_collection is NOT covered here: its fuzzy name-matching
-- fallback (exact -> variant-suffix-stripped -> substring, first match in product
-- list order wins) is not safely reproducible in SQL and stays in Python.
CREATE OR REPLACE FUNCTION get_month_summary_totals(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_entry_start DATE,
    p_entry_end DATE
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
        WHERE order_receiving_date >= p_period_start
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
    -- A ledger falls into at most one bucket, in this priority order - mirrors the
    -- if/elif chain in orders.py (name containing "shopify" wins over "ad", which
    -- wins over a plain Expense-type ledger; anything else is uncounted).
    ledger_buckets AS (
        SELECT
            CASE
                WHEN position('shopify' in lower(l.name)) > 0 THEN 'shopify'
                WHEN position('ad' in lower(l.name)) > 0 THEN 'ad'
                WHEN position('expense' in lower(l.type)) > 0 THEN 'other'
                ELSE NULL
            END AS bucket,
            ce.entry_type,
            ce.amount
        FROM ledgers l
        JOIN cashbook_entries ce ON ce.folio = l.id
        WHERE ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
    ),
    ledger_totals AS (
        SELECT
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'shopify' AND entry_type = 'debit'), 0) AS shopify_expense,
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'ad' AND entry_type = 'debit'), 0) AS ad_expense,
            COALESCE(SUM(amount) FILTER (WHERE bucket = 'other' AND entry_type = 'debit'), 0) AS other_expense
        FROM ledger_buckets
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


-- ============================================================================
-- Row Level Security (optional)
-- ----------------------------------------------------------------------------
-- If RLS is enabled on the project, add permissive policies so the API (service
-- key) can read/write. Example for load_sheet_logs (run if GET returns 500):
--   ALTER TABLE load_sheet_logs ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "Allow all load_sheet_logs" ON load_sheet_logs
--       FOR ALL USING (true) WITH CHECK (true);
-- ============================================================================

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
    order_number             VARCHAR(20) NOT NULL UNIQUE,
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
    items                    TEXT[],                    -- Legacy "Name - Variant" strings
    -- Structured order lines (one object per line): replaces the legacy items strings.
    -- Shape: [{ variant_id, product_id, name, variant_title, qty, unit_price }]
    -- name/variant_title are snapshots (survive product rename/delete); ids link to products/variants.
    line_items               JSONB,
    piece_received           TEXT NOT NULL DEFAULT 'Pending'
                                 CHECK (piece_received IN ('Pending', 'Done', 'Received')),
    replacement_of_order_no  VARCHAR(20),
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW()
);


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
-- Cashbook & ledgers
-- ----------------------------------------------------------------------------
-- Records daily inflow/outflow entries with carried-forward balances.
-- Ledger summaries are derived from cashbook_entries where folio = ledger.id
-- (there is no separate ledger_entries table).
-- ============================================================================

-- Ledgers: individual accounts (suppliers, customers, expense heads, …).
-- section: free text (e.g. Cash/Bank, Expense, Vendors, Sales).
CREATE TABLE IF NOT EXISTS ledgers (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    section     VARCHAR(100) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Cashbook entries: all transactions. folio is required and links to a ledger.
CREATE TABLE IF NOT EXISTS cashbook_entries (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    entry_date    DATE NOT NULL,
    entry_type    VARCHAR(10) NOT NULL CHECK (entry_type IN ('inflow', 'outflow')),
    amount        DECIMAL(12, 2) NOT NULL CHECK (amount > 0),
    description   TEXT,
    folio         UUID NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
    -- Set only for order-advance entries (created via the order advance modal);
    -- links the entry to an order so advance amounts can be reconciled.
    order_number  VARCHAR(20),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Daily balances: opening/closing balance per day (auto-maintained by a DB
-- trigger on cashbook_entries — see "Triggers" section below).
CREATE TABLE IF NOT EXISTS cashbook_daily_balances (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    balance_date     DATE NOT NULL UNIQUE,
    opening_balance  DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_inflow     DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_outflow    DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    closing_balance  DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Per-ledger running balance (incoming - outgoing), auto-maintained by a DB
-- trigger on cashbook_entries — see "Triggers" section below. Only ledgers
-- with at least one cashbook entry have a row; treat a missing row as 0.
CREATE TABLE IF NOT EXISTS ledger_balances (
    ledger_id   UUID PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
    balance     DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
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

-- Cashbook
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_date         ON cashbook_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_type         ON cashbook_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_order_number ON cashbook_entries(order_number);
-- Advance reconciliation (advance_status.py) filters on (folio, order_number) together.
-- This composite also serves queries that filter on folio alone (leading-column prefix),
-- so a standalone idx_cashbook_entries_folio is redundant and intentionally omitted.
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_folio_order_number
    ON cashbook_entries(folio, order_number);
CREATE INDEX IF NOT EXISTS idx_daily_balances_date           ON cashbook_daily_balances(balance_date);


-- ============================================================================
-- Triggers: cashbook_daily_balances / ledger_balances kept in sync by the
-- database, not the app
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
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'inflow'), 0)  AS total_inflow,
               COALESCE(SUM(amount) FILTER (WHERE entry_type = 'outflow'), 0) AS total_outflow
        FROM cashbook_entries
        WHERE entry_date >= p_from_date
        GROUP BY entry_date
    ),
    running AS (
        SELECT balance_date,
               total_inflow,
               total_outflow,
               v_opening + SUM(total_inflow - total_outflow)
                   OVER (ORDER BY balance_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS closing_balance
        FROM day_totals
    )
    INSERT INTO cashbook_daily_balances
        (balance_date, opening_balance, total_inflow, total_outflow, closing_balance, updated_at)
    SELECT balance_date,
           closing_balance - total_inflow + total_outflow,
           total_inflow,
           total_outflow,
           closing_balance,
           NOW()
    FROM running
    ON CONFLICT (balance_date) DO UPDATE SET
        opening_balance = EXCLUDED.opening_balance,
        total_inflow     = EXCLUDED.total_inflow,
        total_outflow    = EXCLUDED.total_outflow,
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

-- Recomputes ledger_balances for a single ledger from scratch. Deletes the row
-- when the ledger has no entries left (vs. a legitimate zero net balance).
CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance     NUMERIC(12, 2);
    v_has_entries BOOLEAN;
BEGIN
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE entry_type = 'inflow'), 0)
      - COALESCE(SUM(amount) FILTER (WHERE entry_type = 'outflow'), 0),
        COUNT(*) > 0
    INTO v_balance, v_has_entries
    FROM cashbook_entries
    WHERE folio = p_ledger_id;

    IF NOT v_has_entries THEN
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


-- ============================================================================
-- Row Level Security (optional)
-- ----------------------------------------------------------------------------
-- If RLS is enabled on the project, add permissive policies so the API (service
-- key) can read/write. Example for load_sheet_logs (run if GET returns 500):
--   ALTER TABLE load_sheet_logs ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "Allow all load_sheet_logs" ON load_sheet_logs
--       FOR ALL USING (true) WITH CHECK (true);
-- ============================================================================

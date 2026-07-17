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
    order_receiving_date     TIMESTAMPTZ,
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

-- Daily balances: opening/closing balance per day (auto-maintained by the app).
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
-- Row Level Security (optional)
-- ----------------------------------------------------------------------------
-- If RLS is enabled on the project, add permissive policies so the API (service
-- key) can read/write. Example for load_sheet_logs (run if GET returns 500):
--   ALTER TABLE load_sheet_logs ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "Allow all load_sheet_logs" ON load_sheet_logs
--       FOR ALL USING (true) WITH CHECK (true);
-- ============================================================================

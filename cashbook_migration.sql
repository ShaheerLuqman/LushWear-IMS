-- Cashbook migration
-- Records daily inflow/outflow entries with carried-forward balances.
-- Ledgers contain summaries of cashbook entries (no separate ledger_entries table).

-- Ledgers: individual accounts (e.g. suppliers, customers, expense heads)
-- section: free text (e.g. Cash/Bank, Expense, Vendors, Sales)
CREATE TABLE IF NOT EXISTS ledgers (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    section VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cashbook entries: all transactions are recorded here
-- folio is required and links to a ledger
CREATE TABLE IF NOT EXISTS cashbook_entries (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    entry_date DATE NOT NULL,
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('inflow', 'outflow')),
    amount DECIMAL(12, 2) NOT NULL CHECK (amount > 0),
    description TEXT,
    folio UUID NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
    -- Set only for order-advance entries (created via the order advance modal).
    -- Links the entry to an order so advance amounts can be reconciled.
    order_number VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashbook_entries_date ON cashbook_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_type ON cashbook_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_folio ON cashbook_entries(folio);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_order_number ON cashbook_entries(order_number);

-- Daily balances: stores opening/closing balance for each day (auto-maintained)
CREATE TABLE IF NOT EXISTS cashbook_daily_balances (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    balance_date DATE NOT NULL UNIQUE,
    opening_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_inflow DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_outflow DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    closing_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_balances_date ON cashbook_daily_balances(balance_date);

-- NOTE: ledger_entries table is no longer needed.
-- Ledger summaries are derived from cashbook_entries where folio = ledger.id
-- To migrate existing data, run:
-- DROP TABLE IF EXISTS ledger_entries;

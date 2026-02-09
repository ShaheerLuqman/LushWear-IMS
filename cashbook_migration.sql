-- Cashbook migration
-- Records daily inflow/outflow entries with carried-forward balances.

CREATE TABLE IF NOT EXISTS cashbook_settings (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    opening_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ledgers: individual accounts (e.g. suppliers, customers, expense heads)
-- section: free text (e.g. Cash/Bank, Expense, Vendors, Sales)
CREATE TABLE IF NOT EXISTS ledgers (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    section VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cashbook_entries (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    entry_date DATE NOT NULL,
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('inflow', 'outflow')),
    amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
    description TEXT,
    folio UUID REFERENCES ledgers(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashbook_entries_date ON cashbook_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_type ON cashbook_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_folio ON cashbook_entries(folio);

-- Ledger entries: historic transactions for each ledger account
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    ledger_id UUID NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
    entry_date DATE NOT NULL,
    particulars TEXT,
    folio TEXT,
    incoming DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    outgoing DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_ledger ON ledger_entries(ledger_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_date ON ledger_entries(entry_date);

-- Migration: add folio column to existing cashbook_entries table (run if table already exists)
-- ALTER TABLE cashbook_entries ADD COLUMN IF NOT EXISTS folio UUID REFERENCES ledgers(id) ON DELETE SET NULL;

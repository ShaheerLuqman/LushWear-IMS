-- Cashbook migration
-- Records daily inflow/outflow entries with carried-forward balances.

CREATE TABLE IF NOT EXISTS cashbook_settings (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    opening_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cashbook_entries (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    entry_date DATE NOT NULL,
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('inflow', 'outflow')),
    amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashbook_entries_date ON cashbook_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_type ON cashbook_entries(entry_type);

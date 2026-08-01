-- Phase 2, part 1: purchase bills (accounts payable). See
-- FINANCE_ACCOUNTING_PLAN.md Phase 2.
--
-- A supplier is a LEDGER, not a row in a separate `contacts` table. Since the
-- Phase 1 journal exists, a supplier account already carries a real balance, so
-- the sum of the Liability-nature party ledgers *is* accounts payable - no
-- control account, and no control-vs-subsidiary reconciliation to maintain.
-- This also means the supplier statement is just that ledger's statement.

-- ---------------------------------------------------------------------------
-- Party attributes on ledgers
-- ---------------------------------------------------------------------------
-- Nullable and only meaningful on party accounts; a Rent or Sales ledger simply
-- leaves them empty. is_party marks the accounts the bill supplier picker
-- offers, so it doesn't list every expense head.
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS is_party           BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS phone              VARCHAR(50);
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS email              VARCHAR(255);
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS address            TEXT;
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS tax_number         VARCHAR(50);
-- Drives the default due date on a new bill. NULL = due on receipt.
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER
    CONSTRAINT ledgers_payment_terms_days_check CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0);

-- Any ledger that already has bills posted against it is a party by definition.
-- (No-op on first run - bills doesn't exist yet - but keeps a re-run honest.)

-- ---------------------------------------------------------------------------
-- bills
-- ---------------------------------------------------------------------------
-- Stored status is only draft/received/cancelled. Paid / partially paid is
-- DERIVED from bill_payments (see get_bills_with_paid below): a stored payment
-- status and the payments themselves can drift apart, a computed one cannot.
CREATE TABLE IF NOT EXISTS bills (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES organizations(id),
    -- Our own sequence (BILL-0001). supplier_ref is the number printed on the
    -- supplier's document, which is theirs to choose and is not unique to us.
    bill_number   VARCHAR(30) NOT NULL,
    supplier_ref  VARCHAR(100),
    supplier_id   UUID NOT NULL REFERENCES ledgers(id) ON DELETE RESTRICT,
    bill_date     DATE NOT NULL,
    due_date      DATE,
    status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                  CONSTRAINT bills_status_check CHECK (status IN ('draft', 'received', 'cancelled')),
    subtotal      DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    tax_amount    DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0),
    total         DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    notes         TEXT,
    -- Whether this bill's lines have been added to variant stock. Guards the
    -- receive/unreceive transition so stock can't be applied twice or reversed
    -- for a bill that never applied it.
    stock_applied BOOLEAN NOT NULL DEFAULT FALSE,
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bills_org_id_bill_number_key UNIQUE (org_id, bill_number)
);

CREATE INDEX IF NOT EXISTS idx_bills_org_supplier ON bills (org_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_bills_org_status   ON bills (org_id, status);
CREATE INDEX IF NOT EXISTS idx_bills_org_due_date ON bills (org_id, due_date);

-- ---------------------------------------------------------------------------
-- bill_items
-- ---------------------------------------------------------------------------
-- No per-line account: every line is stock, and receive_bill debits the org's
-- Inventory account for the whole subtotal. A purchase bill here is always for
-- goods - anything paid for on the spot (ads, rent, packaging) is a cashbook
-- entry against its expense ledger, which is fewer steps and already works.
-- Bills exist to record what is OWED, not to categorise spending.
CREATE TABLE IF NOT EXISTS bill_items (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES organizations(id),
    bill_id     UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    -- Soft links, matching orders.line_items' convention: a product can be
    -- deleted without destroying the purchase history that mentions it.
    product_id  UUID,
    variant_id  UUID,
    description TEXT,
    quantity    NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    unit_cost   DECIMAL(14, 2) NOT NULL CHECK (unit_cost >= 0),
    amount      DECIMAL(14, 2) NOT NULL CHECK (amount >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id ON bill_items (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_org_id  ON bill_items (org_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_variant ON bill_items (variant_id) WHERE variant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- bill_payments — allocation of a cashbook entry to a bill
-- ---------------------------------------------------------------------------
-- A payment is a CASHBOOK ENTRY (entry_type='debit', folio=<supplier ledger>),
-- which the Phase 1 projection turns into Dr supplier / Cr cash. It is
-- deliberately NOT posted straight to the journal: cashbook_daily_balances
-- .closing_balance is computed from cashbook_entries alone, so a payment that
-- bypassed the cashbook would make Cash In Hand disagree with the Cash
-- account's journal balance.
--
-- This table only records how much of that entry settles which bill, so one
-- payment can be split across bills and one bill can be paid in instalments.
CREATE TABLE IF NOT EXISTS bill_payments (
    id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id            UUID NOT NULL REFERENCES organizations(id),
    bill_id           UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    -- ON DELETE CASCADE: deleting the cash movement must delete the allocation,
    -- otherwise the bill would still look paid by money that no longer exists.
    cashbook_entry_id UUID NOT NULL REFERENCES cashbook_entries(id) ON DELETE CASCADE,
    amount            DECIMAL(14, 2) NOT NULL CHECK (amount > 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bill_payments_entry_bill_key UNIQUE (cashbook_entry_id, bill_id)
);

CREATE INDEX IF NOT EXISTS idx_bill_payments_bill_id ON bill_payments (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_org_id  ON bill_payments (org_id);

ALTER TABLE bills         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_payments ENABLE ROW LEVEL SECURITY;

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
-- Organizations, Users & Org Memberships (replaces the single shared app-PIN
-- — see ORGANIZATIONS_USERS_PLAN.md). `users` is pure identity (one row per
-- login) plus the platform-level `is_superadmin` flag; `org_memberships` is
-- the actual source of org access - one row per (person, org) pair, so the
-- same identity can hold a different role in each org they belong to (Multi-
-- Org User Membership plan). `role` is open text with a CHECK constraint
-- rather than a Postgres ENUM, matching this repo's existing convention for
-- small fixed value sets (order_status/advance_status). Declared first -
-- every business table below references organizations(id).
-- See supabase/migrations/20260730040000_organizations_and_users_tables.sql
-- and 20260730140000_org_memberships_table.sql.
--
-- `is_superadmin` (Superadmin Portal plan) is a platform-level flag,
-- independent of org membership - a superadmin may hold zero, one, or more
-- real memberships (logging into those orgs normally as themselves) while
-- also being able to view/manage any org via the portal's impersonate
-- feature.
-- ============================================================================

-- enabled_features (Feature Access plan) gates which top-level app sections
-- (Shopify order management, Finance) this org's users can see/use -
-- enforced server-side by app/features.py's require_feature, not just a
-- sidebar hint. See supabase/migrations/20260801000000_org_feature_flags.sql.
CREATE TABLE IF NOT EXISTS system_organizations (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name             TEXT NOT NULL,
    enabled_features TEXT[] NOT NULL DEFAULT ARRAY['orders', 'finance'],
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- name defaults to '' for identities created before it existed - see
-- supabase/migrations/20260801020000_add_name_to_users.sql. New identities
-- require one via app-level validation (NonBlankStr), not this default.
CREATE TABLE IF NOT EXISTS system_users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_superadmin BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- is_active lives on the membership, not the identity - deactivating someone
-- in one org must not affect their access to another.
CREATE TABLE IF NOT EXISTS system_org_memberships (
    user_id    UUID NOT NULL REFERENCES system_users(id) ON DELETE CASCADE,
    org_id     UUID NOT NULL REFERENCES system_organizations(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_org_id ON system_org_memberships(org_id);


-- ============================================================================
-- Per-org Shopify/PostEx credentials, replacing the global SHOPIFY_*/
-- POSTEX_MERCHANT_TOKEN env vars - once a second org exists, those globals
-- would otherwise point every org's "Sync from Shopify" button at the same
-- (first org's) store. shopify_access_token/postex_merchant_token are
-- encrypted at the app layer (Fernet, app/org_settings.py, SETTINGS_ENCRYPTION_KEY)
-- before being stored here - never plaintext, since these are third-party
-- secrets belonging to external clients, not this app's own credentials.
-- See supabase/migrations/20260730110000_org_integration_settings_table.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_integration_settings (
    org_id                    UUID PRIMARY KEY REFERENCES system_organizations(id),
    shopify_store_url         TEXT,
    shopify_access_token      TEXT,
    -- Per-org override; falls back to a shared default (app/org_settings.py)
    -- when unset - it isn't sensitive, so no need to force every org to set it.
    shopify_api_version       TEXT,
    -- Shopify's expiring offline token model (mandatory for Public apps created
    -- on/after 2026-04-01) - shopify_access_token expires at shopify_token_expires_at
    -- and is refreshed via shopify_refresh_token; see app/org_settings.py.
    shopify_refresh_token     TEXT,
    shopify_token_expires_at  TIMESTAMPTZ,
    postex_merchant_token     TEXT,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- Login brute-force lockout, keyed by email (replaces the retired app-PIN's
-- pin_lockouts/record_pin_lockout_failure - see ORGANIZATIONS_USERS_PLAN.md
-- Phase 4). Keyed by the credential being attacked (a user's email) instead
-- of client IP, since each user now has their own password rather than
-- everyone sharing one PIN.
-- See supabase/migrations/20260730050000_login_lockouts_table.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_login_lockouts (
    email         TEXT PRIMARY KEY,
    fails         INTEGER NOT NULL DEFAULT 0,
    first_fail_at TIMESTAMPTZ NOT NULL,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION record_login_lockout_failure(
    p_email TEXT,
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
    FROM system_login_lockouts WHERE email = p_email
    FOR UPDATE;

    IF v_fails IS NULL OR v_now - v_first_fail > (p_window_seconds || ' seconds')::INTERVAL THEN
        v_fails := 1;
        v_first_fail := v_now;
    ELSE
        v_fails := v_fails + 1;
    END IF;

    v_locked_until := CASE WHEN v_fails >= p_max_attempts
        THEN v_now + (p_window_seconds || ' seconds')::INTERVAL
        ELSE NULL END;

    INSERT INTO system_login_lockouts (email, fails, first_fail_at, locked_until, updated_at)
    VALUES (p_email, v_fails, v_first_fail, v_locked_until, v_now)
    ON CONFLICT (email) DO UPDATE SET
        fails = EXCLUDED.fails,
        first_fail_at = EXCLUDED.first_fail_at,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at;

    RETURN QUERY SELECT v_locked_until;
END;
$$;


-- ============================================================================
-- System bootstrap (makes POST /auth/bootstrap race-free). Single row, fixed
-- id='default'. The route inserts this row with ON CONFLICT DO NOTHING and
-- only proceeds if the insert actually affected a row, instead of a plain
-- "SELECT COUNT(*) FROM users" check, which would be a TOCTOU race under
-- concurrent requests.
-- See supabase/migrations/20260730060000_system_bootstrap_table.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS system_bootstrap (
    id           TEXT PRIMARY KEY DEFAULT 'default',
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- Products & variants
-- ============================================================================

-- Products (one row per product). shopify_product_id stays a plain global
-- UNIQUE (not per-org) - Shopify's numeric resource ids are globally unique
-- across the whole platform, unlike the shop-scoped order_number below.
CREATE TABLE IF NOT EXISTS shopify_products (
    id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id              UUID NOT NULL REFERENCES system_organizations(id),
    shopify_product_id  BIGINT UNIQUE,                 -- Shopify sync key
    name                VARCHAR(255) NOT NULL,
    price               DECIMAL(10, 2) DEFAULT 0.00,   -- Selling price (same across variants)
    cost_price          DECIMAL(10, 2),                -- Cost price (same across variants)
    collection          VARCHAR(255),                  -- Collection name (e.g. from Shopify)
    image_url           TEXT,
    -- True while Shopify reports this product active; sync-shopify flips it false instead
    -- of deleting the row when a product is archived/removed on Shopify. The products list
    -- only shows is_active = true rows.
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Variants (one row per variant, linked to a product).
CREATE TABLE IF NOT EXISTS shopify_variants (
    id                  UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id              UUID NOT NULL REFERENCES system_organizations(id),
    product_id          UUID NOT NULL REFERENCES shopify_products(id) ON DELETE CASCADE,
    shopify_variant_id  BIGINT UNIQUE,                 -- Shopify sync key
    title               VARCHAR(255) NOT NULL,         -- e.g. "S", "M", "Red"
    quantity            INTEGER DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- Orders
-- ============================================================================

CREATE TABLE IF NOT EXISTS shopify_orders (
    id                       UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id                   UUID NOT NULL REFERENCES system_organizations(id),
    -- order_number is shop-scoped in Shopify (sequential, starts low), unlike
    -- shopify_products/shopify_orders' own numeric Shopify resource ids - two different orgs'
    -- stores can and will produce the same order_number, so uniqueness is
    -- composite with org_id, not a plain column UNIQUE.
    order_number             INTEGER NOT NULL,
    courier                  VARCHAR(100) NOT NULL,
    tracking_number          VARCHAR(255),
    folio                    VARCHAR(255),
    order_status             VARCHAR(50) NOT NULL,
    delivery_status          JSONB,
    total_amount             DECIMAL(10, 2) NOT NULL,
    advance_amount           DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    -- Advance reconciliation (Shopify advance_amount vs transaction order-advance entries):
    -- 1 = no advance, 2 = shopify only, 3 = transaction only, 4 = both match, 5 = both mismatch
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
    updated_at               TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT orders_org_id_order_number_key UNIQUE (org_id, order_number)
);

-- Legacy items[] (flat "Name - Variant" strings), superseded by structured line_items
-- (JSONB) above. Verified every order either has line_items populated or has no item
-- data in either column (see TODO.md §6) before dropping - safe to re-run, no-ops once
-- the column is gone.
    ALTER TABLE shopify_orders DROP COLUMN IF EXISTS items;


-- ============================================================================
-- Load sheet logs (courier assignment records)
-- ============================================================================

CREATE TABLE IF NOT EXISTS shopify_load_sheet_logs (
    id                 UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id             UUID NOT NULL REFERENCES system_organizations(id),
    assignment_number  VARCHAR(100) NOT NULL,
    rider_name         VARCHAR(255) NOT NULL,
    order_numbers      JSONB NOT NULL DEFAULT '[]',   -- e.g. ["2721", "2722"]
    delivery_charge    DECIMAL(10, 2),                -- applied to all orders in this load sheet
    created_at         TIMESTAMPTZ DEFAULT NOW()
);


-- ============================================================================
-- Sync status (one row per org per sync type; currently just each org's own
-- Shopify orders sync). Lets the API expose "last synced" and gate the
-- periodic backend sync on staleness. in_progress/lock_acquired_at are a lock
-- so the periodic sync, a manual sync, and multiple instances can't run
-- concurrently - acquired via a conditional UPDATE, not an advisory lock
-- (unusable through PostgREST). Keyed by (org_id, id) - was `id` alone
-- (single global row) before each org synced its own store independently.
-- See supabase/migrations/20260728000000_create_sync_status.sql and
-- 20260730070000_add_org_id_to_business_tables.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shopify_sync_status (
    org_id           UUID NOT NULL REFERENCES system_organizations(id),
    id               TEXT NOT NULL,
    last_synced_at   TIMESTAMPTZ,
    in_progress      BOOLEAN NOT NULL DEFAULT FALSE,
    lock_acquired_at TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (org_id, id)
);


-- ============================================================================
-- Transactions & ledgers
-- ----------------------------------------------------------------------------
-- Records daily debit/credit entries with carried-forward balances.
-- Ledger summaries are derived from transaction_entries where folio = ledger.id
-- (there is no separate ledger_entries table).
--
-- ---------------------------------------------------------------------------
-- BOTH SIDES ARE NAMED
-- ---------------------------------------------------------------------------
-- A transaction entry records where money came from and where it went:
--   from_account_id  credited (money came FROM here)
--   to_account_id    debited  (money went TO here)
-- NULL on a side means cash. So an entry only moves Cash in Hand when one of
-- its sides is NULL - paying a supplier from a bank account names both sides
-- and never touches cash.
--
-- This replaced a single `folio` plus an `entry_type` saying which side the
-- folio sat on, which forced every entry through cash and made the two columns
-- of transaction_daily_balances read the folio's side inverted.
-- ============================================================================

-- Ledgers: individual accounts (suppliers, customers, expense heads, …).
-- type: standard accounting Nature — drives display grouping only (see
-- recalc_ledger_balance below, whose formula is the same for every ledger
-- regardless of Nature) — a fixed, closed set rather than free text, since a
-- typo here silently creates an untracked bucket.
CREATE TABLE IF NOT EXISTS finances_ledgers (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES system_organizations(id),
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
        WHERE table_schema = 'public' AND table_name = 'finances_ledgers' AND column_name = 'section'
    ) THEN
        ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS type VARCHAR(100);
        UPDATE finances_ledgers
        SET type = CASE WHEN section = 'Vendors' THEN 'Payable Vendors' ELSE section END
        WHERE type IS NULL;
        ALTER TABLE finances_ledgers ALTER COLUMN type SET NOT NULL;
        ALTER TABLE finances_ledgers DROP COLUMN section;
    END IF;
END $$;

-- Migrates the old business-category `type` values to standard accounting
-- Nature categories. Self-guarding via the WHERE clause — a no-op once no
-- rows carry the old values.
UPDATE finances_ledgers SET type = CASE type
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
ALTER TABLE finances_ledgers DROP CONSTRAINT IF EXISTS ledgers_type_check;
ALTER TABLE finances_ledgers ADD CONSTRAINT ledgers_type_check
    CHECK (type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense'));

-- Whether this ledger's balance is included in the Cash In Hand total (set via
-- a checkbox on the create/edit ledger UI, not implied by `type`). Backfill
-- only runs the first time the column is added, so it preserves the
-- pre-existing Bank-only behavior without clobbering manual toggles on re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'finances_ledgers' AND column_name = 'include_in_cash_in_hand'
    ) THEN
        ALTER TABLE finances_ledgers ADD COLUMN include_in_cash_in_hand BOOLEAN NOT NULL DEFAULT FALSE;
        UPDATE finances_ledgers SET include_in_cash_in_hand = TRUE WHERE type = 'Bank';
    END IF;
END $$;

-- Chart-of-accounts columns (Phase 1). `ledgers` IS the chart of accounts -
-- deliberately not renamed to `accounts`, which would cascade through every
-- route, the frontend, the RLS list and the org-scope lint for no functional
-- gain. system_key names the accounts posting code looks up by role.
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS code               VARCHAR(20);
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS parent_id          UUID REFERENCES finances_ledgers(id);
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS subtype            VARCHAR(50);
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS system_key         VARCHAR(40);
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS is_cash_equivalent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS enabled            BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_system_key
    ON finances_ledgers (org_id, system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_code
    ON finances_ledgers (org_id, code) WHERE code IS NOT NULL;

-- Which ledger order advances post to is system_key = 'orders', like every other
-- fixed role. It began as a dedicated is_orders_ledger boolean (Phase 0, before
-- system_key existed); this carries an older database over and drops it. Must
-- stay AFTER system_key is added above - the carry-over writes into it.
-- See supabase/migrations/20260801140000_ledger_roles_via_system_key.sql.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'finances_ledgers'
           AND column_name = 'is_orders_ledger'
    ) THEN
        -- Only where system_key is free: an account already holding another role
        -- keeps it rather than being silently repurposed.
        EXECUTE $q$
            UPDATE finances_ledgers SET system_key = 'orders'
             WHERE is_orders_ledger IS TRUE AND system_key IS NULL
        $q$;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_ledgers_one_orders_ledger_per_org;
ALTER TABLE finances_ledgers DROP COLUMN IF EXISTS is_orders_ledger;

-- Which Month Summary expense line this ledger's spending rolls into (NULL =
-- excluded). Replaces get_month_summary_totals' old ledger-*name* substring
-- matching, where 'ad' also caught "Load Sheet"/"Trade"/"Adnan" and renaming a
-- ledger silently moved money between P&L lines. See
-- supabase/migrations/20260801040000_ledgers_report_category.sql.
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS report_category VARCHAR(20);
ALTER TABLE finances_ledgers DROP CONSTRAINT IF EXISTS ledgers_report_category_check;
ALTER TABLE finances_ledgers ADD CONSTRAINT ledgers_report_category_check
    CHECK (report_category IS NULL OR report_category IN ('shopify', 'ad', 'other'));

-- Opening balance, set once at ledger creation (rarely changed after). Folded
-- into ledger_balances by recalc_ledger_balance so the running balance always
-- starts from this instead of 0 — see the ledgers_opening_balance_trigger
-- below, which recalculates whenever this column is inserted/updated.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'finances_ledgers' AND column_name = 'opening_balance'
    ) THEN
        ALTER TABLE finances_ledgers ADD COLUMN opening_balance DECIMAL(12, 2) NOT NULL DEFAULT 0.00;
    END IF;
END $$;

-- Transaction entries: all transactions. folio is required and links to a ledger.
CREATE TABLE IF NOT EXISTS finances_transaction_entries (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES system_organizations(id),
    entry_date    DATE NOT NULL,
    amount        DECIMAL(12, 2) NOT NULL CHECK (amount > 0),
    description   TEXT,
    -- NULL on a side means cash; see "BOTH SIDES ARE NAMED" above.
    from_account_id UUID REFERENCES finances_ledgers(id) ON DELETE RESTRICT,
    to_account_id   UUID REFERENCES finances_ledgers(id) ON DELETE RESTRICT,
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
ALTER TABLE finances_transaction_entries ADD COLUMN IF NOT EXISTS idempotency_key UUID;

-- Carries a database created before the two-sided change over, then retires the
-- old columns. entry_type was the FOLIO's side: 'credit' = money came from it
-- into cash, 'debit' = cash paid out to it.
-- See supabase/migrations/20260801160000_cashbook_from_to_accounts.sql.
ALTER TABLE finances_transaction_entries ADD COLUMN IF NOT EXISTS from_account_id UUID REFERENCES finances_ledgers(id) ON DELETE RESTRICT;
ALTER TABLE finances_transaction_entries ADD COLUMN IF NOT EXISTS to_account_id   UUID REFERENCES finances_ledgers(id) ON DELETE RESTRICT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'finances_transaction_entries'
           AND column_name = 'entry_type'
    ) THEN
        EXECUTE $q$
            UPDATE finances_transaction_entries
               SET from_account_id = CASE WHEN entry_type = 'credit' THEN folio ELSE NULL END,
                   to_account_id   = CASE WHEN entry_type = 'debit'  THEN folio ELSE NULL END
             WHERE from_account_id IS NULL AND to_account_id IS NULL
        $q$;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_cashbook_entries_folio_order_number;
DROP INDEX IF EXISTS idx_cashbook_entries_type;
ALTER TABLE finances_transaction_entries DROP CONSTRAINT IF EXISTS cashbook_entries_entry_type_check;
ALTER TABLE finances_transaction_entries DROP COLUMN IF EXISTS folio;
ALTER TABLE finances_transaction_entries DROP COLUMN IF EXISTS entry_type;

-- Both NULL would be cash-to-cash, which moves nothing; both equal would be an
-- account paying itself.
ALTER TABLE finances_transaction_entries DROP CONSTRAINT IF EXISTS transaction_entries_two_sides_check;
ALTER TABLE finances_transaction_entries ADD CONSTRAINT transaction_entries_two_sides_check
    CHECK (
        (from_account_id IS NOT NULL OR to_account_id IS NOT NULL)
        AND from_account_id IS DISTINCT FROM to_account_id
    );

-- Daily balances: opening/closing balance per day (auto-maintained by a DB
-- trigger on transaction_entries — see "Triggers" section below).
-- balance_date is unique per org (not globally) - two orgs both posting
-- entries on the same calendar date must each get their own balance row.
CREATE TABLE IF NOT EXISTS finances_transaction_daily_balances (
    id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id           UUID NOT NULL REFERENCES system_organizations(id),
    balance_date     DATE NOT NULL,
    opening_balance  DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    -- Cash-perspective (see "THE TWO PERSPECTIVES" above): total_debit is money
    -- received, total_credit is money paid out.
    total_debit      DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    total_credit     DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    closing_balance  DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT transaction_daily_balances_org_id_balance_date_key UNIQUE (org_id, balance_date)
);

-- Per-ledger running balance (opening_balance + incoming - outgoing),
-- auto-maintained by DB triggers on transaction_entries and on ledgers.opening_balance
-- — see "Triggers" section below. Only ledgers with a non-zero balance have a
-- row; treat a missing row as 0. Keyed by ledger_id alone (not org_id, ledger_id)
-- since ledger_id is already a UUID unique to one org's ledger - org_id is
-- still added as a plain column so app.org_scope.org_table() has one to filter on.
CREATE TABLE IF NOT EXISTS finances_ledger_balances (
    ledger_id   UUID PRIMARY KEY REFERENCES finances_ledgers(id) ON DELETE CASCADE,
    org_id      UUID NOT NULL REFERENCES system_organizations(id),
    -- DECIMAL(14, 2) to match journal_lines: a balance sums many lines, so it
    -- can legitimately exceed the width of any single amount.
    balance     DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Widens an existing table created before the Phase 1 journal (CREATE TABLE
-- above only runs on a fresh install). Idempotent: a no-op once already 14,2.
ALTER TABLE finances_ledger_balances ALTER COLUMN balance TYPE DECIMAL(14, 2);

-- Immutable log of transaction_entries deletions (DELETE /transactions/entries/{id}
-- is a hard delete with no other record). Auto-populated by a DB trigger —
-- see "Triggers" section below — so it captures every deletion path, not
-- just the API, including a bulk TRUNCATE from the SQL editor. Records what
-- was deleted and when; not who — there's no per-user identity yet (see
-- Organizations & Users backlog), so this closes the "what/when" half of the
-- gap only.
CREATE TABLE IF NOT EXISTS finances_transaction_entry_audit_log (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES system_organizations(id),
    entry_id      UUID NOT NULL,
    entry_date    DATE NOT NULL,
    amount        DECIMAL(12, 2) NOT NULL,
    description   TEXT,
    from_account_id UUID,
    to_account_id   UUID,
    order_number  VARCHAR(20),
    deleted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Carry-over for a log created before the two-sided change.
ALTER TABLE finances_transaction_entry_audit_log ADD COLUMN IF NOT EXISTS from_account_id UUID;
ALTER TABLE finances_transaction_entry_audit_log ADD COLUMN IF NOT EXISTS to_account_id   UUID;
ALTER TABLE finances_transaction_entry_audit_log ALTER COLUMN entry_type DROP NOT NULL;
ALTER TABLE finances_transaction_entry_audit_log ALTER COLUMN folio      DROP NOT NULL;


-- ============================================================================
-- Indexes
-- ============================================================================

-- Products & variants
CREATE INDEX IF NOT EXISTS idx_products_name                ON shopify_products(name);
CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id  ON shopify_products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_products_org_id               ON shopify_products(org_id);
CREATE INDEX IF NOT EXISTS idx_products_is_active            ON shopify_products(is_active);
CREATE INDEX IF NOT EXISTS idx_variants_product_id          ON shopify_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_shopify_variant_id  ON shopify_variants(shopify_variant_id);
CREATE INDEX IF NOT EXISTS idx_variants_org_id              ON shopify_variants(org_id);

-- Orders
CREATE INDEX IF NOT EXISTS idx_orders_number                 ON shopify_orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_order_status           ON shopify_orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_piece_received         ON shopify_orders(piece_received);
-- Period/month views filter and paginate on order_receiving_date (largest, hottest scan).
CREATE INDEX IF NOT EXISTS idx_orders_order_receiving_date   ON shopify_orders(order_receiving_date);
-- Shopify sync links NNNN-R replacement orders back to their originals via this column.
CREATE INDEX IF NOT EXISTS idx_orders_replacement_of_order_no ON shopify_orders(replacement_of_order_no);
CREATE INDEX IF NOT EXISTS idx_orders_org_id                 ON shopify_orders(org_id);
-- NOTE: delivery_status is JSONB; a plain btree index on it cannot search inside the
-- JSON and provides no benefit, so it is intentionally omitted. To query into it, use GIN:
--   CREATE INDEX IF NOT EXISTS idx_orders_delivery_status_gin ON shopify_orders USING GIN (delivery_status);

-- Load sheet logs
CREATE INDEX IF NOT EXISTS idx_load_sheet_logs_created_at    ON shopify_load_sheet_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_load_sheet_logs_org_id        ON shopify_load_sheet_logs(org_id);

-- Ledgers: case-insensitive uniqueness so "Bank" and "bank" can't both exist
-- within the same org (matches the case-insensitive name match already used
-- by the bulk-entry ledger lookup, frontend/renderer.js findLedgerByName) -
-- scoped per org, not global, so two different orgs can each have a "Bank".
-- If this fails to create, an existing pair of ledgers in the same org
-- already differs only by case — rename or merge them first.
-- This index is the uniqueness enforcement itself, not just a lookup aid -
-- Postgres can't promote a UNIQUE constraint onto an expression like
-- lower(name) (ADD CONSTRAINT ... USING INDEX rejects expression indexes),
-- so there is no separate named constraint here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_org_id_name_lower ON finances_ledgers (org_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_ledgers_org_id ON finances_ledgers(org_id);

-- Transactions
CREATE INDEX IF NOT EXISTS idx_transaction_entries_date         ON finances_transaction_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_transaction_entries_from_account ON finances_transaction_entries(from_account_id);
CREATE INDEX IF NOT EXISTS idx_transaction_entries_to_account   ON finances_transaction_entries(to_account_id);
CREATE INDEX IF NOT EXISTS idx_transaction_entries_order_number ON finances_transaction_entries(order_number);
CREATE INDEX IF NOT EXISTS idx_transaction_entries_org_id       ON finances_transaction_entries(org_id);
-- Advance reconciliation (advance_status.py) filters on the From side plus the
-- order number: an advance is money received from the Orders account.
CREATE INDEX IF NOT EXISTS idx_transaction_entries_from_order_number
    ON finances_transaction_entries(from_account_id, order_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_entries_idempotency_key
    ON finances_transaction_entries(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_daily_balances_date           ON finances_transaction_daily_balances(balance_date);
CREATE INDEX IF NOT EXISTS idx_transaction_daily_balances_org_id ON finances_transaction_daily_balances(org_id);
CREATE INDEX IF NOT EXISTS idx_ledger_balances_org_id        ON finances_ledger_balances(org_id);
CREATE INDEX IF NOT EXISTS idx_transaction_entry_audit_log_entry_id   ON finances_transaction_entry_audit_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_transaction_entry_audit_log_deleted_at ON finances_transaction_entry_audit_log(deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_transaction_entry_audit_log_org_id     ON finances_transaction_entry_audit_log(org_id);


-- ============================================================================
-- Journal (double-entry general ledger) — FINANCE_ACCOUNTING_PLAN.md Phase 1
-- ----------------------------------------------------------------------------
-- Before Phase 1 a transaction was a single row in this table, with one folio
-- ledger and an implicit, invisible cash account opposite it. Non-cash
-- transactions (credit purchase, accrual, stock write-off, opening AP) were
-- literally unrepresentable, and nothing could prove the books balanced.
--
-- journal_entries/journal_lines are now the complete record of every posting,
-- and ledger_balances derives from them. transaction_entries is still the *write*
-- path for cash transactions and is projected in by trigger, so the Transactions UI
-- is unchanged; documents added in later phases post here directly.
-- ============================================================================

-- Voucher header. source_type/source_id link an entry back to whatever produced
-- it, so a document can find and re-post its own accounting:
--   'transaction_entry'  -> transaction_entries.id (written by the projection below)
--   'opening_balance' -> NULL (one per org)
--   'manual'          -> NULL
CREATE TABLE IF NOT EXISTS finances_journal_entries (
    id             UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id         UUID NOT NULL REFERENCES system_organizations(id),
    entry_date     DATE NOT NULL,
    voucher_type   VARCHAR(30) NOT NULL DEFAULT 'manual',
    narration      TEXT,
    source_type    VARCHAR(30),
    source_id      UUID,
    -- Posted entries are corrected by a reversing entry, never edited in place
    -- (FINANCE_ACCOUNTING_PLAN.md C1); Phase 5 adds the immutability trigger.
    reversal_of_id UUID REFERENCES finances_journal_entries(id),
    created_by     UUID REFERENCES system_users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one entry per source row, so re-projecting updates instead of
-- silently posting the same amount twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_source
    ON finances_journal_entries (org_id, source_type, source_id)
    WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_org_date ON finances_journal_entries (org_id, entry_date);

-- Amounts are unsigned in two columns rather than one signed column: that is
-- the form every statement, trial balance and audit expects, and it makes
-- "exactly one side per line" a CHECK rather than a convention.
CREATE TABLE IF NOT EXISTS finances_journal_lines (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES system_organizations(id),
    journal_id  UUID NOT NULL REFERENCES finances_journal_entries(id) ON DELETE CASCADE,
    account_id  UUID NOT NULL REFERENCES finances_ledgers(id) ON DELETE RESTRICT,
    debit       DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (debit  >= 0),
    credit      DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (credit >= 0),
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT journal_lines_one_side_only CHECK (
        (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_journal_id ON finances_journal_lines (journal_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account_id ON finances_journal_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_org_id     ON finances_journal_lines (org_id);

-- Debits = credits, enforced by the database. DEFERRABLE INITIALLY DEFERRED so
-- it runs once at COMMIT, after all of an entry's lines are in - which is why
-- posting goes through post_journal_entry() rather than two PostgREST calls
-- (two calls are two transactions, and the first would fail on its own).
CREATE OR REPLACE FUNCTION trg_journal_entry_must_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_journal_id UUID;
    v_debit  NUMERIC(14, 2);
    v_credit NUMERIC(14, 2);
BEGIN
    v_journal_id := COALESCE(NEW.journal_id, OLD.journal_id);

    IF NOT EXISTS (SELECT 1 FROM finances_journal_entries WHERE id = v_journal_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
      INTO v_debit, v_credit
      FROM finances_journal_lines WHERE journal_id = v_journal_id;

    IF v_debit <> v_credit THEN
        RAISE EXCEPTION 'Journal entry % does not balance: debits %, credits %',
            v_journal_id, v_debit, v_credit;
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_must_balance ON finances_journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_must_balance
AFTER INSERT OR UPDATE OR DELETE ON finances_journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_journal_entry_must_balance();

-- A header with no lines would otherwise slip past the line trigger entirely.
CREATE OR REPLACE FUNCTION trg_journal_entry_must_have_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM finances_journal_entries WHERE id = NEW.id) THEN
        RETURN NULL;
    END IF;
    IF (SELECT COUNT(*) FROM finances_journal_lines WHERE journal_id = NEW.id) < 2 THEN
        RAISE EXCEPTION 'Journal entry % must have at least two lines', NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS journal_entries_must_have_lines ON finances_journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_must_have_lines
AFTER INSERT ON finances_journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trg_journal_entry_must_have_lines();

-- Every journal line write moves an account balance.
CREATE OR REPLACE FUNCTION trg_journal_lines_recalc_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalc_ledger_balance(OLD.account_id);
        RETURN OLD;
    END IF;

    PERFORM recalc_ledger_balance(NEW.account_id);
    IF TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
        PERFORM recalc_ledger_balance(OLD.account_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_balance_trigger ON finances_journal_lines;
CREATE TRIGGER journal_lines_balance_trigger
AFTER INSERT OR UPDATE OF account_id, debit, credit OR DELETE ON finances_journal_lines
FOR EACH ROW
EXECUTE FUNCTION trg_journal_lines_recalc_balance();

-- Creates a system account for an org, or returns the existing one. `cash` is
-- always CREATED, never adopted from a same-named existing ledger: the
-- implicit cash pot every transaction posts against is a different account
-- from any user-made ledger
-- called "Cash" (that one has entries posted against it as a folio), and
-- merging the two would double-count every one of them. Name clashes fall back
-- to a suffix rather than failing on idx_ledgers_org_id_name_lower.
CREATE OR REPLACE FUNCTION ensure_system_ledger(
    p_org_id UUID,
    p_system_key VARCHAR,
    p_name VARCHAR,
    p_type VARCHAR,
    p_code VARCHAR,
    p_is_cash_equivalent BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_id     UUID;
    v_name   VARCHAR := p_name;
    v_suffix INT := 1;
BEGIN
    SELECT id INTO v_id FROM finances_ledgers WHERE org_id = p_org_id AND system_key = p_system_key;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    WHILE EXISTS (
        SELECT 1 FROM finances_ledgers WHERE org_id = p_org_id AND lower(name) = lower(v_name)
    ) LOOP
        v_suffix := v_suffix + 1;
        v_name := p_name || ' (' || v_suffix || ')';
    END LOOP;

    INSERT INTO finances_ledgers (org_id, name, type, code, system_key, is_cash_equivalent, opening_balance)
    VALUES (p_org_id, v_name, p_type, p_code, p_system_key, p_is_cash_equivalent, 0)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ledgers.opening_balance used to be a free-floating number with no contra
-- entry: the moment one was set, total debits stopped equalling total credits
-- (FINANCE_ACCOUNTING_PLAN.md A4). It now posts against Opening Balance Equity.
-- Rebuilt wholesale rather than patched line by line, so it is idempotent.
CREATE OR REPLACE FUNCTION sync_opening_balance_journal(p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_obe_id     UUID;
    v_journal_id UUID;
    v_net        NUMERIC(14, 2);
    v_date       DATE;
BEGIN
    SELECT id INTO v_obe_id
      FROM finances_ledgers WHERE org_id = p_org_id AND system_key = 'opening_balance_equity';
    IF v_obe_id IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM finances_journal_entries WHERE org_id = p_org_id AND source_type = 'opening_balance';

    SELECT COALESCE(SUM(opening_balance), 0) INTO v_net
      FROM finances_ledgers WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    -- Tests for rows, not for v_net: a net of zero is not the same as having no
    -- opening balances at all.
    IF NOT EXISTS (
        SELECT 1 FROM finances_ledgers
         WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id
    ) THEN
        RETURN;
    END IF;

    -- One day before the earliest transaction, so opening balances always sort
    -- ahead of activity on a statement.
    SELECT COALESCE(MIN(entry_date), CURRENT_DATE) - 1 INTO v_date
      FROM finances_transaction_entries WHERE org_id = p_org_id;

    INSERT INTO finances_journal_entries (org_id, entry_date, voucher_type, narration, source_type)
    VALUES (p_org_id, v_date, 'opening', 'Opening balances', 'opening_balance')
    RETURNING id INTO v_journal_id;

    -- opening_balance is stored Debit-positive, matching journal convention.
    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id, v_journal_id, id,
           CASE WHEN opening_balance > 0 THEN  opening_balance ELSE 0 END,
           CASE WHEN opening_balance < 0 THEN -opening_balance ELSE 0 END,
           'Opening balance'
      FROM finances_ledgers
     WHERE org_id = p_org_id AND opening_balance <> 0 AND id <> v_obe_id;

    IF v_net <> 0 THEN
        INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
        VALUES (p_org_id, v_journal_id, v_obe_id,
                CASE WHEN v_net < 0 THEN -v_net ELSE 0 END,
                CASE WHEN v_net > 0 THEN  v_net ELSE 0 END,
                'Opening balance offset');
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION project_transaction_entry_to_journal(p_entry_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    e            RECORD;
    v_cash_id    UUID;
    v_from       UUID;
    v_to         UUID;
    v_journal_id UUID;
BEGIN
    SELECT * INTO e FROM finances_transaction_entries WHERE id = p_entry_id;

    IF NOT FOUND THEN
        DELETE FROM finances_journal_entries
         WHERE source_type = 'transaction_entry' AND source_id = p_entry_id;
        RETURN;
    END IF;

    -- Only looked up when a side is actually cash, so an org with no cash
    -- account can still record transfers between two named ledgers.
    IF e.from_account_id IS NULL OR e.to_account_id IS NULL THEN
        SELECT id INTO v_cash_id FROM finances_ledgers WHERE org_id = e.org_id AND system_key = 'cash';
        IF v_cash_id IS NULL THEN
            RAISE EXCEPTION 'Organization % has no system cash account', e.org_id;
        END IF;
    END IF;

    v_from := COALESCE(e.from_account_id, v_cash_id);
    v_to   := COALESCE(e.to_account_id, v_cash_id);

    -- Rebuild rather than patch: an edited entry can change date, amount or
    -- either side, and re-posting from scratch cannot drift.
    DELETE FROM finances_journal_entries
     WHERE source_type = 'transaction_entry' AND source_id = p_entry_id;

    INSERT INTO finances_journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id)
    VALUES
        (e.org_id, e.entry_date, 'transaction', e.description, 'transaction_entry', e.id)
    RETURNING id INTO v_journal_id;

    -- Money goes TO the debit side and comes FROM the credit side.
    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    VALUES (e.org_id, v_journal_id, v_to,   e.amount, 0, e.description),
           (e.org_id, v_journal_id, v_from, 0, e.amount, e.description);
END;
$$;


CREATE OR REPLACE FUNCTION trg_transaction_entries_project_journal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM finances_journal_entries
         WHERE source_type = 'transaction_entry' AND source_id = OLD.id;
        RETURN OLD;
    END IF;

    PERFORM project_transaction_entry_to_journal(NEW.id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transaction_entries_journal_trigger ON finances_transaction_entries;
CREATE TRIGGER transaction_entries_journal_trigger
AFTER INSERT OR UPDATE OF entry_date, from_account_id, to_account_id, amount, description OR DELETE
ON finances_transaction_entries
FOR EACH ROW
EXECUTE FUNCTION trg_transaction_entries_project_journal();

-- System ledgers are created WITH the organization and are not user-selectable:
-- system_key is server-managed, and a ledger holding one cannot be deleted.
--
-- The trigger sits on the table rather than in the org-creation route so it
-- fires for every writer - the API, the superadmin portal, a row inserted from
-- the SQL editor - matching how the balance and journal triggers are handled.
-- See supabase/migrations/20260801150000_system_ledgers_on_org_creation.sql.
CREATE OR REPLACE FUNCTION trg_organizations_seed_system_ledgers()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- ensure_system_ledger is create-or-return, so this never disturbs an
    -- account an org already has for the role.
    PERFORM ensure_system_ledger(NEW.id, 'cash', 'Cash', 'Asset', '1000', TRUE);
    PERFORM ensure_system_ledger(NEW.id, 'opening_balance_equity', 'Opening Balance Equity', 'Equity', '3900');
    -- Advances received before delivery are money held against goods still
    -- owed, so Orders is a liability rather than revenue.
    PERFORM ensure_system_ledger(NEW.id, 'orders', 'Orders', 'Liability', '2200');
    PERFORM ensure_system_ledger(NEW.id, 'inventory', 'Inventory', 'Asset', '1400');
    -- No tax_on_purchases: receive_bill creates it on the first taxed bill.
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_seed_system_ledgers ON system_organizations;
CREATE TRIGGER organizations_seed_system_ledgers
AFTER INSERT ON system_organizations
FOR EACH ROW
EXECUTE FUNCTION trg_organizations_seed_system_ledgers();

-- Covers orgs that predate the trigger.
DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM system_organizations LOOP
        PERFORM ensure_system_ledger(org.id, 'cash', 'Cash', 'Asset', '1000', TRUE);
        PERFORM ensure_system_ledger(org.id, 'opening_balance_equity', 'Opening Balance Equity', 'Equity', '3900');
        PERFORM ensure_system_ledger(org.id, 'orders', 'Orders', 'Liability', '2200');
        PERFORM ensure_system_ledger(org.id, 'inventory', 'Inventory', 'Asset', '1400');
    END LOOP;
END $$;

-- The only supported way for the application to create a journal entry: header
-- and lines must land in one transaction for the deferred balance constraint to
-- be checkable at all.
CREATE OR REPLACE FUNCTION post_journal_entry(
    p_org_id       UUID,
    p_entry_date   DATE,
    p_lines        JSONB,
    p_narration    TEXT DEFAULT NULL,
    p_voucher_type VARCHAR DEFAULT 'manual',
    p_created_by   UUID DEFAULT NULL,
    p_source_type  VARCHAR DEFAULT NULL,
    p_source_id    UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_journal_id UUID;
    v_debit      NUMERIC(14, 2);
    v_credit     NUMERIC(14, 2);
    v_count      INT;
    v_foreign    INT;
BEGIN
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
        RAISE EXCEPTION 'lines must be a JSON array';
    END IF;

    SELECT COUNT(*),
           COALESCE(SUM((l->>'debit')::NUMERIC), 0),
           COALESCE(SUM((l->>'credit')::NUMERIC), 0)
      INTO v_count, v_debit, v_credit
      FROM jsonb_array_elements(p_lines) AS l;

    IF v_count < 2 THEN
        RAISE EXCEPTION 'A journal entry needs at least two lines, got %', v_count;
    END IF;

    IF v_debit <> v_credit THEN
        RAISE EXCEPTION 'Journal entry does not balance: debits %, credits %', v_debit, v_credit;
    END IF;

    IF v_debit = 0 THEN
        RAISE EXCEPTION 'A journal entry must move a non-zero amount';
    END IF;

    -- Every account must belong to the posting org - account_id is
    -- client-supplied, unlike p_org_id.
    SELECT COUNT(*) INTO v_foreign
      FROM jsonb_array_elements(p_lines) AS l
     WHERE NOT EXISTS (
         SELECT 1 FROM finances_ledgers WHERE id = (l->>'account_id')::UUID AND org_id = p_org_id
     );
    IF v_foreign > 0 THEN
        RAISE EXCEPTION 'Journal lines reference % account(s) outside this organization', v_foreign;
    END IF;

    INSERT INTO finances_journal_entries
        (org_id, entry_date, voucher_type, narration, source_type, source_id, created_by)
    VALUES
        (p_org_id, p_entry_date, p_voucher_type, p_narration, p_source_type, p_source_id, p_created_by)
    RETURNING id INTO v_journal_id;

    INSERT INTO finances_journal_lines (org_id, journal_id, account_id, debit, credit, description)
    SELECT p_org_id, v_journal_id, (l->>'account_id')::UUID,
           COALESCE((l->>'debit')::NUMERIC, 0),
           COALESCE((l->>'credit')::NUMERIC, 0),
           l->>'description'
      FROM jsonb_array_elements(p_lines) AS l;

    RETURN v_journal_id;
END;
$$;

-- The ledger statement reads the journal, not transaction_entries: a received bill
-- or a manual journal entry moves an account's balance, so it has to appear as a
-- row explaining why. See
-- supabase/migrations/20260801130000_ledger_statement_from_journal.sql.
-- Postgres won't let CREATE OR REPLACE change a table-returning function's
-- column list ("cannot change return type of existing function") - drop it first.
DROP FUNCTION IF EXISTS get_ledger_statement(UUID, UUID);

CREATE FUNCTION get_ledger_statement(p_org_id UUID, p_ledger_id UUID)
RETURNS TABLE(
    id           UUID,
    entry_date   DATE,
    particulars  TEXT,
    debit        NUMERIC,
    credit       NUMERIC,
    voucher_type VARCHAR,
    source_type  VARCHAR,
    source_id    UUID
)
LANGUAGE sql
STABLE
AS $$
    SELECT jl.id,
           je.entry_date,
           -- The line's own description is the specific one ("Bill BILL-0001");
           -- the entry narration is the fallback for lines posted without one.
           COALESCE(NULLIF(jl.description, ''), je.narration, '') AS particulars,
           jl.debit,
           jl.credit,
           je.voucher_type,
           je.source_type,
           je.source_id
      FROM finances_journal_lines jl
      JOIN finances_journal_entries je ON je.id = jl.journal_id
     WHERE jl.org_id = p_org_id
       AND jl.account_id = p_ledger_id
     -- created_at breaks ties within a date so the running balance is stable
     -- across reloads; the opening entry is dated a day earlier and sorts first.
     ORDER BY je.entry_date, je.created_at, jl.created_at;
$$;


-- Trial balance as of a date. The two column totals being equal is the proof
-- that the books balance - the control that did not exist before Phase 1
-- (FINANCE_ACCOUNTING_PLAN.md A5). Accounts netting to exactly zero are
-- omitted, as on a conventional trial balance.
CREATE OR REPLACE FUNCTION get_trial_balance(p_org_id UUID, p_as_of DATE)
RETURNS TABLE(
    account_id UUID,
    code       VARCHAR,
    name       VARCHAR,
    type       VARCHAR,
    debit      NUMERIC,
    credit     NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH balances AS (
        SELECT l.id, l.code, l.name, l.type,
               COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS net
          FROM finances_ledgers l
          JOIN finances_journal_lines jl   ON jl.account_id = l.id
          JOIN finances_journal_entries je ON je.id = jl.journal_id
         WHERE l.org_id = p_org_id
           AND je.org_id = p_org_id
           AND je.entry_date <= p_as_of
         GROUP BY l.id, l.code, l.name, l.type
    )
    SELECT id, code, name, type,
           CASE WHEN net > 0 THEN  net ELSE 0 END,
           CASE WHEN net < 0 THEN -net ELSE 0 END
      FROM balances
     WHERE net <> 0
     ORDER BY code NULLS LAST, name;
$$;


-- ============================================================================
-- Triggers: transaction_daily_balances / ledger_balances / transaction_entry_audit_log
-- kept in sync by the database, not the app
-- ----------------------------------------------------------------------------
-- Previously an app-layer job (backend/app/routes/transactions.py) recalculated
-- transaction_daily_balances after every entry write. Any write that didn't go
-- through those FastAPI routes (Supabase table editor, a raw SQL delete, a
-- restore) left the balances table stale with nothing to self-heal it — the
-- manual repair endpoint even no-op'd once transaction_entries was empty. Moving
-- this into the database means it fires for every writer, not just the API.
-- ============================================================================

-- Recomputes transaction_daily_balances for balance_date >= p_from_date within
-- one org, chaining the running balance forward from the prior day's closing
-- balance, and drops any balance row left with no entries for its date.
-- p_org_id is required - without it this would sum every org's transaction
-- entries together into one shared balance per date.
--
-- Postgres identifies functions by name + argument types, so a re-run of this
-- file against a database that still has the pre-org-scoping single-argument
-- version would otherwise leave that old overload in place alongside this one.
DROP FUNCTION IF EXISTS recalc_cashbook_daily_balances(DATE);

-- A NULL side IS cash, so an entry only moves the cash balance when one of its
-- sides is NULL. An entry with both sides named is invisible here, which is the
-- whole point of the change.
CREATE OR REPLACE FUNCTION recalc_transaction_daily_balances(p_from_date DATE, p_org_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_opening NUMERIC(12, 2);
BEGIN
    SELECT closing_balance INTO v_opening
    FROM finances_transaction_daily_balances
    WHERE org_id = p_org_id AND balance_date < p_from_date
    ORDER BY balance_date DESC
    LIMIT 1;

    v_opening := COALESCE(v_opening, 0);

    DELETE FROM finances_transaction_daily_balances
    WHERE org_id = p_org_id
      AND balance_date >= p_from_date
      AND balance_date NOT IN (
          SELECT DISTINCT entry_date FROM finances_transaction_entries
          WHERE org_id = p_org_id AND entry_date >= p_from_date
      );

    WITH day_totals AS (
        SELECT entry_date AS balance_date,
               -- Cash is the destination: cash received, a debit to cash.
               COALESCE(SUM(amount) FILTER (WHERE to_account_id IS NULL), 0)   AS total_debit,
               -- Cash is the source: cash paid out, a credit to cash.
               COALESCE(SUM(amount) FILTER (WHERE from_account_id IS NULL), 0) AS total_credit
        FROM finances_transaction_entries
        WHERE org_id = p_org_id AND entry_date >= p_from_date
        GROUP BY entry_date
    ),
    running AS (
        SELECT balance_date,
               total_debit,
               total_credit,
               v_opening + SUM(total_debit - total_credit)
                   OVER (ORDER BY balance_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS closing_balance
        FROM day_totals
    )
    INSERT INTO finances_transaction_daily_balances
        (org_id, balance_date, opening_balance, total_debit, total_credit, closing_balance, updated_at)
    SELECT p_org_id,
           balance_date,
           closing_balance - total_debit + total_credit,
           total_debit,
           total_credit,
           closing_balance,
           NOW()
    FROM running
    ON CONFLICT (org_id, balance_date) DO UPDATE SET
        opening_balance = EXCLUDED.opening_balance,
        total_debit      = EXCLUDED.total_debit,
        total_credit     = EXCLUDED.total_credit,
        closing_balance  = EXCLUDED.closing_balance,
        updated_at       = NOW();
END;
$$;


CREATE OR REPLACE FUNCTION trg_transaction_entries_recalc_balances()
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

    PERFORM recalc_transaction_daily_balances(v_from, v_org_id);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transaction_entries_balance_trigger ON finances_transaction_entries;
CREATE TRIGGER transaction_entries_balance_trigger
AFTER INSERT OR UPDATE OF entry_date, from_account_id, to_account_id, amount OR DELETE ON finances_transaction_entries
FOR EACH ROW
EXECUTE FUNCTION trg_transaction_entries_recalc_balances();

-- Recomputes ledger_balances for a single account from the journal. Same
-- Debit-positive convention as before (New Balance = Debit - Credit), so every
-- existing consumer keeps working - but opening_balance is NOT added here any
-- more: it is a journal line of its own since Phase 1, and adding it again
-- would double-count it. Deletes the row on a zero balance (a missing row
-- already means 0). See
-- supabase/migrations/20260801070000_journal_seed_and_backfill.sql.
CREATE OR REPLACE FUNCTION recalc_ledger_balance(p_ledger_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_balance NUMERIC(14, 2);
    v_org_id  UUID;
BEGIN
    SELECT org_id INTO v_org_id FROM finances_ledgers WHERE id = p_ledger_id;
    IF v_org_id IS NULL THEN
        DELETE FROM finances_ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    SELECT COALESCE(SUM(debit) - SUM(credit), 0) INTO v_balance
      FROM finances_journal_lines WHERE account_id = p_ledger_id;

    IF v_balance = 0 THEN
        DELETE FROM finances_ledger_balances WHERE ledger_id = p_ledger_id;
        RETURN;
    END IF;

    INSERT INTO finances_ledger_balances (ledger_id, org_id, balance, updated_at)
    VALUES (p_ledger_id, v_org_id, v_balance, NOW())
    ON CONFLICT (ledger_id) DO UPDATE SET
        balance    = EXCLUDED.balance,
        org_id     = EXCLUDED.org_id,
        updated_at = NOW();
END;
$$;

-- Transaction writes reach ledger_balances through the journal projection (see the
-- Journal section above), so the old direct transaction -> ledger_balances trigger
-- is gone: keeping it would recompute the same number from the retired source
-- and race the journal-driven one.
DROP TRIGGER IF EXISTS cashbook_entries_ledger_balance_trigger ON finances_transaction_entries;
DROP FUNCTION IF EXISTS trg_cashbook_entries_recalc_ledger_balance();

-- Creating a ledger with an opening balance, or editing one later, rewrites the
-- org's opening journal entry - which in turn moves the balances.
CREATE OR REPLACE FUNCTION trg_ledgers_recalc_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM sync_opening_balance_journal(NEW.org_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ledgers_opening_balance_trigger ON finances_ledgers;
CREATE TRIGGER ledgers_opening_balance_trigger
AFTER INSERT OR UPDATE OF opening_balance ON finances_ledgers
FOR EACH ROW
EXECUTE FUNCTION trg_ledgers_recalc_balance();

-- Row-level triggers never fire on TRUNCATE; cover that path explicitly so a
-- "truncate table" from the SQL editor can't leave balances stale either.
CREATE OR REPLACE FUNCTION trg_transaction_entries_truncate_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    TRUNCATE finances_transaction_daily_balances;
    TRUNCATE finances_ledger_balances;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS transaction_entries_truncate_trigger ON finances_transaction_entries;
CREATE TRIGGER transaction_entries_truncate_trigger
AFTER TRUNCATE ON finances_transaction_entries
FOR EACH STATEMENT
EXECUTE FUNCTION trg_transaction_entries_truncate_balances();

CREATE OR REPLACE FUNCTION trg_transaction_entries_audit_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO finances_transaction_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number, deleted_at)
    VALUES
        (OLD.org_id, OLD.id, OLD.entry_date, OLD.amount, OLD.description,
         OLD.from_account_id, OLD.to_account_id, OLD.order_number, NOW());
    RETURN OLD;
END;
$$;


DROP TRIGGER IF EXISTS transaction_entries_audit_delete_trigger ON finances_transaction_entries;
CREATE TRIGGER transaction_entries_audit_delete_trigger
AFTER DELETE ON finances_transaction_entries
FOR EACH ROW
EXECUTE FUNCTION trg_transaction_entries_audit_delete();

CREATE OR REPLACE FUNCTION trg_transaction_entries_audit_before_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO finances_transaction_entry_audit_log
        (org_id, entry_id, entry_date, amount, description,
         from_account_id, to_account_id, order_number)
    SELECT org_id, id, entry_date, amount, description,
           from_account_id, to_account_id, order_number
    FROM finances_transaction_entries;
    RETURN NULL;
END;
$$;


DROP TRIGGER IF EXISTS transaction_entries_audit_before_truncate_trigger ON finances_transaction_entries;
CREATE TRIGGER transaction_entries_audit_before_truncate_trigger
BEFORE TRUNCATE ON finances_transaction_entries
FOR EACH STATEMENT
EXECUTE FUNCTION trg_transaction_entries_audit_before_truncate();


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

-- Postgres identifies functions by name + argument types, so re-running this
-- file against a database with the pre-org-scoping signatures would otherwise
-- leave those old overloads (0/4/2 args) in place alongside the new ones.
DROP FUNCTION IF EXISTS get_month_summary_periods();
DROP FUNCTION IF EXISTS get_month_summary_totals(TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE);
DROP FUNCTION IF EXISTS get_month_summary_carrier_health(TIMESTAMPTZ, TIMESTAMPTZ);
-- Same-signature return-type change (cancelled_orders_count column added) -
-- CREATE OR REPLACE can't alter OUT-parameter row types, so drop first.
DROP FUNCTION IF EXISTS get_month_summary_totals(TIMESTAMPTZ, TIMESTAMPTZ, DATE, DATE, UUID);
-- Same-signature return-type change (warning_orders_count column added) -
-- CREATE OR REPLACE can't alter OUT-parameter row types, so drop first.
DROP FUNCTION IF EXISTS get_month_summary_periods(UUID);

-- warning_orders_count mirrors the Orders grid's final_status column
-- (orders-columns.js): cancelled orders are excluded entirely, an order is
-- "OK" only if delivered with delivery_charge > 0, or returned with
-- delivery_charge > 0 and piece_received = 'Received'; everything else
-- (non-cancelled) counts as Warning.
CREATE OR REPLACE FUNCTION get_month_summary_periods(p_org_id UUID)
RETURNS TABLE(month INT, year INT, warning_orders_count INT)
LANGUAGE sql
STABLE
AS $$
    WITH local_dates AS (
        SELECT
            EXTRACT(DAY FROM local_ts)::INT   AS day,
            EXTRACT(MONTH FROM local_ts)::INT AS mon,
            EXTRACT(YEAR FROM local_ts)::INT  AS yr,
            order_status,
            delivery_charge,
            piece_received
        FROM (
            SELECT order_receiving_date AT TIME ZONE INTERVAL '+05:00' AS local_ts,
                   order_status, delivery_charge, piece_received
            FROM shopify_orders
            WHERE org_id = p_org_id
        ) t
    ),
    bucketed AS (
        SELECT
            CASE WHEN day < 22 THEN (CASE WHEN mon = 1 THEN 12 ELSE mon - 1 END) ELSE mon END AS month,
            CASE WHEN day < 22 AND mon = 1 THEN yr - 1 ELSE yr END AS year,
            order_status,
            delivery_charge,
            piece_received
        FROM local_dates
    )
    SELECT
        month,
        year,
        COUNT(*) FILTER (
            WHERE lower(trim(order_status)) <> 'cancelled'
              AND NOT (
                    (lower(trim(order_status)) = 'delivered' AND delivery_charge > 0)
                 OR (lower(trim(order_status)) = 'returned' AND delivery_charge > 0 AND piece_received = 'Received')
              )
        )::INT AS warning_orders_count
    FROM bucketed
    GROUP BY month, year
    ORDER BY year DESC, month DESC;
$$;

CREATE OR REPLACE FUNCTION get_month_summary_totals(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_entry_start DATE,
    p_entry_end DATE,
    p_org_id UUID
)
RETURNS TABLE(
    total_orders INT,
    total_gross_sale NUMERIC,
    total_return_amount NUMERIC,
    return_orders_count INT,
    delivered_orders_count INT,
    enroute_orders_count INT,
    unfulfilled_orders_count INT,
    cancelled_orders_count INT,
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
        FROM shopify_orders
        WHERE org_id = p_org_id
          AND order_receiving_date >= p_period_start
          AND order_receiving_date <  p_period_end
    ),
    order_totals AS (
        SELECT
            COUNT(*) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled')::INT AS total_orders,
            COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(lower(trim(order_status)), '') <> 'cancelled'), 0) AS total_gross_sale,
            COALESCE(SUM(total_amount) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS total_return_amount,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'returned')::INT AS return_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) IN ('fulfilled', 'cna', 'rfd', 'ica'))::INT AS enroute_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'unfulfilled')::INT AS unfulfilled_orders_count,
            COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'cancelled')::INT AS cancelled_orders_count,
            COALESCE(SUM(
                CASE
                    WHEN lower(trim(order_status)) = 'returned' AND delivery_charge IS NOT NULL AND delivery_charge <> 0
                        THEN -delivery_charge
                    WHEN lower(trim(order_status)) = 'delivered' AND delivery_charge IS NOT NULL AND delivery_charge <> 0
                        THEN total_amount - (delivery_charge + COALESCE(tax_amount, 0) + COALESCE(cost_price, 0))
                    ELSE 0
                END
            ), 0) AS net_profit,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'delivered'), 0) AS dc_charges_delivered,
            COALESCE(SUM(delivery_charge) FILTER (WHERE lower(trim(order_status)) = 'returned'), 0) AS dc_charges_returned
        FROM period_orders
    ),
    ledger_totals AS (
        SELECT
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'shopify'), 0) AS shopify_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'ad'), 0)      AS ad_expense,
            COALESCE(SUM(ce.amount) FILTER (WHERE l.report_category = 'other'), 0)   AS other_expense
        FROM finances_ledgers l
        JOIN finances_transaction_entries ce ON ce.to_account_id = l.id
        WHERE l.org_id = p_org_id AND ce.org_id = p_org_id
          AND ce.entry_date >= p_entry_start AND ce.entry_date <= p_entry_end
    )
    SELECT
        ot.total_orders,
        ot.total_gross_sale,
        ot.total_return_amount,
        ot.return_orders_count,
        ot.delivered_orders_count,
        ot.enroute_orders_count,
        ot.unfulfilled_orders_count,
        ot.cancelled_orders_count,
        (ot.total_gross_sale - ot.total_return_amount) AS net_sales,
        ot.net_profit,
        ot.dc_charges_delivered,
        ot.dc_charges_returned,
        (ot.dc_charges_delivered + ot.dc_charges_returned) AS dc_charges_total,
        lt.shopify_expense,
        lt.ad_expense,
        lt.other_expense
    FROM order_totals ot, ledger_totals lt;
$$;



-- Per-carrier delivered/total parcel counts for the Month Summary "Carrier health"
-- display. Same period filter as get_month_summary_totals (cancelled orders
-- excluded); additionally excludes orders with no courier assigned yet
-- (unfulfilled orders never reached a carrier, so they'd only dilute the ratio).
CREATE OR REPLACE FUNCTION get_month_summary_carrier_health(
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_org_id UUID
)
RETURNS TABLE(
    courier TEXT,
    delivered_count INT,
    total_count INT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        courier,
        COUNT(*) FILTER (WHERE lower(trim(order_status)) = 'delivered')::INT AS delivered_count,
        COUNT(*)::INT AS total_count
    FROM shopify_orders
    WHERE org_id = p_org_id
      AND order_receiving_date >= p_period_start
      AND order_receiving_date <  p_period_end
      AND COALESCE(lower(trim(order_status)), '') <> 'cancelled'
      AND courier IS NOT NULL
      AND trim(courier) <> ''
    GROUP BY courier
    ORDER BY total_count DESC, courier ASC;
$$;


-- ============================================================================
-- Purchase bills (accounts payable) — FINANCE_ACCOUNTING_PLAN.md Phase 2
-- ----------------------------------------------------------------------------
-- A supplier is a LEDGER, not a row in a separate `contacts` table. Since the
-- Phase 1 journal exists, a supplier account already carries a real balance, so
-- the Liability-nature party ledgers collectively ARE accounts payable - there
-- is no control account and no control-vs-subsidiary reconciliation, and the
-- supplier statement is simply that ledger's statement.
--
-- Must stay after the Journal section: the seeding block calls
-- ensure_system_ledger and receive_bill calls post_journal_entry.
-- ============================================================================

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
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS is_party           BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS phone              VARCHAR(50);
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS email              VARCHAR(255);
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS address            TEXT;
ALTER TABLE finances_ledgers ADD COLUMN IF NOT EXISTS tax_number         VARCHAR(50);

-- Any ledger that already has bills posted against it is a party by definition.
-- (No-op on first run - bills doesn't exist yet - but keeps a re-run honest.)

-- ---------------------------------------------------------------------------
-- bills
-- ---------------------------------------------------------------------------
-- Stored status is only draft/received/cancelled. Paid / partially paid is
-- DERIVED from the supplier's ledger balance, applied to their bills
-- oldest-first (see the bills_with_paid view below). Payments are ordinary
-- transaction entries against the supplier and are never allocated to a bill, so
-- there is no stored payment status to drift out of step with reality.
CREATE TABLE IF NOT EXISTS finances_bills (
    id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES system_organizations(id),
    -- Our own sequence (BILL-0001). supplier_ref is the number printed on the
    -- supplier's document, which is theirs to choose and is not unique to us.
    bill_number   VARCHAR(30) NOT NULL,
    supplier_ref  VARCHAR(100),
    supplier_id   UUID NOT NULL REFERENCES finances_ledgers(id) ON DELETE RESTRICT,
    bill_date     DATE NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                  CONSTRAINT bills_status_check CHECK (status IN ('draft', 'received', 'cancelled')),
    subtotal      DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    -- Flat trade discount off the goods, netted straight out of the Inventory
    -- debit in receive_bill rather than posted to its own account.
    discount_amount DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
    tax_amount    DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0),
    -- Flat cost that came with the purchase but isn't stock or tax - transport,
    -- loading, courier. Folded into total the same way tax_amount is.
    other_expense_amount DECIMAL(14, 2) NOT NULL DEFAULT 0.00 CHECK (other_expense_amount >= 0),
    total         DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    notes         TEXT,
    -- Whether this bill's lines have been added to variant stock. Guards the
    -- receive/unreceive transition so stock can't be applied twice or reversed
    -- for a bill that never applied it.
    stock_applied BOOLEAN NOT NULL DEFAULT FALSE,
    created_by    UUID REFERENCES system_users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bills_org_id_bill_number_key UNIQUE (org_id, bill_number)
);

CREATE INDEX IF NOT EXISTS idx_bills_org_supplier ON finances_bills (org_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_bills_org_status   ON finances_bills (org_id, status);

-- ---------------------------------------------------------------------------
-- bill_items
-- ---------------------------------------------------------------------------
-- No per-line account: every line is stock, and receive_bill debits the org's
-- Inventory account for the whole subtotal. A purchase bill here is always for
-- goods - anything paid for on the spot (ads, rent, packaging) is a transaction
-- entry against its expense ledger, which is fewer steps and already works.
-- Bills exist to record what is OWED, not to categorise spending.
CREATE TABLE IF NOT EXISTS finances_bill_items (
    id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      UUID NOT NULL REFERENCES system_organizations(id),
    bill_id     UUID NOT NULL REFERENCES finances_bills(id) ON DELETE CASCADE,
    -- Soft links, matching shopify_orders.line_items' convention: a product can be
    -- deleted without destroying the purchase history that mentions it.
    product_id  UUID,
    variant_id  UUID,
    description TEXT,
    quantity    NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
    unit_cost   DECIMAL(14, 2) NOT NULL CHECK (unit_cost >= 0),
    amount      DECIMAL(14, 2) NOT NULL CHECK (amount >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Removes the column from a database created before the account was dropped:
-- CREATE TABLE IF NOT EXISTS above only runs on a fresh install.
-- See supabase/migrations/20260801110000_bills_drop_line_account.sql.
ALTER TABLE finances_bill_items DROP COLUMN IF EXISTS account_id;

CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id ON finances_bill_items (bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_org_id  ON finances_bill_items (org_id);
CREATE INDEX IF NOT EXISTS idx_bill_items_variant ON finances_bill_items (variant_id) WHERE variant_id IS NOT NULL;

-- Phase 2, part 2: bill numbering, totals, posting, stock, and AP ageing.

-- Inventory and Tax on Purchases (what bills post to) are seeded with every org
-- alongside the other system ledgers, above. Deliberately NOT accounts_payable:
-- the supplier's own ledger is credited, so the party ledgers collectively are
-- accounts payable.

-- Next BILL-nnnn for an org. Races are possible under concurrent creates; the
-- UNIQUE (org_id, bill_number) constraint is what actually guarantees
-- uniqueness, and this only has to be right in the ordinary single-user case.
CREATE OR REPLACE FUNCTION next_bill_number(p_org_id UUID)
RETURNS VARCHAR
LANGUAGE sql
STABLE
AS $$
    SELECT 'BILL-' || LPAD(
        (COALESCE(MAX(SUBSTRING(bill_number FROM 6)::INT), 0) + 1)::TEXT, 4, '0')
      FROM finances_bills
     WHERE org_id = p_org_id AND bill_number ~ '^BILL-[0-9]+$';
$$;

-- Totals are derived from the lines, never trusted from the client.
CREATE OR REPLACE FUNCTION recalc_bill_totals(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_subtotal NUMERIC(14, 2);
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_subtotal
      FROM finances_bill_items WHERE bill_id = p_bill_id;

    UPDATE finances_bills
       SET subtotal   = v_subtotal,
           total      = v_subtotal - discount_amount + tax_amount + other_expense_amount,
           updated_at = NOW()
     WHERE id = p_bill_id;
END;
$$;

-- Adds (p_sign = 1) or removes (p_sign = -1) this bill's stock.
--
-- Caveat worth knowing: receiving updates shopify_products.cost_price to the purchase
-- cost, but un-receiving does NOT restore the previous cost - the old value was
-- never recorded anywhere. Past orders are unaffected either way, since
-- shopify_orders.cost_price is snapshotted at order time.
CREATE OR REPLACE FUNCTION apply_bill_stock(p_bill_id UUID, p_sign INT)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- variants.quantity is INTEGER while a bill line can be fractional (fabric
    -- by the metre), so the movement is rounded to whole units.
    UPDATE shopify_variants v
       SET quantity   = v.quantity + (p_sign * ROUND(agg.qty))::INT,
           updated_at = NOW()
      FROM (
          SELECT variant_id, SUM(quantity) AS qty
            FROM finances_bill_items
           WHERE bill_id = p_bill_id AND variant_id IS NOT NULL
           GROUP BY variant_id
      ) agg
     WHERE v.id = agg.variant_id;

    IF p_sign > 0 THEN
        UPDATE shopify_products p
           SET cost_price = agg.unit_cost,
               updated_at = NOW()
          FROM (
              SELECT DISTINCT ON (product_id) product_id, unit_cost
                FROM finances_bill_items
               WHERE bill_id = p_bill_id AND product_id IS NOT NULL
               ORDER BY product_id, created_at DESC
          ) agg
         WHERE p.id = agg.product_id;
    END IF;
END;
$$;

-- Receive a bill: post it to the journal, add its stock, mark it received.
-- Idempotent - receiving an already-received bill is a no-op rather than a
-- second posting.
CREATE OR REPLACE FUNCTION receive_bill(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b               RECORD;
    v_inventory     UUID;
    v_tax_account   UUID;
    v_other_account UUID;
    v_lines         JSONB;
BEGIN
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % not found', p_bill_id;
    END IF;
    IF b.status = 'received' THEN
        RETURN;
    END IF;
    IF b.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cannot receive a cancelled bill';
    END IF;

    PERFORM recalc_bill_totals(p_bill_id);
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;

    IF b.total <= 0 THEN
        RAISE EXCEPTION 'Bill % has nothing to post - add at least one line', b.bill_number;
    END IF;

    -- Every line is stock, so the whole subtotal (net of any discount) is one
    -- Inventory debit - a trade discount lowers the recorded cost of the goods.
    v_inventory := ensure_system_ledger(b.org_id, 'inventory', 'Inventory', 'Asset', '1400');
    v_lines := jsonb_build_array(jsonb_build_object(
        'account_id', v_inventory,
        'debit',      b.subtotal - b.discount_amount,
        'credit',     0,
        'description', 'Bill ' || b.bill_number));

    IF b.tax_amount > 0 THEN
        v_tax_account := ensure_system_ledger(
            b.org_id, 'tax_on_purchases', 'Tax on Purchases', 'Expense', '5900');
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', v_tax_account,
            'debit',      b.tax_amount,
            'credit',     0,
            'description', 'Tax on bill ' || b.bill_number));
    END IF;

    IF b.other_expense_amount > 0 THEN
        v_other_account := ensure_system_ledger(
            b.org_id, 'other_expenses', 'Other Expenses', 'Expense', '5910');
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
            'account_id', v_other_account,
            'debit',      b.other_expense_amount,
            'credit',     0,
            'description', 'Other expense on bill ' || b.bill_number));
    END IF;

    -- The supplier's own ledger is the credit side - there is no separate
    -- Accounts Payable control account (FINANCE_ACCOUNTING_PLAN.md Phase 2).
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_id', b.supplier_id,
        'debit',      0,
        'credit',     b.total,
        'description', 'Bill ' || b.bill_number));

    -- Defensive: post_journal_entry does not replace an existing entry for the
    -- same source, and idx_journal_entries_source would reject a duplicate.
    DELETE FROM finances_journal_entries
     WHERE org_id = b.org_id AND source_type = 'bill' AND source_id = p_bill_id;

    PERFORM post_journal_entry(
        b.org_id,
        b.bill_date,
        v_lines,
        'Bill ' || b.bill_number || COALESCE(' (' || b.supplier_ref || ')', ''),
        'bill',
        b.created_by,
        'bill',
        b.id);

    IF NOT b.stock_applied THEN
        PERFORM apply_bill_stock(p_bill_id, 1);
        UPDATE finances_bills SET stock_applied = TRUE WHERE id = p_bill_id;
    END IF;

    UPDATE finances_bills SET status = 'received', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

-- Reopening only has to undo what receiving did. With settlement derived FIFO
-- from the supplier's ledger there is no allocation that could be left
-- dangling: removing the bill's credit moves the balance, and the report
-- follows.
CREATE OR REPLACE FUNCTION unreceive_bill(p_bill_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    b RECORD;
BEGIN
    SELECT * INTO b FROM finances_bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bill % not found', p_bill_id;
    END IF;
    IF b.status <> 'received' THEN
        RETURN;
    END IF;

    DELETE FROM finances_journal_entries
     WHERE org_id = b.org_id AND source_type = 'bill' AND source_id = p_bill_id;

    IF b.stock_applied THEN
        PERFORM apply_bill_stock(p_bill_id, -1);
        UPDATE finances_bills SET stock_applied = FALSE WHERE id = p_bill_id;
    END IF;

    UPDATE finances_bills SET status = 'draft', updated_at = NOW() WHERE id = p_bill_id;
END;
$$;

-- Bills with settlement derived FIFO from the supplier's ledger balance.
--
-- `settled` is every debit on the supplier's account. On a party ledger those
-- are payments. (An opening balance entered on the debit side would also count
-- here - enter a supplier's opening balance as a credit, which is the normal
-- direction for money owed.)
--
-- `prior` is the total of that supplier's earlier received bills, so each bill
-- is settled only once everything before it has been.
CREATE OR REPLACE VIEW finances_bills_with_paid AS
WITH settled AS (
    SELECT account_id AS supplier_id,
           COALESCE(SUM(debit), 0) AS amount
      FROM finances_journal_lines
     GROUP BY account_id
),
received AS (
    SELECT b.id,
           b.supplier_id,
           b.total,
           COALESCE(SUM(b.total) OVER (
               PARTITION BY b.supplier_id
               ORDER BY b.bill_date, b.bill_number
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0) AS prior
      FROM finances_bills b
     WHERE b.status = 'received'
),
allocated AS (
    SELECT r.id,
           LEAST(r.total, GREATEST(COALESCE(s.amount, 0) - r.prior, 0)) AS paid
      FROM received r
      LEFT JOIN settled s ON s.supplier_id = r.supplier_id
)
SELECT b.*,
       COALESCE(a.paid, 0) AS paid_amount,
       -- A draft or cancelled bill is not a debt, so it has no outstanding.
       CASE WHEN b.status = 'received'
            THEN b.total - COALESCE(a.paid, 0)
            ELSE 0
       END AS outstanding,
       CASE
           WHEN b.status <> 'received'         THEN b.status
           WHEN COALESCE(a.paid, 0) >= b.total THEN 'paid'
           WHEN COALESCE(a.paid, 0) > 0        THEN 'partially_paid'
           ELSE 'unpaid'
       END AS payment_status
  FROM finances_bills b
  LEFT JOIN allocated a ON a.id = b.id;

-- Ageing now reads the view, so it inherits the same FIFO settlement. Bills
-- carry no due date, so buckets are days-since-bill-date rather than overdue.
CREATE OR REPLACE FUNCTION get_ap_ageing(p_org_id UUID, p_as_of DATE)
RETURNS TABLE(
    supplier_id   UUID,
    supplier_name VARCHAR,
    outstanding   NUMERIC,
    current       NUMERIC,
    d1_30         NUMERIC,
    d31_60        NUMERIC,
    d61_90        NUMERIC,
    d90_plus      NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    WITH open_bills AS (
        SELECT b.supplier_id,
               b.outstanding,
               p_as_of - b.bill_date AS days_since_bill
          FROM finances_bills_with_paid b
         WHERE b.org_id = p_org_id
           AND b.status = 'received'
           AND b.bill_date <= p_as_of
           AND b.outstanding > 0
    )
    SELECT l.id,
           l.name,
           SUM(ob.outstanding),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill <= 0), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill BETWEEN  1 AND 30), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill BETWEEN 31 AND 60), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill BETWEEN 61 AND 90), 0),
           COALESCE(SUM(ob.outstanding) FILTER (WHERE ob.days_since_bill > 90), 0)
      FROM open_bills ob
      JOIN finances_ledgers l ON l.id = ob.supplier_id
     GROUP BY l.id, l.name
     ORDER BY l.name;
$$;


-- ============================================================================
-- Journal backfill — MUST stay after recalc_ledger_balance is redefined above
-- ----------------------------------------------------------------------------
-- This file is documented as safe to re-run against an existing database, and
-- without these blocks that promise would be broken by the Phase 1 journal:
-- re-running would install the journal-reading recalc_ledger_balance against an
-- empty journal, and every balance would silently zero itself the next time
-- anything touched its ledger.
--
-- Position matters. plpgsql resolves calls at run time, so a backfill placed up
-- in the Journal section would execute while the OLD transaction-based
-- recalc_ledger_balance was still installed, and the recomputed balances would
-- then never be refreshed. It has to run after the redefinition, i.e. here.
--
-- All three blocks are idempotent, and the projection is deliberately
-- UNCONDITIONAL rather than skipping entries that already have a journal entry.
-- That guard was safe when the journal was introduced (there was nothing to
-- rebuild) but became wrong the moment *how* an entry projects changed: after
-- the two-sided rewrite, existing journal entries still held the old
-- everything-through-cash posting, and skipping them left the journal, the cash
-- balance and every ledger balance stale. Re-posting from scratch is the only
-- version that cannot drift.
-- ============================================================================

DO $$
DECLARE
    entry RECORD;
BEGIN
    FOR entry IN
        SELECT ce.id FROM finances_transaction_entries ce ORDER BY ce.entry_date, ce.created_at
    LOOP
        PERFORM project_transaction_entry_to_journal(entry.id);
    END LOOP;
END $$;

DO $$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT id FROM system_organizations LOOP
        PERFORM sync_opening_balance_journal(org.id);
        -- Cash totals are derived too: only entries with a cash side count
        -- towards them, so they have to be rebuilt alongside the journal.
        PERFORM recalc_transaction_daily_balances('1900-01-01'::DATE, org.id);
    END LOOP;
END $$;

DO $$
DECLARE
    l RECORD;
BEGIN
    FOR l IN SELECT id FROM finances_ledgers LOOP
        PERFORM recalc_ledger_balance(l.id);
    END LOOP;
END $$;


-- ============================================================================
-- Row Level Security (defense-in-depth only - see app/org_scope.py)
-- ----------------------------------------------------------------------------
-- Enabled with NO policies (default-deny for anon/authenticated). This is NOT
-- the load-bearing access control: the backend always connects with the
-- Supabase secret/service-role key (backend/app/database.py), which bypasses
-- RLS entirely. The actual per-org isolation is app.org_scope.org_table(),
-- enforced by tests/test_org_scope_lint.py. This only protects against a
-- future accidental use of the anon/publishable key reading these tables
-- directly. See supabase/migrations/20260730100000_rls_default_deny_business_tables.sql.
-- ============================================================================
ALTER TABLE shopify_products                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_variants                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_orders                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_load_sheet_logs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_ledgers                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_transaction_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_transaction_daily_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_ledger_balances         ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_transaction_entry_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_sync_status              ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_organizations             ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_users                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_org_memberships           ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_integration_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_journal_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_journal_lines           ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_bills                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE finances_bill_items              ENABLE ROW LEVEL SECURITY;

-- Supabase SQL Schema for Inventory Management System

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Products Table (one record per product)
CREATE TABLE IF NOT EXISTS products (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    -- Shopify-specific fields (for syncing)
    shopify_product_id BIGINT UNIQUE,
    -- Product information
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) DEFAULT 0.00,  -- Selling price (same across all variants)
    cost_price DECIMAL(10, 2),           -- Cost price (same across all variants)
    collection VARCHAR(255),              -- Collection name (e.g. from Shopify)
    image_url TEXT,
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Variants Table (one record per variant, linked to product)
CREATE TABLE IF NOT EXISTS variants (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    -- Foreign key to products table
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    -- Shopify-specific fields (for syncing)
    shopify_variant_id BIGINT UNIQUE,
    -- Variant information
    title VARCHAR(255) NOT NULL,  -- e.g., "S", "M", "L", "Red", "Blue"
    quantity INTEGER DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    order_number VARCHAR(20) NOT NULL UNIQUE,
    courier VARCHAR(100) NOT NULL,
    tracking_number VARCHAR(255),
    folio VARCHAR(255),
    order_status VARCHAR(50) NOT NULL,
    delivery_status JSONB,
    total_amount DECIMAL(10, 2) NOT NULL,
    advance_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    delivery_charge DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    cost_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    order_receiving_date TIMESTAMP WITH TIME ZONE,
    items TEXT[],
    piece_received TEXT NOT NULL DEFAULT 'Pending' CHECK (piece_received IN ('Pending', 'Done', 'Received')),
    replacement_of_order_no VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id ON products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_variants_product_id ON variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_shopify_variant_id ON variants(shopify_variant_id);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_order_status ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);
CREATE INDEX IF NOT EXISTS idx_orders_piece_received ON orders(piece_received);

-- Load Sheet Logs (assignment number, rider, order numbers, created_at)
CREATE TABLE IF NOT EXISTS load_sheet_logs (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    assignment_number VARCHAR(100) NOT NULL,
    rider_name VARCHAR(255) NOT NULL,
    order_numbers JSONB NOT NULL DEFAULT '[]',  -- array of order number strings (e.g. ["2721", "2722"])
    delivery_charge DECIMAL(10, 2),             -- delivery charges applied to all orders in this load sheet
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_load_sheet_logs_created_at ON load_sheet_logs(created_at DESC);

-- If load_sheet_logs already existed without delivery_charge, add the column:
-- ALTER TABLE load_sheet_logs ADD COLUMN IF NOT EXISTS delivery_charge DECIMAL(10, 2);

-- If RLS is enabled on the project, allow access to load_sheet_logs (run if you get 500 on GET /api/orders/load-sheet-logs):
-- ALTER TABLE load_sheet_logs ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Allow all load_sheet_logs" ON load_sheet_logs FOR ALL USING (true) WITH CHECK (true);

-- App unlock PIN (bcrypt hash only; see supabase_app_pin.sql)
CREATE TABLE IF NOT EXISTS app_pin (
    id TEXT PRIMARY KEY DEFAULT 'default',
    pin_hash TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

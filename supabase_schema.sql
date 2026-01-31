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
    order_number INTEGER NOT NULL UNIQUE,
    courier VARCHAR(100) NOT NULL,
    tracking_number VARCHAR(255),
    order_status VARCHAR(50) NOT NULL,
    delivery_status JSONB,
    total_amount DECIMAL(10, 2) NOT NULL,
    advance_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    delivery_charge DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    cost_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    order_receiving_date TIMESTAMP WITH TIME ZONE,
    items TEXT[],
    piece_with TEXT NOT NULL DEFAULT 'Warehouse' CHECK (piece_with IN ('Customer', 'Rider', 'Warehouse')),
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
CREATE INDEX IF NOT EXISTS idx_orders_piece_with ON orders(piece_with);

-- Supabase SQL Schema for Inventory Management System

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Products Table
CREATE TABLE IF NOT EXISTS products (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    -- Shopify-specific fields
    shopify_product_id BIGINT,
    shopify_variant_id BIGINT,
    handle VARCHAR(255),
    vendor VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active',
    tags TEXT,
    image_url TEXT,
    barcode VARCHAR(100),
    weight DECIMAL(10, 2),
    weight_unit VARCHAR(10) DEFAULT 'kg',
    -- Product information
    name VARCHAR(255) NOT NULL,
    description TEXT,
    sku VARCHAR(100),
    quantity INTEGER DEFAULT 0,
    price DECIMAL(10, 2) DEFAULT 0.00,
    compare_at_price DECIMAL(10, 2),
    cost_price DECIMAL(10, 2),
    category VARCHAR(100),
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    shopify_created_at TIMESTAMP WITH TIME ZONE,
    shopify_updated_at TIMESTAMP WITH TIME ZONE,
    -- Constraints
    CONSTRAINT unique_shopify_product_variant UNIQUE (shopify_product_id, shopify_variant_id)
);

-- Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    order_number INTEGER NOT NULL UNIQUE,
    courier VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    advance_amount DECIMAL(10, 2),
    delivery_charge DECIMAL(10, 2),
    tax_amount DECIMAL(10, 2),
    cost_price DECIMAL(10, 2),
    folio VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id ON products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_products_shopify_variant_id ON products(shopify_variant_id);
CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

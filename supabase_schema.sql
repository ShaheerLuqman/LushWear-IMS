-- Supabase SQL Schema for Inventory Management System

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Products Table
CREATE TABLE IF NOT EXISTS products (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    -- Shopify-specific fields (for syncing)
    shopify_product_id BIGINT,
    shopify_variant_id BIGINT,
    -- Product information (matching CSV format)
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) DEFAULT 0.00,
    cost_price DECIMAL(10, 2),
    quantity INTEGER DEFAULT 0,
    image_url TEXT,
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    -- Constraints
    CONSTRAINT unique_shopify_product_variant UNIQUE (shopify_product_id, shopify_variant_id)
);

-- Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    order_number INTEGER NOT NULL UNIQUE,
    courier VARCHAR(100) NOT NULL,
    order_status VARCHAR(50) NOT NULL,
    delivery_status VARCHAR(50),
    total_amount DECIMAL(10, 2) NOT NULL,
    advance_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    delivery_charge DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    cost_price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_shopify_product_id ON products(shopify_product_id);
CREATE INDEX IF NOT EXISTS idx_products_shopify_variant_id ON products(shopify_variant_id);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_order_status ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);

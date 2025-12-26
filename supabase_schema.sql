-- Supabase SQL Schema for Inventory Management System
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Products Table
CREATE TABLE IF NOT EXISTS products (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    sku VARCHAR(100) NOT NULL UNIQUE,
    quantity INTEGER DEFAULT 0,
    price DECIMAL(10, 2) DEFAULT 0.00,
    category VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Stock Movements Table
CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    quantity_change INTEGER NOT NULL,
    movement_type VARCHAR(10) NOT NULL CHECK (movement_type IN ('in', 'out')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Orders Table
CREATE TABLE IF NOT EXISTS orders (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    order_number INTEGER NOT NULL UNIQUE,
    courier VARCHAR(100) NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(50) NOT NULL,
    delivery_charge INTEGER,
    receivable INTEGER,
    folio VARCHAR(100),
    net INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Enable Row Level Security (optional - for production use)
-- ALTER TABLE products ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Sample data (optional)
INSERT INTO products (name, description, sku, quantity, price, category) VALUES
    ('Wireless Mouse', 'Ergonomic wireless mouse with USB receiver', 'WM-001', 50, 29.99, 'Electronics'),
    ('Mechanical Keyboard', 'RGB mechanical keyboard with Cherry MX switches', 'KB-001', 25, 129.99, 'Electronics'),
    ('USB-C Hub', '7-in-1 USB-C hub with HDMI and SD card reader', 'HUB-001', 100, 49.99, 'Accessories'),
    ('Monitor Stand', 'Adjustable monitor stand with cable management', 'MS-001', 15, 79.99, 'Furniture'),
    ('Webcam HD', '1080p HD webcam with built-in microphone', 'CAM-001', 5, 69.99, 'Electronics')
ON CONFLICT (sku) DO NOTHING;

-- Sample orders data
INSERT INTO orders 
    (order_number,  courier,    total_amount,   status, delivery_charge, receivable, folio, net) VALUES
    (2719,          '1289',     4247,           'DVD',      211, 3865, '15/10',     2515),
    (2720,          'RIDER',    7697,           'DVD',      247, 7450, 'PC#143',    3750),
    (2721,          '1287',     3248,           'DVD',      211, 2906, '15/10',     1356),
    (2722,          'RIDER',    8247,           'DVD',      247, 8000, 'PC#143',    3950),
    (2724,          '1293',     3247,           'RETURNED', -211, 0, '22/10',       DEC RECD),
    (2725,          '1292',     5996,           'DVD',      211, 5544, '15/10',     2094),
    (2726,          'RIDER',    6298,           'DVD',      248, 6050, 'PC#143',    2950),
    (2727,          '1291',     2998,           'DVD',      -159, 2839, 'PC#144 / 08/10', 1489),
    (2728,          '1285',     2998,           'DVD',      159, 2719, '10-Aug',    1369),
    (2729,          '1284',     5998,           'DVD',      211, 5546, '15/10',     2446),
    (2730,          '1283',     5148,           'RETURNED', -211, 0, '22/10',       PIECE RCVD)
ON CONFLICT (order_number) DO NOTHING;


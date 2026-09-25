-- Barcode scans resolve orders by tracking number (GET /orders/resolve-scan).
CREATE INDEX IF NOT EXISTS idx_orders_tracking_number ON shopify_orders(org_id, tracking_number);

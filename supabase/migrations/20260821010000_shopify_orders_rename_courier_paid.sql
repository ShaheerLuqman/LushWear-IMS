-- courier_paid -> is_order_settled: clearer name for the same flag (whether the courier
-- has paid out an order's receivable). See 20260821000000_shopify_orders_courier_paid.sql.

ALTER TABLE shopify_orders RENAME COLUMN courier_paid TO is_order_settled;

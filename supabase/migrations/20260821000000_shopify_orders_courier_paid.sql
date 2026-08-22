-- Whether the courier has actually paid out an order's receivable (see the "Owed by
-- Courier" figure on the Courier Resolution page). Set via POST
-- /orders/bulk-update-courier-paid (bulk-enter order numbers); independent of
-- advance_status, which tracks the customer's advance, not the courier's payout.

ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS courier_paid
    BOOLEAN NOT NULL DEFAULT false;

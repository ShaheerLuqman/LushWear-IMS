-- AP ageing (and AR ageing, which was never built) is not wanted as a report -
-- product decision. Drops the RPC backing GET /bills/ap-ageing, which the route
-- and the Outstanding Payables page are also removed alongside this migration.
-- finances_bills_with_paid (the FIFO settlement view it read) stays: bill
-- payment status still depends on it.
DROP FUNCTION IF EXISTS get_ap_ageing(UUID, DATE);

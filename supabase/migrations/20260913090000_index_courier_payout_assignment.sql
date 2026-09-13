-- assign_courier_payouts scans every settled order in the org on every upload
-- (WHERE org_id = ... AND is_order_settled AND folio <> '' AND ... GROUP BY
-- normalize_folio(folio), folio_payout_date(folio)) with no supporting index -
-- shopify_orders only has one on org_id alone. A 202-row CPR upload timed out
-- (57014) trying to post its payout: the whole function is a sequential scan
-- over the org's entire order history, not just this upload's rows. Same class
-- of problem 20260913030000_cogs_trigger_statement_level.sql already fixed
-- once for a different function.
--
-- Partial rather than a full expression index on normalize_folio()/
-- folio_payout_date(): the real selectivity win is filtering out the vast
-- majority of orders that are either unsettled or have no folio at all: once
-- narrowed to that subset, grouping the remainder by two cheap IMMUTABLE
-- function calls is fast.
CREATE INDEX IF NOT EXISTS idx_shopify_orders_settled_folio
    ON shopify_orders (org_id)
    WHERE is_order_settled AND folio IS NOT NULL AND folio <> '';

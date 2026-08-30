-- The PostEx tracking API reports the shipping fee it charged but never the withholding
-- tax deducted at payout, so the "Fetch PostEx Settlements" action derives tax_amount as
-- 2% income + 2% sales of the COD amount. Flagging those rows keeps them distinguishable
-- from the authoritative CPR CSV figures, so a later upload can correct them and a rate
-- change can be traced to exactly the orders it affected.
ALTER TABLE shopify_orders
    ADD COLUMN IF NOT EXISTS tax_amount_derived BOOLEAN NOT NULL DEFAULT false;

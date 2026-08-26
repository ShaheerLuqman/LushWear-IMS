-- CouriersNext's own auth_key (see app/org_settings.py) - encrypted at rest the same way
-- as postex_merchant_token/shopify_access_token, since it's a third-party secret. Needed
-- to fetch CouriersNext's supported-city list for the Order Fulfillment view's per-courier
-- city dropdown (see app/services/courier_cities.py).

ALTER TABLE system_integration_settings ADD COLUMN IF NOT EXISTS couriers_next_auth_key TEXT;

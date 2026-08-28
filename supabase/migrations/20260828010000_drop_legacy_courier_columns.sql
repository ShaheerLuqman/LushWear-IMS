-- Drops the per-courier credential columns superseded by the encrypted `couriers`
-- blob (20260828000000_integration_settings_couriers_json.sql). The app stopped
-- reading these entirely once the blob-only read path landed - app/org_settings.py's
-- _decode_couriers has no fallback branch - so this only removes columns nothing
-- queries any more.
--
-- Irreversible for the data: these values are Fernet ciphertext under
-- SETTINGS_ENCRYPTION_KEY, so a DROP cannot be undone by re-adding the column.
-- Every environment must have run scripts/backfill_courier_settings.py first;
-- an un-backfilled org silently loses its courier credentials here and has to
-- re-enter them in Settings > Integrations.
--
-- Verify before applying (expects zero rows):
--   SELECT org_id FROM system_integration_settings
--   WHERE couriers IS NULL
--     AND (postex_merchant_token IS NOT NULL OR couriers_next_auth_key IS NOT NULL);

ALTER TABLE system_integration_settings DROP COLUMN IF EXISTS postex_merchant_token;
ALTER TABLE system_integration_settings DROP COLUMN IF EXISTS couriers_next_auth_key;

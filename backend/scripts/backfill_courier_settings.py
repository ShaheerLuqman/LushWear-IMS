"""One-off: folds the pre-blob courier columns (postex_merchant_token,
couriers_next_auth_key) into the single encrypted `couriers` blob added by
20260828000000_integration_settings_couriers_json.sql.

Must run in the app rather than in SQL: the old values are Fernet-encrypted with
SETTINGS_ENCRYPTION_KEY, so migrating them means decrypting and re-encrypting
through app/org_settings.py. Safe to re-run - rows that already have a blob are skipped. The app no longer reads
the old columns at all, so an un-backfilled row reads as nothing configured until
this has run.

Obsolete once 20260828010000_drop_legacy_courier_columns.sql has been applied - the
columns it reads no longer exist, and every org is on the blob by then. Kept only for
an environment still mid-migration; delete it once they all are.

Usage (from backend/): venv/Scripts/python.exe -m scripts.backfill_courier_settings
"""
from app.database import get_supabase
from app.org_settings import _decrypt, upsert_org_integration_settings

# The pre-blob column each courier's credential used to live in. Kept here rather
# than in app/org_settings.py because this script is now the only thing that reads
# them - the app itself no longer falls back to these columns.
_LEGACY_COLUMNS = {
    "postex_merchant_token": "postex_merchant_token",
    "couriers_next_auth_key": "couriers_next_auth_key",
}


def main() -> None:
    rows = get_supabase().table("system_integration_settings").select("*").execute().data or []
    migrated = 0
    for row in rows:
        if row.get("couriers"):
            continue
        legacy = {
            kwarg: _decrypt(row.get(column))
            for kwarg, column in _LEGACY_COLUMNS.items()
            if _decrypt(row.get(column))
        }
        if not legacy:
            continue
        upsert_org_integration_settings(row["org_id"], **legacy)
        migrated += 1
        print(f"Migrated org {row['org_id']}: {sorted(legacy)}")
    print(f"Done. {migrated} of {len(rows)} rows migrated.")


if __name__ == "__main__":
    main()

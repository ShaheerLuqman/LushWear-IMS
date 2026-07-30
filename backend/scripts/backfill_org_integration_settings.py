"""One-time backfill (ORGANIZATIONS_USERS_PLAN.md Phase 2): copies today's
global SHOPIFY_*/POSTEX_MERCHANT_TOKEN env vars into org_integration_settings
for the single existing organization, so LushWear's Shopify/PostEx sync keeps
working once app/shopify.py etc. stop reading those env vars directly.

Run once, after:
  1. Applying 20260730110000_org_integration_settings_table.sql (and the rest
     of Phase 2's migrations), and
  2. At least one organization exists (Phase 1's bootstrap, or the org_id
     migration's own LushWear-row creation).

Requires SETTINGS_ENCRYPTION_KEY to be set, same as the running app.

Usage (from backend/): venv/Scripts/python.exe -m scripts.backfill_org_integration_settings
"""
from app.config import settings
from app.database import get_supabase
from app.org_settings import upsert_org_integration_settings


def main() -> None:
    supabase = get_supabase()
    orgs = supabase.table("organizations").select("id, name").order("created_at").execute().data or []
    if not orgs:
        raise SystemExit("No organizations exist yet - run bootstrap or the org_id migration first.")
    if len(orgs) > 1:
        raise SystemExit(
            f"Expected exactly one organization for this one-time backfill, found {len(orgs)}: "
            f"{[o['name'] for o in orgs]}. Use app.org_settings.upsert_org_integration_settings() "
            "directly (or the future admin UI) to configure each org instead."
        )
    org = orgs[0]

    store_url = settings.shopify_store_url
    access_token = settings.shopify_access_token
    api_version = settings.SHOPIFY_API_VERSION
    postex_token = settings.POSTEX_MERCHANT_TOKEN

    if not store_url and not access_token and not postex_token:
        raise SystemExit(
            "None of SHOPIFY_STORE_URL/SHOPIFY_ADMIN_API_TOKEN/POSTEX_MERCHANT_TOKEN are set - nothing to backfill."
        )

    upsert_org_integration_settings(
        org["id"],
        shopify_store_url=store_url or None,
        shopify_access_token=access_token or None,
        shopify_api_version=api_version or None,
        postex_merchant_token=postex_token or None,
    )
    print(f"Backfilled integration settings for organization {org['name']!r} ({org['id']}).")


if __name__ == "__main__":
    main()

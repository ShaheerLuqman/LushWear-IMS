"""One-off: registers Shopify webhook subscriptions (shopify.WEBHOOK_TOPICS) for an org that
connected Shopify before webhooks existed. Every OAuth connect from here on registers them
itself (see routes/shopify_oauth.py's callback); this is the one-time catch-up for orgs
already connected, and is safe to re-run - shopify.register_webhooks no-ops (logging) on a
subscription that already exists at this callback URL.

Requires SHOPIFY_WEBHOOK_CALLBACK_URL to be set (same env var shopify.register_webhooks reads).

Usage (from backend/): venv/Scripts/python.exe -m scripts.register_shopify_webhooks <org_id>
"""
import asyncio
import sys

from app import shopify
from app.org_settings import ensure_valid_shopify_token, get_org_integration_settings


async def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.register_shopify_webhooks <org_id>")
    org_id = sys.argv[1]

    org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
    if not org_creds.shopify_store_url or not org_creds.shopify_access_token:
        raise SystemExit(f"Org {org_id} has no Shopify credentials configured.")

    await shopify.register_webhooks(org_creds)
    print(f"Registered webhook subscriptions for org {org_id} ({org_creds.shopify_store_url}).")


if __name__ == "__main__":
    asyncio.run(main())

"""Per-org Shopify/PostEx integration credentials (ORGANIZATIONS_USERS_PLAN.md
Phase 2). `get_org_integration_settings()` is the only place these are read -
`app/shopify.py`, `app/services/shopify_orders.py`, `app/services/shopify_sync.py`,
and the PostEx call sites in `app/routes/orders.py` all receive credentials as a
parameter instead of reading a global `settings.*` value, same chokepoint
principle as `app.org_scope` applies to business-table org_id filtering.

`shopify_access_token`/`postex_merchant_token` are encrypted at rest via
Fernet (SETTINGS_ENCRYPTION_KEY) - these are third-party secrets belonging to
external clients (a leaked Shopify token exposes a client's whole store), not
just this app's own credentials, so they get a higher bar than the app's own
password hashes.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from app.database import get_supabase

_DEFAULT_SHOPIFY_API_VERSION = "2024-07"

_runtime_key: Optional[bytes] = None


def _get_fernet() -> Fernet:
    """SETTINGS_ENCRYPTION_KEY must be a urlsafe-base64 32-byte key (Fernet.generate_key()).
    Unlike AUTH_SECRET, there is deliberately no dev-fallback random key here:
    a fallback that changes every restart would make already-stored encrypted
    credentials permanently undecryptable, not just re-signable like a JWT."""
    global _runtime_key
    if _runtime_key is None:
        configured = os.getenv("SETTINGS_ENCRYPTION_KEY")
        if not configured:
            raise RuntimeError(
                "SETTINGS_ENCRYPTION_KEY must be set to read or write org integration settings."
            )
        _runtime_key = configured.encode("utf-8")
    return Fernet(_runtime_key)


def _encrypt(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return _get_fernet().encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return _get_fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except InvalidToken:
        # Malformed/undecryptable stored value - treat as "not configured"
        # rather than 500ing every sync attempt for this org.
        return None


@dataclass
class OrgIntegrationSettings:
    shopify_store_url: Optional[str]
    shopify_access_token: Optional[str]
    shopify_api_version: str
    postex_merchant_token: Optional[str]


def get_org_integration_settings(org_id: str) -> OrgIntegrationSettings:
    rows = (
        get_supabase()
        .table("org_integration_settings")
        .select("*")
        .eq("org_id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    row = rows[0] if rows else {}
    return OrgIntegrationSettings(
        shopify_store_url=row.get("shopify_store_url"),
        shopify_access_token=_decrypt(row.get("shopify_access_token")),
        shopify_api_version=row.get("shopify_api_version") or _DEFAULT_SHOPIFY_API_VERSION,
        postex_merchant_token=_decrypt(row.get("postex_merchant_token")),
    )


def upsert_org_integration_settings(
    org_id: str,
    *,
    shopify_store_url: Optional[str] = None,
    shopify_access_token: Optional[str] = None,
    shopify_api_version: Optional[str] = None,
    postex_merchant_token: Optional[str] = None,
) -> None:
    """Admin-facing write path (Settings > Integrations UI, or a one-time
    backfill). Only touches the fields actually passed - an omitted field
    keeps whatever is already stored, so an admin can update just the PostEx
    token without re-entering the Shopify credentials."""
    payload = {"org_id": org_id, "updated_at": datetime.now(timezone.utc).isoformat()}
    if shopify_store_url is not None:
        payload["shopify_store_url"] = shopify_store_url
    if shopify_access_token is not None:
        payload["shopify_access_token"] = _encrypt(shopify_access_token)
    if shopify_api_version is not None:
        payload["shopify_api_version"] = shopify_api_version
    if postex_merchant_token is not None:
        payload["postex_merchant_token"] = _encrypt(postex_merchant_token)
    get_supabase().table("org_integration_settings").upsert(payload, on_conflict="org_id").execute()

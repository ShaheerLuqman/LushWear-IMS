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

Shopify's Admin API now rejects non-expiring offline tokens for Public apps
created on/after 2026-04-01 - `shopify_access_token` expires at
`shopify_token_expires_at` and must be refreshed via `shopify_refresh_token`
before then. Every call site that actually hits Shopify's API (not just
display routes) must call `ensure_valid_shopify_token()` on the credentials
it got from `get_org_integration_settings()` before using them.
"""

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from cryptography.fernet import Fernet, InvalidToken

from app.database import get_supabase
from app.models import OrgIntegrationSettingsPublic

logger = logging.getLogger("app.org_settings")

_DEFAULT_SHOPIFY_API_VERSION = "2024-07"
# Refresh a bit before actual expiry so a call in flight doesn't race the token dying.
_TOKEN_REFRESH_BUFFER = timedelta(minutes=5)

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
    shopify_refresh_token: Optional[str]
    shopify_token_expires_at: Optional[datetime]
    postex_merchant_token: Optional[str]
    couriers_next_auth_key: Optional[str]


def get_org_integration_settings(org_id: str) -> OrgIntegrationSettings:
    rows = (
        get_supabase()
        .table("system_integration_settings")
        .select("*")
        .eq("org_id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    row = rows[0] if rows else {}
    expires_at = row.get("shopify_token_expires_at")
    return OrgIntegrationSettings(
        shopify_store_url=row.get("shopify_store_url"),
        shopify_access_token=_decrypt(row.get("shopify_access_token")),
        shopify_api_version=row.get("shopify_api_version") or _DEFAULT_SHOPIFY_API_VERSION,
        shopify_refresh_token=_decrypt(row.get("shopify_refresh_token")),
        shopify_token_expires_at=datetime.fromisoformat(expires_at) if expires_at else None,
        postex_merchant_token=_decrypt(row.get("postex_merchant_token")),
        couriers_next_auth_key=_decrypt(row.get("couriers_next_auth_key")),
    )


async def ensure_valid_shopify_token(org_id: str, settings: OrgIntegrationSettings) -> OrgIntegrationSettings:
    """Call before using `settings` to actually hit Shopify's Admin API (not
    needed just to display configured/not-configured status). Refreshes and
    persists a new access_token when the current one is at/near expiry;
    otherwise returns `settings` unchanged - a no-op for orgs that connected
    before this migration (shopify_token_expires_at is None for them) until
    they reconnect through the OAuth flow."""
    expires_at = settings.shopify_token_expires_at
    if not expires_at or not settings.shopify_refresh_token:
        return settings
    if datetime.now(timezone.utc) < expires_at - _TOKEN_REFRESH_BUFFER:
        return settings

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"https://{settings.shopify_store_url}/admin/oauth/access_token",
                json={
                    "client_id": os.getenv("SHOPIFY_APP_CLIENT_ID"),
                    "client_secret": os.getenv("SHOPIFY_APP_CLIENT_SECRET"),
                    "grant_type": "refresh_token",
                    "refresh_token": settings.shopify_refresh_token,
                },
            )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.exception("Shopify token refresh failed for org %s - using existing token", org_id)
        return settings

    new_expires_at = datetime.now(timezone.utc) + timedelta(seconds=data["expires_in"])
    upsert_org_integration_settings(
        org_id,
        shopify_access_token=data["access_token"],
        shopify_refresh_token=data.get("refresh_token") or settings.shopify_refresh_token,
        shopify_token_expires_at=new_expires_at,
    )
    settings.shopify_access_token = data["access_token"]
    settings.shopify_refresh_token = data.get("refresh_token") or settings.shopify_refresh_token
    settings.shopify_token_expires_at = new_expires_at
    return settings


def to_public_shape(settings: OrgIntegrationSettings) -> OrgIntegrationSettingsPublic:
    """Shared response shape for both the self-service (`routes/org_settings.py`)
    and superadmin (`routes/admin_portal.py`) integration-settings routes -
    secrets are never echoed back, only whether each is configured."""
    return OrgIntegrationSettingsPublic(
        shopify_store_url=settings.shopify_store_url,
        shopify_api_version=settings.shopify_api_version,
        shopify_access_token_configured=bool(settings.shopify_access_token),
        postex_merchant_token_configured=bool(settings.postex_merchant_token),
        couriers_next_auth_key_configured=bool(settings.couriers_next_auth_key),
    )


def upsert_org_integration_settings(
    org_id: str,
    *,
    shopify_store_url: Optional[str] = None,
    shopify_access_token: Optional[str] = None,
    shopify_api_version: Optional[str] = None,
    shopify_refresh_token: Optional[str] = None,
    shopify_token_expires_at: Optional[datetime] = None,
    postex_merchant_token: Optional[str] = None,
    couriers_next_auth_key: Optional[str] = None,
) -> None:
    """Admin-facing write path (Settings > Integrations UI, or a one-time
    backfill) - also called by ensure_valid_shopify_token() after a refresh.
    Only touches the fields actually passed - an omitted field keeps whatever
    is already stored, so an admin can update just the PostEx token without
    re-entering the Shopify credentials."""
    payload = {"org_id": org_id, "updated_at": datetime.now(timezone.utc).isoformat()}
    if shopify_store_url is not None:
        payload["shopify_store_url"] = shopify_store_url
    if shopify_access_token is not None:
        payload["shopify_access_token"] = _encrypt(shopify_access_token)
        if shopify_refresh_token is None:
            # A new access_token with no accompanying refresh_token only ever
            # happens from manual entry (Settings > Integrations, or the
            # superadmin portal) - the OAuth callback and ensure_valid_shopify_token()
            # always pass both together. Clear any refresh_token/expiry left over
            # from a prior OAuth connect so this token is treated as fixed, not
            # silently overwritten by a refresh on borrowed OAuth state.
            payload["shopify_refresh_token"] = None
            payload["shopify_token_expires_at"] = None
    if shopify_api_version is not None:
        payload["shopify_api_version"] = shopify_api_version
    if shopify_refresh_token is not None:
        payload["shopify_refresh_token"] = _encrypt(shopify_refresh_token)
    if shopify_token_expires_at is not None:
        payload["shopify_token_expires_at"] = shopify_token_expires_at.isoformat()
    if postex_merchant_token is not None:
        payload["postex_merchant_token"] = _encrypt(postex_merchant_token)
    if couriers_next_auth_key is not None:
        payload["couriers_next_auth_key"] = _encrypt(couriers_next_auth_key)
    get_supabase().table("system_integration_settings").upsert(payload, on_conflict="org_id").execute()

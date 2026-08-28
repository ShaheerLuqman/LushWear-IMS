"""Per-org Shopify/PostEx integration credentials (ORGANIZATIONS_USERS_PLAN.md
Phase 2). `get_org_integration_settings()` is the only place these are read -
`app/shopify.py`, `app/services/shopify_orders.py`, `app/services/shopify_sync.py`,
and the PostEx call sites in `app/routes/orders.py` all receive credentials as a
parameter instead of reading a global `settings.*` value, same chokepoint
principle as `app.org_scope` applies to business-table org_id filtering.

`shopify_access_token` and the courier credentials are encrypted at rest via
Fernet (SETTINGS_ENCRYPTION_KEY) - these are third-party secrets belonging to
external clients (a leaked Shopify token exposes a client's whole store), not
just this app's own credentials, so they get a higher bar than the app's own
password hashes.

Courier credentials live in one `couriers` blob keyed by courier id rather than a
column per courier, so onboarding a courier needs no schema migration. The whole
JSON is encrypted as a single ciphertext, which means Postgres cannot filter on it -
`any_org_courier_credential()` exists for the one caller that needs to search
across orgs. Reads fall back to the pre-blob columns (see
20260828000000_integration_settings_couriers_json.sql) so an un-backfilled row
keeps working; writes only ever go to the blob.

Shopify's Admin API now rejects non-expiring offline tokens for Public apps
created on/after 2026-04-01 - `shopify_access_token` expires at
`shopify_token_expires_at` and must be refreshed via `shopify_refresh_token`
before then. Every call site that actually hits Shopify's API (not just
display routes) must call `ensure_valid_shopify_token()` on the credentials
it got from `get_org_integration_settings()` before using them.
"""

import json
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


# Courier id -> the credential key inside that courier's blob entry, and the
# pre-blob column the value used to live in. Adding a courier means adding a row
# here; the database itself needs no change.
_COURIER_CREDENTIALS = {
    "postex": "merchant_token",
    "couriers_next": "auth_key",
}


def _decode_couriers(row: dict) -> dict:
    """Courier credentials for one settings row as {courier_id: {key: value}}.
    The `couriers` blob is the only source - a row that predates it reads as
    nothing configured until scripts/backfill_courier_settings.py has run."""
    blob = _decrypt(row.get("couriers"))
    if not blob:
        return {}
    try:
        return json.loads(blob)
    except ValueError:
        # Same reasoning as _decrypt's InvalidToken branch: a corrupt blob
        # reads as "not configured" rather than 500ing every call site.
        logger.warning("Undecodable couriers blob - treating as not configured")
        return {}


@dataclass
class OrgIntegrationSettings:
    shopify_store_url: Optional[str]
    shopify_access_token: Optional[str]
    shopify_api_version: str
    shopify_refresh_token: Optional[str]
    shopify_token_expires_at: Optional[datetime]
    couriers: dict

    def courier_credential(self, courier: str) -> Optional[str]:
        return (self.couriers.get(courier) or {}).get(_COURIER_CREDENTIALS[courier])

    @property
    def postex_merchant_token(self) -> Optional[str]:
        return self.courier_credential("postex")

    @property
    def couriers_next_auth_key(self) -> Optional[str]:
        return self.courier_credential("couriers_next")


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
        couriers=_decode_couriers(row),
    )


def any_org_courier_credential(courier: str) -> Optional[str]:
    """Any one org's credential for `courier`, for callers populating data that
    isn't org-specific (app/services/courier_cities.py's shared city cache).

    The blob is opaque to Postgres, so unlike the pre-blob columns this can't be a
    `.not_.is_(column, "null")` filter - rows are decrypted here until one has the
    credential. Bounded by stopping at the first hit, and only ever reached at
    startup for a courier the cache hasn't populated."""
    rows = (
        get_supabase()
        .table("system_integration_settings")
        .select("*")
        .execute()
        .data
        or []
    )
    key = _COURIER_CREDENTIALS[courier]
    for row in rows:
        value = (_decode_couriers(row).get(courier) or {}).get(key)
        if value:
            return value
    return None


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
    re-entering the Shopify credentials.

    Courier credentials are still named per courier here (the API and both
    Settings UIs speak that shape); this is where they are folded into the
    single `couriers` blob. Setting one courier's credential re-encrypts the
    whole blob, so the others are read back first to avoid dropping them."""
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
    courier_updates = {"postex": postex_merchant_token, "couriers_next": couriers_next_auth_key}
    if any(v is not None for v in courier_updates.values()):
        couriers = get_org_integration_settings(org_id).couriers
        for courier, value in courier_updates.items():
            if value is not None:
                couriers.setdefault(courier, {})[_COURIER_CREDENTIALS[courier]] = value
        payload["couriers"] = _encrypt(json.dumps(couriers))
    get_supabase().table("system_integration_settings").upsert(payload, on_conflict="org_id").execute()

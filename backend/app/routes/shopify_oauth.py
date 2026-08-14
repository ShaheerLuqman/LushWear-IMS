"""Public leg of the Shopify OAuth install flow - Shopify redirects the
merchant's browser here directly after they approve, so this request carries
no Authorization header. It authenticates instead via Shopify's own HMAC
signature plus the signed `state` minted by routes/org_settings.py's
/shopify/install, and must stay mounted without the admin-only router
dependency org_settings.router carries (see app/main.py).

The frontend opens /shopify/install's URL in a popup (not a full-page
redirect), so every path here ends by closing that popup and posting the
result back to the opener via postMessage rather than redirecting - see
frontend/js/auth-users.js's initShopifyConnectButton.
"""

import hashlib
import hmac
import html
import logging
import os
import re

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.auth import verify_state_token
from app.org_settings import upsert_org_integration_settings

router = APIRouter(prefix="/shopify", tags=["shopify-oauth"])
logger = logging.getLogger("app.shopify_oauth")

_SHOP_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*\.myshopify\.com$")


def _verify_hmac(params: dict) -> bool:
    secret = os.getenv("SHOPIFY_APP_CLIENT_SECRET", "")
    received = params.get("hmac", "")
    message = "&".join(f"{k}={v}" for k, v in sorted(params.items()) if k != "hmac")
    digest = hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()
    return bool(secret) and hmac.compare_digest(digest, received)


def _popup_result(status: str, origin: str = "") -> HTMLResponse:
    """Tiny self-closing page the popup lands on. Posts to a specific origin when
    known (the tab that started the flow); falls back to "*" only for the
    failure paths where `state` never decoded, so origin is genuinely unknown -
    the message carries nothing but a status flag, so broadcasting it is harmless."""
    target = html.escape(origin) if origin else "*"
    message = "connected" if status == "connected" else "error"
    body = f"""<!doctype html><meta charset="utf-8"><title>Shopify</title>
<script>
(function() {{
    if (window.opener) {{
        window.opener.postMessage({{ source: "lushwear-shopify-oauth", status: "{message}" }}, "{target}");
    }}
    window.close();
}})();
</script>
<p>{"Shopify connected." if message == "connected" else "Could not connect Shopify."} You can close this window.</p>"""
    return HTMLResponse(body)


@router.get("/callback")
async def shopify_callback(request: Request):
    params = dict(request.query_params)
    shop = params.get("shop", "").strip().lower()
    code = params.get("code")
    state = params.get("state", "")

    if not shop or not _SHOP_RE.match(shop) or not code or not _verify_hmac(params):
        logger.warning("Rejected Shopify callback for shop=%r (bad shop/code/hmac)", shop)
        return _popup_result("error")

    try:
        claims = verify_state_token(state)
    except Exception:
        logger.warning("Rejected Shopify callback for shop=%r (invalid/expired state)", shop)
        return _popup_result("error")
    if claims.get("shop") != shop:
        logger.warning("Rejected Shopify callback: state shop != callback shop (%r)", shop)
        return _popup_result("error", claims.get("origin") or "")

    origin = claims.get("origin") or ""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"https://{shop}/admin/oauth/access_token",
                json={
                    "client_id": os.getenv("SHOPIFY_APP_CLIENT_ID"),
                    "client_secret": os.getenv("SHOPIFY_APP_CLIENT_SECRET"),
                    "code": code,
                },
            )
        resp.raise_for_status()
        access_token = resp.json()["access_token"]
        upsert_org_integration_settings(claims["org_id"], shopify_store_url=shop, shopify_access_token=access_token)
    except Exception:
        logger.exception("Shopify OAuth token exchange failed for %s", shop)
        return _popup_result("error", origin)

    return _popup_result("connected", origin)

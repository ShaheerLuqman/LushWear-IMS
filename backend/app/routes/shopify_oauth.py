"""Public leg of the Shopify OAuth install flow - Shopify redirects the
merchant's browser here directly after they approve, so this request carries
no Authorization header. It authenticates instead via Shopify's own HMAC
signature plus the signed `state` minted by routes/org_settings.py's
/shopify/install, and must stay mounted without the admin-only router
dependency org_settings.router carries (see app/main.py).

The frontend opens /shopify/install's URL in a popup (not a full-page
redirect). This page can't reliably reach back into that popup's opener via
postMessage - window.opener gets nulled out by some browsers/Shopify's own
pages once the popup has navigated cross-origin through them - so it just
self-closes; the frontend detects completion by polling for the popup
closing and re-fetching, not by listening for anything from here. See
frontend/js/auth-users.js's initShopifyConnectButton.
"""

import hashlib
import hmac
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


def _popup_result(status: str) -> HTMLResponse:
    message = "Shopify connected." if status == "connected" else "Could not connect Shopify."
    body = f"""<!doctype html><meta charset="utf-8"><title>Shopify</title>
<script>window.close();</script>
<p>{message} You can close this window.</p>"""
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
    # No check that `shop` matches whatever /shopify/install recorded when the
    # flow started: Shopify echoes back the store's permanent domain here,
    # which differs from a renamed store's current *.myshopify.com alias - the
    # domain typed into Connect Shopify. The state's org_id (HMAC-signed by us)
    # is what ties this callback to the right org; a code only redeems against
    # the shop it was actually issued for, so there's nothing to gain from
    # also requiring the shop string to match.

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
        return _popup_result("error")

    return _popup_result("connected")

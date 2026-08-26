import os
import re
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException

from app.auth import create_state_token, get_org_id
from app.models import OrgIntegrationSettingsPublic, OrgIntegrationSettingsUpdate
from app.org_settings import get_org_integration_settings, to_public_shape, upsert_org_integration_settings

router = APIRouter(prefix="/org-settings", tags=["org-settings"])

_SHOP_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*\.myshopify\.com$")
# read_orders/read_products only - the only two resources app.shopify.fetch_all
# ever calls (orders.json, products.json). No write scopes: this app never
# pushes data back to Shopify.
_SHOPIFY_OAUTH_SCOPES = "read_orders,read_products"


@router.get("/", response_model=OrgIntegrationSettingsPublic)
async def read_org_settings(org_id: str = Depends(get_org_id)):
    return to_public_shape(get_org_integration_settings(org_id))


@router.put("/", response_model=OrgIntegrationSettingsPublic)
async def update_org_settings(body: OrgIntegrationSettingsUpdate, org_id: str = Depends(get_org_id)):
    upsert_org_integration_settings(
        org_id,
        shopify_store_url=body.shopify_store_url,
        shopify_access_token=body.shopify_access_token,
        shopify_api_version=body.shopify_api_version,
        postex_merchant_token=body.postex_merchant_token,
        couriers_next_auth_key=body.couriers_next_auth_key,
    )
    return await read_org_settings(org_id)


@router.get("/shopify/install")
async def shopify_install(shop: str, org_id: str = Depends(get_org_id)):
    """Starts the OAuth handshake (routes/shopify_oauth.py's /shopify/callback
    finishes it) so an org connects its own store without ever handing us a
    token to paste in - Shopify mints the access_token, we only receive it via
    the redirect. Returns the authorize URL rather than redirecting directly
    since this is called via fetch() with an Authorization header, which a
    plain browser navigation can't carry."""
    shop = shop.strip().lower()
    if not _SHOP_RE.match(shop):
        raise HTTPException(status_code=400, detail="Enter your store as your-store.myshopify.com")
    client_id = os.getenv("SHOPIFY_APP_CLIENT_ID")
    redirect_uri = os.getenv("SHOPIFY_APP_REDIRECT_URI")
    if not client_id or not redirect_uri:
        raise HTTPException(status_code=500, detail="Shopify app is not configured on the server.")
    # Deliberately no `shop` claim here - see shopify_oauth.py's callback for why
    # the callback's shop param can't be matched against this anyway.
    state = create_state_token({"org_id": org_id})
    params = {
        "client_id": client_id,
        "scope": _SHOPIFY_OAUTH_SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return {"url": f"https://{shop}/admin/oauth/authorize?{urlencode(params)}"}

import os
import re
from typing import List
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.auth import create_state_token, get_org_id
from app.couriers import assign_courier_bills, get_org_couriers, update_org_courier
from app.fiscal_settings import get_org_fiscal_settings, set_org_fiscal_settings
from app.models import (
    CourierStatus,
    CourierUpdate,
    OrgFiscalSettingsPublic,
    OrgFiscalSettingsUpdate,
    OrgIntegrationSettingsPublic,
    OrgIntegrationSettingsUpdate,
    OrgOnboardingCutoffBody,
    OrgOnboardingCutoffResult,
    OrgOnboardingSettingsPublic,
    OrgOnboardingSettingsUpdate,
)
from app.onboarding_settings import (
    apply_onboarding_cutoff,
    get_earliest_financial_date,
    get_org_onboarding_date,
    set_org_onboarding_date,
)
from app.org_settings import get_org_integration_settings, to_public_shape, upsert_org_integration_settings
from app.services import postex, pre_onboarding

router = APIRouter(prefix="/org-settings", tags=["org-settings"])

_SHOP_RE = re.compile(r"^[a-z0-9][a-z0-9\-]*\.myshopify\.com$")
# read_orders/read_products only - the only two resources app.shopify reads
# (orders.json over REST, products over GraphQL). No write scopes: this app
# never pushes data back to Shopify.
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


@router.get("/couriers", response_model=List[CourierStatus])
async def list_couriers(org_id: str = Depends(get_org_id)):
    return get_org_couriers(org_id)


@router.put("/couriers/{courier_id}", response_model=CourierStatus)
async def update_courier(courier_id: str, body: CourierUpdate, org_id: str = Depends(get_org_id)):
    try:
        status = update_org_courier(
            org_id, courier_id, body.enabled, body.credentials,
            **body.model_dump(include={"fixed_delivery_charge"}, exclude_unset=True),
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown courier")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await assign_courier_bills(org_id, None)
    return status


@router.get("/fiscal", response_model=OrgFiscalSettingsPublic)
async def read_org_fiscal_settings(org_id: str = Depends(get_org_id)):
    return get_org_fiscal_settings(org_id)


@router.put("/fiscal", response_model=OrgFiscalSettingsPublic)
async def update_org_fiscal_settings(body: OrgFiscalSettingsUpdate, org_id: str = Depends(get_org_id)):
    return set_org_fiscal_settings(org_id, body.fiscal_month_start_day, body.fiscal_year_start_month)


@router.post("/couriers/{courier_id}/pre-onboarding-csv")
async def upload_pre_onboarding_csv(
    courier_id: str,
    files: List[UploadFile] = File(...),
    org_id: str = Depends(get_org_id),
):
    """Reconcile a courier's CPRs covering the run-up to onboarding, then build
    that courier's pre-onboarding bill from whatever is still unsettled.

    Nothing is posted for the CSVs themselves: every settlement they carry is
    dated before the books start, so its cash belongs to the opening position.
    The bill is what posts - see PRE_ONBOARDING_COURIER_PLAN.md. Re-uploading
    rebuilds it, so a missed or corrected CPR is just another upload."""
    if not pre_onboarding.supported(courier_id):
        raise HTTPException(status_code=400, detail=f"No CSV format is supported for {courier_id} yet")

    contents = []
    for upload in files:
        if not upload.filename or not upload.filename.lower().endswith(".csv"):
            raise HTTPException(status_code=400, detail=f"{upload.filename or 'File'} is not a CSV")
        contents.append(await upload.read())

    try:
        by_order, _ = pre_onboarding.parse(courier_id, contents)
    except postex.CsvFormatError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not by_order:
        raise HTTPException(status_code=400, detail="No rows with an order number in those CSVs")

    settled = pre_onboarding.mark_settled(org_id, courier_id, by_order)
    courier_name = pre_onboarding.COURIER_NAMES.get(courier_id.lower(), courier_id)
    bill = pre_onboarding.build_bill(org_id, courier_name)
    return {"settled": settled, "bill": bill}


@router.get("/onboarding", response_model=OrgOnboardingSettingsPublic)
async def read_org_onboarding_settings(org_id: str = Depends(get_org_id)):
    return {
        "onboarding_date": get_org_onboarding_date(org_id),
        "earliest_financial_date": get_earliest_financial_date(org_id),
    }


@router.put("/onboarding", response_model=OrgOnboardingSettingsPublic)
async def update_org_onboarding_settings(
    body: OrgOnboardingSettingsUpdate, org_id: str = Depends(get_org_id)
):
    try:
        set_org_onboarding_date(org_id, body.onboarding_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return await read_org_onboarding_settings(org_id)


@router.post("/onboarding/cutoff", response_model=OrgOnboardingCutoffResult)
async def apply_org_onboarding_cutoff(
    body: OrgOnboardingCutoffBody, org_id: str = Depends(get_org_id)
):
    """Destructive: moves the onboarding date forward and purges everything
    financial before it. The UI confirms first (SettingsPage's hold-to-confirm
    dialog); this endpoint does not ask again."""
    try:
        return apply_onboarding_cutoff(org_id, body.onboarding_date)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


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

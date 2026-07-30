from fastapi import APIRouter, Depends

from app.auth import get_org_id
from app.models import OrgIntegrationSettingsPublic, OrgIntegrationSettingsUpdate
from app.org_settings import get_org_integration_settings, to_public_shape, upsert_org_integration_settings

router = APIRouter(prefix="/org-settings", tags=["org-settings"])


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
    )
    return await read_org_settings(org_id)

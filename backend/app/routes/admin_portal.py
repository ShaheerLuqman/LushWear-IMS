from fastapi import APIRouter, Depends, HTTPException

from app.auth import create_token, hash_password, require_role, require_superadmin_or_impersonating
from app.database import get_supabase
from app.models import (
    Organization,
    OrganizationWithAdmin,
    OrgIntegrationSettingsPublic,
    OrgIntegrationSettingsUpdate,
    SuperadminOrgCreate,
)
from app.org_settings import get_org_integration_settings, to_public_shape, upsert_org_integration_settings

router = APIRouter(prefix="/admin", tags=["admin-portal"])


def _get_org_or_404(org_id: str) -> dict:
    rows = get_supabase().table("organizations").select("*").eq("id", org_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="Organization not found")
    return rows[0]


@router.get("/organizations", response_model=list[Organization], dependencies=[Depends(require_superadmin_or_impersonating)])
async def list_organizations():
    return get_supabase().table("organizations").select("*").order("created_at").execute().data or []


@router.post("/organizations/{org_id}/impersonate")
async def impersonate_organization(org_id: str, payload: dict = Depends(require_superadmin_or_impersonating)):
    """Mints a short-lived, org-scoped token so a superadmin can view/act in an
    org's business app for support/debugging - see routes/auth.py's `sub` is
    the *caller's own* id, preserved across switches, so an impersonation
    token always traces back to the real superadmin who started the session."""
    _get_org_or_404(org_id)
    token = create_token(user_id=payload["sub"], org_id=org_id, role="admin", ttl_hours=1, impersonating=True)
    return {"token": token}


@router.post("/organizations", response_model=OrganizationWithAdmin, dependencies=[Depends(require_role("superadmin"))])
async def create_organization(body: SuperadminOrgCreate):
    supabase = get_supabase()
    existing = supabase.table("users").select("id").eq("email", body.admin_email).limit(1).execute().data
    if existing:
        raise HTTPException(status_code=400, detail="A user with this email already exists")

    org = supabase.table("organizations").insert({"name": body.org_name}).execute().data[0]
    admin_user = supabase.table("users").insert({
        "org_id": org["id"],
        "email": body.admin_email,
        "password_hash": hash_password(body.admin_password),
        "role": "admin",
    }).execute().data[0]
    return {"organization": org, "admin_user": admin_user}


@router.get(
    "/organizations/{org_id}/integration-settings",
    response_model=OrgIntegrationSettingsPublic,
    dependencies=[Depends(require_role("superadmin"))],
)
async def read_organization_integration_settings(org_id: str):
    _get_org_or_404(org_id)
    return to_public_shape(get_org_integration_settings(org_id))


@router.put(
    "/organizations/{org_id}/integration-settings",
    response_model=OrgIntegrationSettingsPublic,
    dependencies=[Depends(require_role("superadmin"))],
)
async def update_organization_integration_settings(org_id: str, body: OrgIntegrationSettingsUpdate):
    _get_org_or_404(org_id)
    upsert_org_integration_settings(
        org_id,
        shopify_store_url=body.shopify_store_url,
        shopify_access_token=body.shopify_access_token,
        shopify_api_version=body.shopify_api_version,
        postex_merchant_token=body.postex_merchant_token,
    )
    return to_public_shape(get_org_integration_settings(org_id))

from fastapi import APIRouter, Depends, HTTPException

from app.auth import create_token, require_superadmin, require_superadmin_or_impersonating
from app.database import get_supabase
from app.features import get_org_enabled_features, set_org_enabled_features
from app.memberships import add_membership, get_or_create_identity, list_org_members
from app.models import (
    Organization,
    OrganizationWithAdmin,
    OrgFeaturesPublic,
    OrgFeaturesUpdate,
    OrgIntegrationSettingsPublic,
    OrgIntegrationSettingsUpdate,
    SuperadminOrgCreate,
    UserPublic,
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


@router.post("/organizations", response_model=OrganizationWithAdmin, dependencies=[Depends(require_superadmin)])
async def create_organization(body: SuperadminOrgCreate):
    """Creates a new org and its first admin in one step. Uses the same
    identity-then-membership helpers as routes/users.py's self-service "add a
    user" - if admin_email already belongs to someone else's account, they
    just get an instant membership here instead of a rejected duplicate
    (Multi-Org User Membership plan)."""
    supabase = get_supabase()
    org = supabase.table("organizations").insert({"name": body.org_name}).execute().data[0]
    user = get_or_create_identity(body.admin_email, body.admin_password, body.admin_name)
    membership = add_membership(user["id"], org["id"], "admin")
    admin_user = {
        "id": user["id"],
        "email": user["email"],
        "name": user.get("name", ""),
        "role": membership["role"],
        "org_id": membership["org_id"],
        "is_active": membership["is_active"],
        "created_at": membership.get("created_at"),
    }
    return {"organization": org, "admin_user": admin_user}


@router.get(
    "/organizations/{org_id}/users",
    response_model=list[UserPublic],
    dependencies=[Depends(require_superadmin)],
)
async def read_organization_users(org_id: str):
    """Read-only view of who has access to an org and what role - lets a
    superadmin check membership without impersonating in and opening the
    org's own Settings > Users. Managing users (add/change role/deactivate)
    still happens from within the org itself, via "View as org"."""
    _get_org_or_404(org_id)
    return list_org_members(org_id)


@router.get(
    "/organizations/{org_id}/features",
    response_model=OrgFeaturesPublic,
    dependencies=[Depends(require_superadmin)],
)
async def read_organization_features(org_id: str):
    _get_org_or_404(org_id)
    return OrgFeaturesPublic(enabled_features=get_org_enabled_features(org_id))


@router.put(
    "/organizations/{org_id}/features",
    response_model=OrgFeaturesPublic,
    dependencies=[Depends(require_superadmin)],
)
async def update_organization_features(org_id: str, body: OrgFeaturesUpdate):
    """Toggles which top-level app sections this org's users can see/use -
    enforced server-side by app/features.py's require_feature, not just a
    sidebar hint."""
    _get_org_or_404(org_id)
    return OrgFeaturesPublic(enabled_features=set_org_enabled_features(org_id, body.enabled_features))


@router.get(
    "/organizations/{org_id}/integration-settings",
    response_model=OrgIntegrationSettingsPublic,
    dependencies=[Depends(require_superadmin)],
)
async def read_organization_integration_settings(org_id: str):
    _get_org_or_404(org_id)
    return to_public_shape(get_org_integration_settings(org_id))


@router.put(
    "/organizations/{org_id}/integration-settings",
    response_model=OrgIntegrationSettingsPublic,
    dependencies=[Depends(require_superadmin)],
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

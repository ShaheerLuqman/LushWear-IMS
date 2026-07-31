"""Per-org feature flags (Feature Access plan) - controls which top-level
sections of the app (Shopify order management, Finance) an org's users can
see and use. Toggled only from the Superadmin Portal (routes/admin_portal.py);
enforced server-side via `require_feature`, applied at router level (main.py)
alongside require_auth, so a disabled feature is blocked for every route
under it, not just the ones the sidebar happens to hide.

New feature keys get added to ALL_FEATURES as new sections ship. Keep in sync
with app/models.py's FeatureKey Literal, used to validate the toggle payload.
"""

from fastapi import Depends, HTTPException

from app.auth import get_org_id
from app.database import get_supabase

ALL_FEATURES = ("orders", "finance")


def get_org_enabled_features(org_id: str) -> list:
    rows = (
        get_supabase()
        .table("organizations")
        .select("enabled_features")
        .eq("id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return []
    return rows[0].get("enabled_features") or []


def set_org_enabled_features(org_id: str, features: list) -> list:
    rows = (
        get_supabase()
        .table("organizations")
        .update({"enabled_features": features})
        .eq("id", org_id)
        .execute()
        .data
        or []
    )
    return rows[0]["enabled_features"] if rows else features


def require_feature(feature: str):
    """FastAPI dependency factory: 403s unless the caller's org has `feature`
    enabled. Use alongside `require_auth` at router level, e.g.
    `dependencies=[Depends(require_auth), Depends(require_feature("finance"))]`."""

    async def _dependency(org_id: str = Depends(get_org_id)) -> None:
        if feature not in get_org_enabled_features(org_id):
            raise HTTPException(status_code=403, detail=f"The '{feature}' feature is not enabled for this organization")

    return _dependency

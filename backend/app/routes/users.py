from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_org_id
from app.database import get_supabase
from app.memberships import add_membership, get_or_create_identity, list_org_members
from app.models import UserCreate, UserPublic, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def _active_admin_count(supabase, org_id: str, exclude_user_id: Optional[str] = None) -> int:
    rows = (
        supabase.table("system_org_memberships")
        .select("user_id")
        .eq("org_id", org_id)
        .eq("role", "admin")
        .eq("is_active", True)
        .execute()
        .data
        or []
    )
    if exclude_user_id:
        rows = [r for r in rows if r["user_id"] != exclude_user_id]
    return len(rows)


def _membership_to_public(membership: dict, user: dict) -> dict:
    return {
        "id": membership["user_id"],
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "role": membership["role"],
        "org_id": membership["org_id"],
        "is_active": membership["is_active"],
        "created_at": membership.get("created_at"),
    }


@router.get("/", response_model=List[UserPublic])
async def list_users(org_id: str = Depends(get_org_id)):
    return list_org_members(org_id)


@router.post("/", response_model=UserPublic)
async def create_user(body: UserCreate, org_id: str = Depends(get_org_id)):
    """Adds a user to the caller's org. If the email doesn't exist yet, creates
    a new account (password required); if it already belongs to someone else's
    account, grants them an instant membership here instead (Multi-Org User
    Membership plan) - no invite/accept step, they keep using their existing
    password."""
    user = get_or_create_identity(body.email, body.password, body.name)
    membership = add_membership(user["id"], org_id, body.role)
    return _membership_to_public(membership, user)


@router.put("/{user_id}", response_model=UserPublic)
async def update_user(user_id: str, body: UserUpdate, org_id: str = Depends(get_org_id)):
    """Update a user's role/is_active *within the caller's org*. Scoped to a
    single org_memberships row - a person's access to other orgs they belong
    to is untouched. A user id with no membership in this org 404s, same as
    if it didn't exist."""
    supabase = get_supabase()
    existing_rows = (
        supabase.table("system_org_memberships")
        .select("*")
        .eq("user_id", user_id)
        .eq("org_id", org_id)
        .limit(1)
        .execute()
        .data
    )
    if not existing_rows:
        raise HTTPException(status_code=404, detail="User not found")
    existing = existing_rows[0]

    # Refuse to leave the org with zero active admins - the only way anyone
    # could manage users (or undo this change) afterwards would be a direct DB edit.
    demoting_last_admin = existing["role"] == "admin" and (
        (body.role is not None and body.role != "admin") or body.is_active is False
    )
    if demoting_last_admin and _active_admin_count(supabase, org_id, exclude_user_id=user_id) == 0:
        raise HTTPException(status_code=400, detail="Cannot remove the organization's last active admin")

    update_fields = body.model_dump(exclude_unset=True)
    if update_fields:
        existing = (
            supabase.table("system_org_memberships")
            .update(update_fields)
            .eq("user_id", user_id)
            .eq("org_id", org_id)
            .execute()
            .data[0]
        )

    user_row = supabase.table("system_users").select("email, name").eq("id", user_id).limit(1).execute().data[0]
    return _membership_to_public(existing, user_row)

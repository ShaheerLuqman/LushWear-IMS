from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_org_id, hash_password
from app.database import get_supabase
from app.models import UserCreate, UserPublic, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def _active_admin_count(supabase, org_id: str, exclude_user_id: Optional[str] = None) -> int:
    rows = (
        supabase.table("users")
        .select("id")
        .eq("org_id", org_id)
        .eq("role", "admin")
        .eq("is_active", True)
        .execute()
        .data
        or []
    )
    if exclude_user_id:
        rows = [r for r in rows if r["id"] != exclude_user_id]
    return len(rows)


@router.get("/", response_model=List[UserPublic])
async def list_users(org_id: str = Depends(get_org_id)):
    return (
        get_supabase()
        .table("users")
        .select("*")
        .eq("org_id", org_id)
        .order("created_at")
        .execute()
        .data
        or []
    )


@router.post("/", response_model=UserPublic)
async def create_user(body: UserCreate, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    existing = supabase.table("users").select("id").eq("email", body.email).limit(1).execute().data
    if existing:
        raise HTTPException(status_code=400, detail="A user with this email already exists")

    row = supabase.table("users").insert({
        "org_id": org_id,
        "email": body.email,
        "password_hash": hash_password(body.password),
        "role": body.role,
    }).execute().data[0]
    return row


@router.put("/{user_id}", response_model=UserPublic)
async def update_user(user_id: str, body: UserUpdate, org_id: str = Depends(get_org_id)):
    """Update a user's role/is_active. Scoped to the caller's own org - a user
    id from a different org 404s, same as if it didn't exist."""
    supabase = get_supabase()
    existing_rows = (
        supabase.table("users").select("*").eq("id", user_id).eq("org_id", org_id).limit(1).execute().data
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
    if not update_fields:
        return existing
    row = supabase.table("users").update(update_fields).eq("id", user_id).eq("org_id", org_id).execute().data[0]
    return row

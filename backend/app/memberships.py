"""Shared identity+membership logic (Multi-Org User Membership plan). Both
routes/users.py ("add a user to my org") and routes/admin_portal.py ("create
org + first admin") hit the same get-or-create-identity-then-add-membership
path, so an email that already exists elsewhere gets instant membership in
the new org instead of a rejected duplicate - the two call sites share one
implementation rather than diverging over time.
"""
from typing import Optional

from fastapi import HTTPException

from app.auth import hash_password
from app.database import get_supabase


def get_or_create_identity(email: str, password: Optional[str], name: Optional[str] = None) -> dict:
    """Returns the existing `users` row for `email` if one exists - password
    and name are both ignored, they already have an identity - else creates a
    new one (`password` and `name` are then both required)."""
    supabase = get_supabase()
    existing = supabase.table("system_users").select("*").eq("email", email).limit(1).execute().data
    if existing:
        return existing[0]
    if not password:
        raise HTTPException(
            status_code=400,
            detail="Password is required to create a new account for this email",
        )
    if not name:
        raise HTTPException(
            status_code=400,
            detail="Name is required to create a new account for this email",
        )
    return supabase.table("system_users").insert({
        "email": email,
        "name": name,
        "password_hash": hash_password(password),
    }).execute().data[0]


def add_membership(user_id: str, org_id: str, role: str) -> dict:
    """Adds an org_memberships row; 400s if one already exists for this pair."""
    supabase = get_supabase()
    existing = (
        supabase.table("system_org_memberships")
        .select("user_id")
        .eq("user_id", user_id)
        .eq("org_id", org_id)
        .limit(1)
        .execute()
        .data
    )
    if existing:
        raise HTTPException(status_code=400, detail="This user is already a member of this organization")
    return supabase.table("system_org_memberships").insert({
        "user_id": user_id,
        "org_id": org_id,
        "role": role,
    }).execute().data[0]


def list_org_members(org_id: str) -> list:
    """Memberships for an org, joined with each member's email/name - shared
    by the org's own self-service user list (routes/users.py) and the
    Superadmin Portal's read-only per-org view (routes/admin_portal.py)."""
    supabase = get_supabase()
    memberships = (
        supabase.table("system_org_memberships")
        .select("*")
        .eq("org_id", org_id)
        .order("created_at")
        .execute()
        .data
        or []
    )
    if not memberships:
        return []

    user_ids = [m["user_id"] for m in memberships]
    users = supabase.table("system_users").select("id, email, name").in_("id", user_ids).execute().data or []
    by_id = {u["id"]: u for u in users}
    return [
        {
            "id": m["user_id"],
            "email": by_id.get(m["user_id"], {}).get("email", ""),
            "name": by_id.get(m["user_id"], {}).get("name", ""),
            "role": m["role"],
            "org_id": m["org_id"],
            "is_active": m["is_active"],
            "created_at": m.get("created_at"),
        }
        for m in memberships
    ]

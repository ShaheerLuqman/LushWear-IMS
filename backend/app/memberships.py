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


def get_or_create_identity(email: str, password: Optional[str]) -> dict:
    """Returns the existing `users` row for `email` if one exists - password is
    ignored, they already have one - else creates a new identity (`password`
    is then required)."""
    supabase = get_supabase()
    existing = supabase.table("users").select("*").eq("email", email).limit(1).execute().data
    if existing:
        return existing[0]
    if not password:
        raise HTTPException(
            status_code=400,
            detail="Password is required to create a new account for this email",
        )
    return supabase.table("users").insert({
        "email": email,
        "password_hash": hash_password(password),
    }).execute().data[0]


def add_membership(user_id: str, org_id: str, role: str) -> dict:
    """Adds an org_memberships row; 400s if one already exists for this pair."""
    supabase = get_supabase()
    existing = (
        supabase.table("org_memberships")
        .select("user_id")
        .eq("user_id", user_id)
        .eq("org_id", org_id)
        .limit(1)
        .execute()
        .data
    )
    if existing:
        raise HTTPException(status_code=400, detail="This user is already a member of this organization")
    return supabase.table("org_memberships").insert({
        "user_id": user_id,
        "org_id": org_id,
        "role": role,
    }).execute().data[0]


def list_org_members(org_id: str) -> list:
    """Memberships for an org, joined with each member's email - shared by the
    org's own self-service user list (routes/users.py) and the Superadmin
    Portal's read-only per-org view (routes/admin_portal.py)."""
    supabase = get_supabase()
    memberships = (
        supabase.table("org_memberships")
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
    users = supabase.table("users").select("id, email").in_("id", user_ids).execute().data or []
    emails = {u["id"]: u["email"] for u in users}
    return [
        {
            "id": m["user_id"],
            "email": emails.get(m["user_id"], ""),
            "role": m["role"],
            "org_id": m["org_id"],
            "is_active": m["is_active"],
            "created_at": m.get("created_at"),
        }
        for m in memberships
    ]

import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from app.auth import create_token, hash_password, require_auth, verify_password
from app.database import get_supabase
from app.features import get_org_enabled_features
from app.fiscal_settings import get_org_fiscal_settings
from app.models import (
    AccountPublic,
    BootstrapBody,
    ChangePasswordBody,
    LoginBody,
    MyOrganization,
    SwitchOrgBody,
    UserPublic,
)
from app.rate_limit import limiter

router = APIRouter(prefix="/auth", tags=["auth"])

BOOTSTRAP_ROW_ID = "default"


class _LoginLockout:
    """Per-email brute-force lockout, backed by the `login_lockouts` table.

    Same shape/pattern as routes/app_pin.py's `_Lockout` (see
    supabase/migrations/20260730050000_login_lockouts_table.sql) - keyed by
    email instead of client IP, since each user has their own password now
    rather than everyone sharing one PIN.
    """

    def __init__(self, max_attempts: int = 5, window: int = 15 * 60):
        self.max_attempts = max_attempts
        self.window = window

    def check(self, email: str) -> None:
        rows = (
            get_supabase()
            .table("system_login_lockouts")
            .select("locked_until")
            .eq("email", email)
            .limit(1)
            .execute()
            .data
            or []
        )
        locked_until_raw = rows[0].get("locked_until") if rows else None
        if not locked_until_raw:
            return
        locked_until = datetime.fromisoformat(str(locked_until_raw).replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        if locked_until > now:
            retry_after = int((locked_until - now).total_seconds()) + 1
            raise HTTPException(
                status_code=429,
                detail=f"Too many incorrect attempts. Try again in {retry_after} seconds.",
                headers={"Retry-After": str(retry_after)},
            )

    def record_failure(self, email: str) -> None:
        get_supabase().rpc("record_login_lockout_failure", {
            "p_email": email,
            "p_max_attempts": self.max_attempts,
            "p_window_seconds": self.window,
        }).execute()

    def clear(self, email: str) -> None:
        get_supabase().table("system_login_lockouts").delete().eq("email", email).execute()


_lockout = _LoginLockout()


def _get_user_by_email(email: str) -> Optional[dict]:
    rows = (
        get_supabase()
        .table("system_users")
        .select("*")
        .eq("email", email)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


def _fetch_active_memberships(user_id: str) -> list:
    """A person's org_memberships rows (Multi-Org User Membership plan) -
    ordered by created_at, so the first entry is always their oldest/first
    org, a stable default when a session needs to pick one without a client
    telling it which."""
    return (
        get_supabase()
        .table("system_org_memberships")
        .select("*")
        .eq("user_id", user_id)
        .eq("is_active", True)
        .order("created_at")
        .execute()
        .data
        or []
    )


@router.get("/status")
async def auth_status():
    """Whether any user has been created yet (i.e. whether bootstrap has run)."""
    try:
        rows = get_supabase().table("system_users").select("id").limit(1).execute().data or []
        return {"has_users": bool(rows)}
    except Exception:
        raise HTTPException(
            status_code=503,
            detail='Organizations & Users tables are missing. Run the latest supabase migrations.',
        )


@router.post("/bootstrap")
async def auth_bootstrap(body: BootstrapBody, x_bootstrap_token: Optional[str] = Header(default=None)):
    """One-time setup: creates the first organization and its first admin user.

    Race-free via `system_bootstrap`'s single row, inserted with
    ignore_duplicates=True (Postgres ON CONFLICT DO NOTHING) so only the first
    concurrent caller can ever get past the check - a plain "SELECT COUNT(*)
    FROM users" check would be a TOCTOU race. In production, additionally
    requires a BOOTSTRAP_TOKEN header matching the configured env var, so this
    permanently-mounted endpoint isn't a live unauthenticated org-creation hole
    once the one-time bootstrap has happened.
    """
    is_prod = os.getenv("APP_ENV", "dev").strip().lower() == "prod"
    if is_prod:
        configured_token = os.getenv("BOOTSTRAP_TOKEN")
        if not configured_token or x_bootstrap_token != configured_token:
            raise HTTPException(status_code=403, detail="Bootstrap is not enabled")

    supabase = get_supabase()
    claim = (
        supabase.table("system_bootstrap")
        .upsert({"id": BOOTSTRAP_ROW_ID}, ignore_duplicates=True)
        .execute()
    )
    if not claim.data:
        raise HTTPException(status_code=400, detail="Bootstrap has already been completed")

    # The org-scoping migration (20260730070000) backfills a "LushWear" org for
    # any pre-existing data before this endpoint is ever called - reuse that
    # org instead of unconditionally inserting a second one, which would leave
    # this first admin in an empty org while all the migrated data sits under
    # the other one.
    existing_orgs = (
        supabase.table("system_organizations").select("*").order("created_at").limit(1).execute().data
    )
    org = existing_orgs[0] if existing_orgs else (
        supabase.table("system_organizations").insert({"name": body.org_name}).execute().data[0]
    )
    user = supabase.table("system_users").insert({
        "email": body.email,
        "name": body.name,
        "password_hash": hash_password(body.password),
    }).execute().data[0]
    supabase.table("system_org_memberships").insert({
        "user_id": user["id"],
        "org_id": org["id"],
        "role": "admin",
    }).execute()

    token = create_token(user_id=user["id"], org_id=org["id"], role="admin")
    account = {**user, "org_id": org["id"], "role": "admin", "is_active": True}
    return {"ok": True, "token": token, "user": UserPublic.model_validate(account)}


@router.post("/login")
@limiter.limit("10/minute")
async def auth_login(body: LoginBody, request: Request):
    """Email+password login. Lockout is keyed by email; the route also carries
    a stricter IP-side rate limit as a backstop - an email-only lock would
    otherwise let anyone who knows a real address (e.g. a public support inbox)
    lock that account out for free from any IP.

    A person may have an active membership in more than one org (Multi-Org
    User Membership plan). The token is minted against their *first*
    membership (oldest by created_at) as a stable default - the frontend's own
    "resolve last-used org" logic then immediately swaps to the right one via
    POST /auth/switch-org if localStorage says otherwise, exactly the same
    mechanism already used for a superadmin's "View as org" flow. This keeps
    /auth/login a single call with an unchanged contract for the common
    (single-org) case, rather than adding an org-picker step here.
    """
    _lockout.check(body.email)

    user = _get_user_by_email(body.email)
    if not user or not verify_password(body.password, user["password_hash"]):
        # Same generic message whether the email doesn't exist or the password
        # is wrong - avoids leaking account status.
        _lockout.record_failure(body.email)
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    memberships = _fetch_active_memberships(user["id"])
    if not memberships and not user.get("is_superadmin"):
        # No active membership anywhere, and not a superadmin - nothing to log
        # into. Bundled into the same generic failure as a wrong password,
        # same "don't leak account status" reasoning as above.
        _lockout.record_failure(body.email)
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    _lockout.clear(body.email)

    if memberships:
        first = memberships[0]
        org_id, role = first["org_id"], first["role"]
    else:
        org_id, role = None, None  # pure superadmin, no memberships

    token = create_token(
        user_id=user["id"], org_id=org_id, role=role,
        is_superadmin=user.get("is_superadmin", False),
    )
    account = {
        **user, "org_id": org_id, "role": role,
        "enabled_features": get_org_enabled_features(org_id) if org_id else [],
        **(get_org_fiscal_settings(org_id) if org_id else {}),
    }
    return {"ok": True, "token": token, "user": AccountPublic.model_validate(account)}


@router.get("/me", response_model=AccountPublic)
async def auth_me(payload: dict = Depends(require_auth)):
    """Current user's profile: identity from the DB, plus the *current
    session's* org/role context from the token - a person can have a
    different role in each org they belong to (Multi-Org User Membership
    plan), so "current role" only makes sense per session."""
    user_id = payload.get("sub")
    rows = get_supabase().table("system_users").select("*").eq("id", user_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="User not found")
    org_id = payload.get("org_id")
    account = {
        **rows[0], "org_id": org_id, "role": payload.get("role"),
        "enabled_features": get_org_enabled_features(org_id) if org_id else [],
        **(get_org_fiscal_settings(org_id) if org_id else {}),
    }
    return AccountPublic.model_validate(account)


@router.get("/my-organizations", response_model=list[MyOrganization])
async def auth_my_organizations(payload: dict = Depends(require_auth)):
    """Orgs the caller has an active membership in, with their role in each -
    lets a multi-org member (or a superadmin who also holds real memberships)
    discover/switch between orgs they actually belong to. Distinct from the
    Superadmin Portal's GET /admin/organizations, which lists *every* org that
    exists, membership or not."""
    memberships = _fetch_active_memberships(payload.get("sub"))
    if not memberships:
        return []
    org_ids = [m["org_id"] for m in memberships]
    orgs = get_supabase().table("system_organizations").select("id, name").in_("id", org_ids).execute().data or []
    org_names = {o["id"]: o["name"] for o in orgs}
    return [
        {"id": m["org_id"], "name": org_names.get(m["org_id"], ""), "role": m["role"]}
        for m in memberships
    ]


@router.post("/switch-org")
async def auth_switch_org(body: SwitchOrgBody, payload: dict = Depends(require_auth)):
    """Mints a token scoped to a different org the caller has an active
    membership in - a real session switch, not the Superadmin Portal's
    view-only impersonation (POST /admin/organizations/{id}/impersonate),
    which bypasses the membership check entirely."""
    rows = (
        get_supabase()
        .table("system_org_memberships")
        .select("*")
        .eq("user_id", payload.get("sub"))
        .eq("org_id", body.org_id)
        .eq("is_active", True)
        .limit(1)
        .execute()
        .data
    )
    if not rows:
        raise HTTPException(status_code=403, detail="Not a member of this organization")
    membership = rows[0]
    token = create_token(
        user_id=payload.get("sub"), org_id=membership["org_id"], role=membership["role"],
        is_superadmin=payload.get("is_superadmin", False),
    )
    return {"token": token}


@router.post("/change-password")
async def auth_change_password(body: ChangePasswordBody, payload: dict = Depends(require_auth)):
    """Replace the caller's own password; requires the current one."""
    user_id = payload.get("sub")
    supabase = get_supabase()
    rows = supabase.table("system_users").select("*").eq("id", user_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="User not found")
    user = rows[0]
    if not verify_password(body.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    supabase.table("system_users").update({
        "password_hash": hash_password(body.new_password),
    }).eq("id", user_id).execute()
    return {"ok": True}

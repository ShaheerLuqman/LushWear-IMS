import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from app.auth import create_token, hash_password, require_auth, verify_password
from app.database import get_supabase
from app.models import BootstrapBody, LoginBody, UserPublic
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
            .table("login_lockouts")
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
        get_supabase().table("login_lockouts").delete().eq("email", email).execute()


_lockout = _LoginLockout()


def _get_user_by_email(email: str) -> Optional[dict]:
    rows = (
        get_supabase()
        .table("users")
        .select("*")
        .eq("email", email)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


@router.get("/status")
async def auth_status():
    """Whether any user has been created yet (i.e. whether bootstrap has run)."""
    try:
        rows = get_supabase().table("users").select("id").limit(1).execute().data or []
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
    is_prod = os.getenv("APP_ENV", "development").strip().lower() == "production"
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

    org = supabase.table("organizations").insert({"name": body.org_name}).execute().data[0]
    user = supabase.table("users").insert({
        "org_id": org["id"],
        "email": body.email,
        "password_hash": hash_password(body.password),
        "role": "admin",
    }).execute().data[0]

    token = create_token(user_id=user["id"], org_id=org["id"], role=user["role"])
    return {"ok": True, "token": token, "user": UserPublic.model_validate(user)}


@router.post("/login")
@limiter.limit("10/minute")
async def auth_login(body: LoginBody, request: Request):
    """Email+password login. Lockout is keyed by email; the route also carries
    a stricter IP-side rate limit as a backstop - an email-only lock would
    otherwise let anyone who knows a real address (e.g. a public support inbox)
    lock that account out for free from any IP."""
    _lockout.check(body.email)

    user = _get_user_by_email(body.email)
    if not user or not user.get("is_active") or not verify_password(body.password, user["password_hash"]):
        # Same generic message whether the email doesn't exist, the account is
        # deactivated, or the password is wrong - avoids leaking account status.
        _lockout.record_failure(body.email)
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    _lockout.clear(body.email)
    token = create_token(user_id=user["id"], org_id=user["org_id"], role=user["role"])
    return {"ok": True, "token": token, "user": UserPublic.model_validate(user)}


@router.get("/me", response_model=UserPublic)
async def auth_me(payload: dict = Depends(require_auth)):
    """Current user's profile, from the token's `sub` (user id)."""
    user_id = payload.get("sub")
    rows = get_supabase().table("users").select("*").eq("id", user_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="User not found")
    return rows[0]

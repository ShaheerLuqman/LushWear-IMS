"""Session-token auth, plus password hashing shared with routes/auth.py and
routes/users.py.

Each user logs in via routes/auth.py (POST /auth/login) and receives a signed
JWT, which it must then send as `Authorization: Bearer <token>` on every
protected API call.

`sub` is the user's id; `org_id`/`role` scope every request to one
organization and gate admin-only routes via `require_role`. A token minted by
the now-removed app-PIN flow (routes/app_pin.py, dropped in
ORGANIZATIONS_USERS_PLAN.md's Phase 4) had no `org_id`/`role` - any such token
still in the wild simply 403s at `get_org_id`/`require_role` rather than being
silently scoped to nothing; its 7-day TTL means none can still be valid anyway.
"""

import os
import time
import secrets
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException

_ALGORITHM = "HS256"
_DEFAULT_TTL_HOURS = 24 * 7  # 7 days

# bcrypt cost factor. A short password is not meaningfully protected against
# offline cracking by hash cost alone, so the real brute-force defense is the
# API-side lockout (login_lockouts). Kept low for a snappy verify.
_BCRYPT_ROUNDS = 8

# Dev fallback secret: generated once per process when AUTH_SECRET is not set.
# Tokens signed with it are invalidated whenever the server restarts. Production
# MUST set AUTH_SECRET (a long random string) so tokens survive restarts/deploys.
_runtime_secret: str | None = None


def _get_secret() -> str:
    global _runtime_secret
    configured = os.getenv("AUTH_SECRET")
    if configured:
        return configured
    if _runtime_secret is None:
        _runtime_secret = secrets.token_urlsafe(48)
    return _runtime_secret


def _ttl_seconds() -> int:
    raw = os.getenv("AUTH_TOKEN_TTL_HOURS", str(_DEFAULT_TTL_HOURS))
    try:
        hours = float(raw)
    except (TypeError, ValueError):
        hours = _DEFAULT_TTL_HOURS
    return int(hours * 3600)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(_BCRYPT_ROUNDS)).decode("ascii")


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("ascii"))
    except (ValueError, TypeError):
        # Malformed stored hash — treat as non-match rather than 500.
        return False


def create_token(
    user_id: str,
    org_id: Optional[str],
    role: Optional[str],
    *,
    is_superadmin: bool = False,
    ttl_hours: Optional[float] = None,
    impersonating: bool = False,
) -> str:
    """Issue a signed session token, embedding the caller's identity plus the
    *current* org/role context (Multi-Org User Membership plan: a person can
    have a different role in each org they belong to, so `org_id`/`role`
    describe this session, not a fixed property of the user).

    `is_superadmin` is a separate, org-independent claim - a platform-level
    flag (see app/memberships.py's callers and routes/admin_portal.py), not an
    org role, so it stays true regardless of which org (if any) `org_id`
    currently points at.

    `ttl_hours`/`impersonating` are only passed by the Superadmin Portal's
    "View as org" flow (routes/admin_portal.py) - an impersonation token needs
    a short TTL and the `impersonating` claim so `require_superadmin_or_impersonating`
    can tell a genuine superadmin session apart from one that's just viewing
    a single org and should only be allowed to switch which org it's viewing.
    """
    now = int(time.time())
    ttl = int(ttl_hours * 3600) if ttl_hours is not None else _ttl_seconds()
    payload = {
        "sub": user_id,
        "org_id": org_id,
        "role": role,
        "is_superadmin": is_superadmin,
        "iat": now,
        "exp": now + ttl,
        "impersonating": impersonating,
    }
    return jwt.encode(payload, _get_secret(), algorithm=_ALGORITHM)


async def require_auth(authorization: str = Header(default=None)) -> dict:
    """FastAPI dependency: require a valid Bearer token. Returns the token payload."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.split(" ", 1)[1].strip()
    try:
        return jwt.decode(token, _get_secret(), algorithms=[_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


def require_role(*roles: str):
    """FastAPI dependency factory: require the caller's token `role` to be one
    of `roles`. Use alongside `require_auth` (already applied per-router in
    main.py) for admin-only routes, e.g. `Depends(require_role("admin"))`."""

    async def _dependency(payload: dict = Depends(require_auth)) -> dict:
        if payload.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return payload

    return _dependency


async def require_superadmin(payload: dict = Depends(require_auth)) -> dict:
    """FastAPI dependency: require the caller's token to carry `is_superadmin`
    - a platform-level flag, independent of `org_id`/`role` (Multi-Org User
    Membership plan), so this works regardless of which org (if any) the
    caller's session is currently scoped to."""
    if payload.get("is_superadmin") is not True:
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return payload


async def require_superadmin_or_impersonating(payload: dict = Depends(require_auth)) -> dict:
    """FastAPI dependency: allows a real superadmin token, or a token already
    impersonating an org. Used only by the Superadmin Portal's org-listing and
    impersonate routes, so switching which org you're viewing doesn't require
    holding onto the original superadmin token in the same browser tab - an
    impersonation token could only ever have been minted by a real superadmin
    to begin with, so letting it request a *different* org's impersonation
    token isn't a privilege escalation, just a continuation of the same trust."""
    if payload.get("is_superadmin") is not True and payload.get("impersonating") is not True:
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return payload


async def get_org_id(payload: dict = Depends(require_auth)) -> str:
    """FastAPI dependency: the caller's own org_id, for `app.org_scope.org_table()`.
    A token with no org_id claim 403s here rather than silently scoping to
    nothing - defends against a stale pre-Phase-4 app-PIN token still being
    live within its 7-day TTL."""
    org_id = payload.get("org_id")
    if not org_id:
        raise HTTPException(status_code=403, detail="No organization for this session")
    return org_id

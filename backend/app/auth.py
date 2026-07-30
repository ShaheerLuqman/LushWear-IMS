"""Session-token auth, plus password hashing shared with routes/auth.py (and,
until Phase 4 of ORGANIZATIONS_USERS_PLAN.md, routes/app_pin.py).

Each user logs in via routes/auth.py (POST /auth/login) and receives a signed
JWT, which it must then send as `Authorization: Bearer <token>` on every
protected API call.

`sub` is the user's id; `org_id`/`role` scope every request to one
organization and gate admin-only routes via `require_role`. A token minted by
the (soon retired) app-PIN flow has no `org_id`/`role` - see
ORGANIZATIONS_USERS_PLAN.md's "PIN is retired" note.
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

# bcrypt cost factor. A short PIN/password is not meaningfully protected
# against offline cracking by hash cost alone, so the real brute-force defense
# is the API-side lockout (pin_lockouts / login_lockouts). Kept low for a
# snappy verify.
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


def create_token(user_id: str = "app", org_id: Optional[str] = None, role: Optional[str] = None) -> str:
    """Issue a signed session token. `user_id="app"`/no org_id/no role is the
    legacy app-PIN shape (see module docstring) - real logins always pass all three."""
    now = int(time.time())
    payload = {"sub": user_id, "org_id": org_id, "role": role, "iat": now, "exp": now + _ttl_seconds()}
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

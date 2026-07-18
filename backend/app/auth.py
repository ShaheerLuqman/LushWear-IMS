"""Lightweight session-token auth.

The app is gated by a single shared PIN (see routes/app_pin.py). On a successful
PIN verify/setup the client receives a signed JWT, which it must then send as
`Authorization: Bearer <token>` on every protected API call.

This is intentionally simple (one shared identity). It is designed to grow into
full users/orgs/RBAC later: the `require_auth` dependency and the token payload
are the extension points — add `user_id` / `org_id` / `role` claims and per-role
dependencies without changing the wiring in main.py or the frontend.
"""

import os
import time
import secrets

import jwt
from fastapi import Header, HTTPException

_ALGORITHM = "HS256"
_DEFAULT_TTL_HOURS = 24 * 7  # 7 days

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


def create_token(subject: str = "app") -> str:
    """Issue a signed session token."""
    now = int(time.time())
    payload = {"sub": subject, "iat": now, "exp": now + _ttl_seconds()}
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

from datetime import datetime, timezone
from typing import Annotated, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import AfterValidator, BaseModel

from app.client_ip import get_client_ip
from app.database import get_supabase
from app.auth import create_token, hash_password, verify_password

router = APIRouter(prefix="/app-pin", tags=["app-pin"])

APP_PIN_ROW_ID = "default"


def _validate_pin(pin: str) -> str:
    p = (pin or "").strip()
    if not (4 <= len(p) <= 64):
        raise HTTPException(status_code=400, detail="PIN must be between 4 and 64 characters")
    return p


# A PIN field that is stripped and length-checked during request parsing.
Pin = Annotated[str, AfterValidator(_validate_pin)]


class PinVerifyBody(BaseModel):
    pin: Pin


class PinSetupBody(BaseModel):
    pin: Pin
    confirm_pin: Pin


class PinChangeBody(BaseModel):
    current_pin: Pin
    new_pin: Pin
    confirm_pin: Pin


class _Lockout:
    """Per-client brute-force lockout, backed by the `pin_lockouts` table.

    After ``max_attempts`` failed /verify attempts within ``window`` seconds, the
    client is locked out for ``window`` seconds. Externalized to Supabase (was an
    in-memory, per-process dict) so it survives restarts/redeploys and is shared
    across replicas - see supabase/migrations/20260730020000_pin_lockouts_table.sql.
    A successful verify clears the row.
    """

    def __init__(self, max_attempts: int = 5, window: int = 15 * 60):
        self.max_attempts = max_attempts
        self.window = window

    def check(self, key: str) -> None:
        """Raise 429 if ``key`` is currently locked out."""
        rows = (
            get_supabase()
            .table("pin_lockouts")
            .select("locked_until")
            .eq("client_key", key)
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

    def record_failure(self, key: str) -> None:
        # Atomic (row-locked in Postgres) so concurrent failures from the same
        # key can't race past max_attempts - see the RPC function for why.
        get_supabase().rpc("record_pin_lockout_failure", {
            "p_client_key": key,
            "p_max_attempts": self.max_attempts,
            "p_window_seconds": self.window,
        }).execute()

    def clear(self, key: str) -> None:
        get_supabase().table("pin_lockouts").delete().eq("client_key", key).execute()


_lockout = _Lockout()


def _get_existing_hash() -> Optional[str]:
    rows = (
        get_supabase()
        .table("app_pin")
        .select("pin_hash")
        .eq("id", APP_PIN_ROW_ID)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0].get("pin_hash") if rows else None


def _store_hash(pin: str, *, insert: bool) -> None:
    row = {"pin_hash": hash_password(pin), "updated_at": datetime.now(timezone.utc).isoformat()}
    table = get_supabase().table("app_pin")
    if insert:
        table.insert({"id": APP_PIN_ROW_ID, **row}).execute()
    else:
        table.update(row).eq("id", APP_PIN_ROW_ID).execute()


@router.get("/status")
async def pin_status():
    """Whether a PIN has been configured (does not reveal the hash)."""
    try:
        return {"configured": bool(_get_existing_hash())}
    except Exception as e:
        err = str(e).lower()
        if "relation" in err and "app_pin" in err:
            raise HTTPException(
                status_code=503,
                detail='Database table "app_pin" is missing. Run supabase_app_pin.sql in Supabase.',
            )
        raise


@router.post("/verify")
async def pin_verify(body: PinVerifyBody, request: Request):
    """Check PIN against stored hash. Rate-limited to deter brute force."""
    key = get_client_ip(request)
    _lockout.check(key)

    stored = _get_existing_hash()
    if not stored:
        raise HTTPException(status_code=400, detail="No PIN has been set yet")
    if not verify_password(body.pin, stored):
        _lockout.record_failure(key)
        raise HTTPException(status_code=401, detail="Incorrect PIN")
    _lockout.clear(key)
    return {"ok": True, "token": create_token()}


@router.post("/setup")
async def pin_setup(body: PinSetupBody):
    """First-time PIN creation (only when none exists)."""
    if body.pin != body.confirm_pin:
        raise HTTPException(status_code=400, detail="PINs do not match")
    if _get_existing_hash():
        raise HTTPException(status_code=400, detail="A PIN is already set. Use change PIN instead.")

    _store_hash(body.pin, insert=True)
    return {"ok": True, "token": create_token()}


@router.post("/change")
async def pin_change(body: PinChangeBody):
    """Replace PIN; requires current PIN."""
    if body.new_pin != body.confirm_pin:
        raise HTTPException(status_code=400, detail="New PINs do not match")
    if body.new_pin == body.current_pin:
        raise HTTPException(status_code=400, detail="New PIN must be different from the current PIN")

    stored = _get_existing_hash()
    if not stored:
        raise HTTPException(status_code=400, detail="No PIN has been set yet")
    if not verify_password(body.current_pin, stored):
        raise HTTPException(status_code=401, detail="Current PIN is incorrect")

    _store_hash(body.new_pin, insert=False)
    return {"ok": True}

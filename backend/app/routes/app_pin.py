from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
from passlib.context import CryptContext
from app.database import get_supabase

router = APIRouter(prefix="/app-pin", tags=["app-pin"])

APP_PIN_ROW_ID = "default"
_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _normalize_pin(pin: str) -> str:
    p = (pin or "").strip()
    if not p:
        raise HTTPException(status_code=400, detail="PIN is required")
    if len(p) < 4 or len(p) > 64:
        raise HTTPException(status_code=400, detail="PIN must be between 4 and 64 characters")
    return p


class PinVerifyBody(BaseModel):
    pin: str = Field(..., min_length=1, max_length=64)

    @field_validator("pin")
    @classmethod
    def strip_pin(cls, v: str) -> str:
        return (v or "").strip()


class PinSetupBody(BaseModel):
    pin: str = Field(..., min_length=1, max_length=64)
    confirm_pin: str = Field(..., min_length=1, max_length=64)

    @field_validator("pin", "confirm_pin")
    @classmethod
    def strip_fields(cls, v: str) -> str:
        return (v or "").strip()


class PinChangeBody(BaseModel):
    current_pin: str = Field(..., min_length=1, max_length=64)
    new_pin: str = Field(..., min_length=1, max_length=64)
    confirm_pin: str = Field(..., min_length=1, max_length=64)

    @field_validator("current_pin", "new_pin", "confirm_pin")
    @classmethod
    def strip_fields(cls, v: str) -> str:
        return (v or "").strip()


def _get_existing_hash() -> Optional[str]:
    supabase = get_supabase()
    response = supabase.table("app_pin").select("pin_hash").eq("id", APP_PIN_ROW_ID).limit(1).execute()
    rows = response.data or []
    if not rows:
        return None
    return rows[0].get("pin_hash")


@router.get("/status")
async def pin_status():
    """Whether a PIN has been configured (does not reveal the hash)."""
    try:
        h = _get_existing_hash()
        return {"configured": bool(h)}
    except Exception as e:
        err = str(e).lower()
        if "relation" in err and "app_pin" in err:
            raise HTTPException(
                status_code=503,
                detail='Database table "app_pin" is missing. Run supabase_app_pin.sql in Supabase.',
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/verify")
async def pin_verify(body: PinVerifyBody):
    """Check PIN against stored hash."""
    pin = _normalize_pin(body.pin)
    stored = _get_existing_hash()
    if not stored:
        raise HTTPException(status_code=400, detail="No PIN has been set yet")
    if not _pwd_context.verify(pin, stored):
        raise HTTPException(status_code=401, detail="Incorrect PIN")
    return {"ok": True}


@router.post("/setup")
async def pin_setup(body: PinSetupBody):
    """First-time PIN creation (only when none exists)."""
    pin = _normalize_pin(body.pin)
    confirm = _normalize_pin(body.confirm_pin)
    if pin != confirm:
        raise HTTPException(status_code=400, detail="PINs do not match")

    if _get_existing_hash():
        raise HTTPException(status_code=400, detail="A PIN is already set. Use change PIN instead.")

    pin_hash = _pwd_context.hash(pin)
    now = datetime.now(timezone.utc).isoformat()
    supabase = get_supabase()
    supabase.table("app_pin").insert(
        {"id": APP_PIN_ROW_ID, "pin_hash": pin_hash, "updated_at": now}
    ).execute()
    return {"ok": True}


@router.post("/change")
async def pin_change(body: PinChangeBody):
    """Replace PIN; requires current PIN."""
    current = _normalize_pin(body.current_pin)
    new_pin = _normalize_pin(body.new_pin)
    confirm = _normalize_pin(body.confirm_pin)
    if new_pin != confirm:
        raise HTTPException(status_code=400, detail="New PINs do not match")
    if new_pin == current:
        raise HTTPException(status_code=400, detail="New PIN must be different from the current PIN")

    stored = _get_existing_hash()
    if not stored:
        raise HTTPException(status_code=400, detail="No PIN has been set yet")

    if not _pwd_context.verify(current, stored):
        raise HTTPException(status_code=401, detail="Current PIN is incorrect")

    pin_hash = _pwd_context.hash(new_pin)
    now = datetime.now(timezone.utc).isoformat()
    supabase = get_supabase()
    supabase.table("app_pin").update({"pin_hash": pin_hash, "updated_at": now}).eq("id", APP_PIN_ROW_ID).execute()
    return {"ok": True}

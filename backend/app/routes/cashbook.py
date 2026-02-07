from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from datetime import date
from app.database import get_supabase
from app.models import (
    CashbookEntryCreate,
    CashbookEntryUpdate,
    CashbookSettingsUpdate,
)

router = APIRouter(prefix="/cashbook", tags=["cashbook"])

ENTRY_TYPES = {"inflow", "outflow"}


def _normalize_entry_payload(payload: dict) -> dict:
    if "entry_date" in payload and payload["entry_date"] is not None:
        if isinstance(payload["entry_date"], date):
            payload["entry_date"] = payload["entry_date"].isoformat()
    if "entry_type" in payload and payload["entry_type"] is not None:
        payload["entry_type"] = str(payload["entry_type"]).strip().lower()
    return payload


@router.get("/entries", response_model=List[dict])
async def get_cashbook_entries(
    start_date: Optional[date] = Query(None, description="Filter from entry_date (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Filter to entry_date (YYYY-MM-DD)"),
):
    try:
        supabase = get_supabase()
        query = (
            supabase.table("cashbook_entries")
            .select("*")
            .order("entry_date", desc=False)
            .order("created_at", desc=False)
        )
        if start_date:
            query = query.gte("entry_date", start_date.isoformat())
        if end_date:
            query = query.lte("entry_date", end_date.isoformat())
        response = query.execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/entries", response_model=dict)
async def create_cashbook_entry(entry: CashbookEntryCreate):
    try:
        payload = _normalize_entry_payload(entry.model_dump())
        entry_type = payload.get("entry_type")
        if entry_type not in ENTRY_TYPES:
            raise HTTPException(status_code=400, detail="entry_type must be inflow or outflow")
        if payload.get("amount") is None or float(payload["amount"]) <= 0:
            raise HTTPException(status_code=400, detail="amount must be greater than 0")

        supabase = get_supabase()
        response = supabase.table("cashbook_entries").insert(payload).execute()
        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to create cashbook entry")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/entries/{entry_id}", response_model=dict)
async def update_cashbook_entry(entry_id: str, entry: CashbookEntryUpdate):
    try:
        payload = _normalize_entry_payload(entry.model_dump(exclude_unset=True))
        if "entry_type" in payload and payload["entry_type"] not in ENTRY_TYPES:
            raise HTTPException(status_code=400, detail="entry_type must be inflow or outflow")
        if "amount" in payload and (payload["amount"] is None or float(payload["amount"]) <= 0):
            raise HTTPException(status_code=400, detail="amount must be greater than 0")
        if not payload:
            raise HTTPException(status_code=400, detail="No fields to update")

        supabase = get_supabase()
        response = supabase.table("cashbook_entries").update(payload).eq("id", entry_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Cashbook entry not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/entries/{entry_id}", response_model=dict)
async def delete_cashbook_entry(entry_id: str):
    try:
        supabase = get_supabase()
        response = supabase.table("cashbook_entries").delete().eq("id", entry_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Cashbook entry not found")
        return {"status": "deleted", "id": entry_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/settings", response_model=dict)
async def get_cashbook_settings():
    try:
        supabase = get_supabase()
        response = supabase.table("cashbook_settings").select("*").limit(1).execute()
        if response.data:
            return response.data[0]
        created = supabase.table("cashbook_settings").insert({"opening_balance": 0}).execute()
        if not created.data:
            raise HTTPException(status_code=500, detail="Failed to create default settings")
        return created.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/settings", response_model=dict)
async def update_cashbook_settings(settings: CashbookSettingsUpdate):
    try:
        supabase = get_supabase()
        existing = supabase.table("cashbook_settings").select("id").limit(1).execute()
        payload = {"opening_balance": float(settings.opening_balance)}
        if existing.data:
            settings_id = existing.data[0]["id"]
            response = supabase.table("cashbook_settings").update(payload).eq("id", settings_id).execute()
            if not response.data:
                raise HTTPException(status_code=500, detail="Failed to update settings")
            return response.data[0]
        created = supabase.table("cashbook_settings").insert(payload).execute()
        if not created.data:
            raise HTTPException(status_code=500, detail="Failed to create settings")
        return created.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

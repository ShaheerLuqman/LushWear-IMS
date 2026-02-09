from fastapi import APIRouter, HTTPException
from typing import List
from datetime import date
from app.database import get_supabase
from app.models import (
    LedgerCreate,
    LedgerUpdate,
    LedgerEntryCreate,
    LedgerEntryUpdate,
)

router = APIRouter(prefix="/ledgers", tags=["ledgers"])


def _normalize_entry_payload(payload: dict) -> dict:
    if "entry_date" in payload and payload["entry_date"] is not None:
        if isinstance(payload["entry_date"], date):
            payload["entry_date"] = payload["entry_date"].isoformat()
    return payload


# ==================== LEDGER CRUD ====================


@router.get("/", response_model=List[dict])
async def list_ledgers():
    try:
        supabase = get_supabase()
        response = (
            supabase.table("ledgers")
            .select("*")
            .order("name", desc=False)
            .execute()
        )
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/", response_model=dict)
async def create_ledger(ledger: LedgerCreate):
    try:
        name = (ledger.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Ledger name is required")
        section = (ledger.section or "").strip()
        if not section:
            raise HTTPException(status_code=400, detail="Section is required")

        supabase = get_supabase()
        response = supabase.table("ledgers").insert({"name": name, "section": section}).execute()
        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to create ledger")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{ledger_id}", response_model=dict)
async def get_ledger(ledger_id: str):
    try:
        supabase = get_supabase()
        response = (
            supabase.table("ledgers")
            .select("*")
            .eq("id", ledger_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Ledger not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{ledger_id}", response_model=dict)
async def update_ledger(ledger_id: str, ledger: LedgerUpdate):
    try:
        payload = ledger.model_dump(exclude_unset=True)
        if "name" in payload:
            payload["name"] = (payload["name"] or "").strip()
            if not payload["name"]:
                raise HTTPException(status_code=400, detail="Ledger name cannot be empty")
        if "section" in payload:
            payload["section"] = (payload["section"] or "").strip()
            if not payload["section"]:
                raise HTTPException(status_code=400, detail="Section cannot be empty")
        if not payload:
            raise HTTPException(status_code=400, detail="No fields to update")

        supabase = get_supabase()
        response = (
            supabase.table("ledgers")
            .update(payload)
            .eq("id", ledger_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Ledger not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{ledger_id}", response_model=dict)
async def delete_ledger(ledger_id: str):
    try:
        supabase = get_supabase()
        response = (
            supabase.table("ledgers")
            .delete()
            .eq("id", ledger_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Ledger not found")
        return {"status": "deleted", "id": ledger_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==================== LEDGER ENTRIES CRUD ====================


@router.get("/{ledger_id}/entries", response_model=List[dict])
async def list_ledger_entries(ledger_id: str):
    try:
        supabase = get_supabase()
        response = (
            supabase.table("ledger_entries")
            .select("*")
            .eq("ledger_id", ledger_id)
            .order("entry_date", desc=False)
            .order("created_at", desc=False)
            .execute()
        )
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{ledger_id}/entries", response_model=dict)
async def create_ledger_entry(ledger_id: str, entry: LedgerEntryCreate):
    try:
        payload = _normalize_entry_payload(entry.model_dump())
        payload["ledger_id"] = ledger_id

        incoming = float(payload.get("incoming") or 0)
        outgoing = float(payload.get("outgoing") or 0)
        if incoming < 0 or outgoing < 0:
            raise HTTPException(status_code=400, detail="Amounts cannot be negative")
        if incoming == 0 and outgoing == 0:
            raise HTTPException(status_code=400, detail="At least one of incoming or outgoing must be greater than 0")

        supabase = get_supabase()
        response = supabase.table("ledger_entries").insert(payload).execute()
        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to create ledger entry")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{ledger_id}/entries/{entry_id}", response_model=dict)
async def update_ledger_entry(ledger_id: str, entry_id: str, entry: LedgerEntryUpdate):
    try:
        payload = _normalize_entry_payload(entry.model_dump(exclude_unset=True))
        if not payload:
            raise HTTPException(status_code=400, detail="No fields to update")

        supabase = get_supabase()
        response = (
            supabase.table("ledger_entries")
            .update(payload)
            .eq("id", entry_id)
            .eq("ledger_id", ledger_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Ledger entry not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{ledger_id}/entries/{entry_id}", response_model=dict)
async def delete_ledger_entry(ledger_id: str, entry_id: str):
    try:
        supabase = get_supabase()
        response = (
            supabase.table("ledger_entries")
            .delete()
            .eq("id", entry_id)
            .eq("ledger_id", ledger_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Ledger entry not found")
        return {"status": "deleted", "id": entry_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

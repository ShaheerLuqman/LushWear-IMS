from fastapi import APIRouter, HTTPException
from typing import List
from app.database import get_supabase
from app.models import (
    LedgerCreate,
    LedgerUpdate,
)

router = APIRouter(prefix="/ledgers", tags=["ledgers"])


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
        # Check if any cashbook entries reference this ledger
        entries_resp = (
            supabase.table("cashbook_entries")
            .select("id")
            .eq("folio", ledger_id)
            .limit(1)
            .execute()
        )
        if entries_resp.data:
            raise HTTPException(
                status_code=400, 
                detail="Cannot delete ledger: it has cashbook entries linked to it"
            )
        
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


# ==================== LEDGER ENTRIES (derived from cashbook) ====================
# Ledger entries are now derived from cashbook_entries where folio = ledger_id
# This endpoint returns cashbook entries linked to this ledger


@router.get("/{ledger_id}/entries", response_model=List[dict])
async def list_ledger_entries(ledger_id: str):
    """
    Get all cashbook entries linked to this ledger (via folio).
    Returns entries with incoming/outgoing calculated from entry_type.
    """
    try:
        supabase = get_supabase()
        response = (
            supabase.table("cashbook_entries")
            .select("*")
            .eq("folio", ledger_id)
            .order("entry_date", desc=False)
            .order("created_at", desc=False)
            .execute()
        )
        
        # Transform cashbook entries to ledger entry format
        entries = []
        for entry in response.data or []:
            amount = float(entry.get("amount") or 0)
            entry_type = entry.get("entry_type", "")
            entries.append({
                "id": entry["id"],
                "ledger_id": ledger_id,
                "entry_date": entry["entry_date"],
                "particulars": entry.get("description") or "",
                "incoming": amount if entry_type == "inflow" else 0,
                "outgoing": amount if entry_type == "outflow" else 0,
                "created_at": entry.get("created_at"),
                "updated_at": entry.get("updated_at"),
            })
        
        return entries
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

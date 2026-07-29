from fastapi import APIRouter, HTTPException
from typing import List
from app.database import get_supabase
from app.models import (
    Ledger,
    LedgerCreate,
    LedgerUpdate,
)

router = APIRouter(prefix="/ledgers", tags=["ledgers"])


def _flatten_ledger_balance(row: dict) -> dict:
    """Collapse the embedded ledger_balances(balance) relation into a flat
    `balance` field; missing (no entries yet) defaults to 0."""
    embedded = row.pop("ledger_balances", None)
    row["balance"] = float(embedded["balance"]) if embedded else 0.0
    return row


def _name_taken(supabase, name: str, exclude_id: str = None) -> bool:
    """Case-insensitive name clash check (mirrors findLedgerByName in
    renderer.js). Backstopped by idx_ledgers_name_lower for races/non-API
    writers; this just gives a friendly error for the common case."""
    target = name.strip().lower()
    resp = supabase.table("ledgers").select("id, name").execute()
    return any(
        row["id"] != exclude_id and (row.get("name") or "").strip().lower() == target
        for row in resp.data or []
    )


@router.get("/", response_model=List[Ledger])
async def list_ledgers():
    response = (
        get_supabase()
        .table("ledgers")
        .select("*, ledger_balances(balance)")
        .order("name", desc=False)
        .execute()
    )
    return [_flatten_ledger_balance(row) for row in response.data]


@router.post("/", response_model=Ledger)
async def create_ledger(ledger: LedgerCreate):
    name = (ledger.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Ledger name is required")
    if not ledger.type:
        raise HTTPException(status_code=400, detail="Type is required")

    supabase = get_supabase()
    if _name_taken(supabase, name):
        raise HTTPException(status_code=400, detail="A ledger with this name already exists")

    response = supabase.table("ledgers").insert({
        "name": name,
        "type": ledger.type,
        "include_in_cash_in_hand": ledger.include_in_cash_in_hand,
        "opening_balance": ledger.opening_balance,
    }).execute()
    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create ledger")
    return response.data[0]


@router.get("/{ledger_id}", response_model=Ledger)
async def get_ledger(ledger_id: str):
    supabase = get_supabase()
    response = (
        supabase
        .table("ledgers")
        .select("*")
        .eq("id", ledger_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")

    entries_resp = (
        supabase.table("cashbook_entries")
        .select("id")
        .eq("folio", ledger_id)
        .limit(1)
        .execute()
    )
    ledger = response.data[0]
    ledger["has_entries"] = bool(entries_resp.data)
    return ledger


@router.put("/{ledger_id}", response_model=Ledger)
async def update_ledger(ledger_id: str, ledger: LedgerUpdate):
    supabase = get_supabase()
    payload = ledger.model_dump(exclude_unset=True)
    if "name" in payload:
        payload["name"] = (payload["name"] or "").strip()
        if not payload["name"]:
            raise HTTPException(status_code=400, detail="Ledger name cannot be empty")
        if _name_taken(supabase, payload["name"], exclude_id=ledger_id):
            raise HTTPException(status_code=400, detail="A ledger with this name already exists")
    if "type" in payload and not payload["type"]:
        raise HTTPException(status_code=400, detail="Type cannot be empty")
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    response = (
        supabase
        .table("ledgers")
        .update(payload)
        .eq("id", ledger_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")
    return response.data[0]


@router.delete("/{ledger_id}", response_model=dict)
async def delete_ledger(ledger_id: str):
    supabase = get_supabase()
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
            detail="Cannot delete ledger: it has cashbook entries linked to it",
        )

    response = supabase.table("ledgers").delete().eq("id", ledger_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")
    return {"status": "deleted", "id": ledger_id}


@router.get("/{ledger_id}/entries", response_model=List[dict])
async def list_ledger_entries(ledger_id: str):
    """Cashbook entries linked to this ledger (via folio), as ledger-format rows."""
    response = (
        get_supabase()
        .table("cashbook_entries")
        .select("*")
        .eq("folio", ledger_id)
        .order("entry_date", desc=False)
        .order("created_at", desc=False)
        .execute()
    )

    entries = []
    for entry in response.data or []:
        amount = float(entry.get("amount") or 0)
        entry_type = entry.get("entry_type", "")
        entries.append({
            "id": entry["id"],
            "ledger_id": ledger_id,
            "entry_date": entry["entry_date"],
            "particulars": entry.get("description") or "",
            "incoming": amount if entry_type == "credit" else 0,
            "outgoing": amount if entry_type == "debit" else 0,
            "created_at": entry.get("created_at"),
            "updated_at": entry.get("updated_at"),
        })
    return entries

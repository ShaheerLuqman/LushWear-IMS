from fastapi import APIRouter, Depends, HTTPException
from typing import List, Literal
from pydantic import BaseModel
from app.auth import get_org_id
from app.database import get_supabase
from app.models import (
    Ledger,
    LedgerCreate,
    LedgerUpdate,
)
from app.org_scope import org_table


class DeleteLedgerResult(BaseModel):
    status: Literal["deleted"]
    id: str

router = APIRouter(prefix="/ledgers", tags=["ledgers"])


def _flatten_ledger_balance(row: dict) -> dict:
    """Collapse the embedded ledger_balances(balance) relation into a flat
    `balance` field; missing (no entries yet) defaults to 0."""
    embedded = row.pop("ledger_balances", None)
    row["balance"] = float(embedded["balance"]) if embedded else 0.0
    return row


def _orders_ledger_taken(supabase, org_id: str, exclude_id: str = None) -> bool:
    """Whether this org already has an Orders ledger. Backstopped by
    idx_ledgers_one_orders_ledger_per_org for races/non-API writers; this just
    turns the common case into a message instead of a constraint violation.
    The role is deliberately not moved automatically - silently unsetting the
    previous Orders ledger would retarget every future advance with no trace."""
    resp = (
        org_table(supabase, org_id, "ledgers")
        .select("id")
        .eq("is_orders_ledger", True)
        .execute()
    )
    return any(row["id"] != exclude_id for row in resp.data or [])


def _is_system_cash(supabase, org_id: str, ledger_id: str) -> bool:
    resp = (
        org_table(supabase, org_id, "ledgers")
        .select("system_key")
        .eq("id", ledger_id)
        .limit(1)
        .execute()
    )
    return bool(resp.data) and resp.data[0].get("system_key") == "cash"


def _name_taken(supabase, org_id: str, name: str, exclude_id: str = None) -> bool:
    """Case-insensitive name clash check within this org (mirrors findLedgerByName
    in renderer.js). Backstopped by idx_ledgers_org_id_name_lower for races/non-API
    writers; this just gives a friendly error for the common case."""
    target = name.strip().lower()
    resp = org_table(supabase, org_id, "ledgers").select("id, name").execute()
    return any(
        row["id"] != exclude_id and (row.get("name") or "").strip().lower() == target
        for row in resp.data or []
    )


@router.get("/", response_model=List[Ledger])
async def list_ledgers(org_id: str = Depends(get_org_id)):
    response = (
        org_table(get_supabase(), org_id, "ledgers")
        .select("*, ledger_balances(balance)")
        .order("name", desc=False)
        .execute()
    )
    return [_flatten_ledger_balance(row) for row in response.data]


@router.post("/", response_model=Ledger)
async def create_ledger(ledger: LedgerCreate, org_id: str = Depends(get_org_id)):
    name = (ledger.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Ledger name is required")
    if not ledger.type:
        raise HTTPException(status_code=400, detail="Type is required")

    supabase = get_supabase()
    if _name_taken(supabase, org_id, name):
        raise HTTPException(status_code=400, detail="A ledger with this name already exists")
    if ledger.is_orders_ledger and _orders_ledger_taken(supabase, org_id):
        raise HTTPException(
            status_code=400,
            detail="Another ledger is already the Orders ledger. Unset it first.",
        )

    response = org_table(supabase, org_id, "ledgers").insert({
        "name": name,
        "type": ledger.type,
        "include_in_cash_in_hand": ledger.include_in_cash_in_hand,
        "opening_balance": ledger.opening_balance,
        "report_category": ledger.report_category,
        "is_orders_ledger": ledger.is_orders_ledger,
    }).execute()
    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create ledger")
    return response.data[0]


@router.get("/{ledger_id}", response_model=Ledger)
async def get_ledger(ledger_id: str, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    response = (
        org_table(supabase, org_id, "ledgers")
        .select("*")
        .eq("id", ledger_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")

    entries_resp = (
        org_table(supabase, org_id, "cashbook_entries")
        .select("id")
        .eq("folio", ledger_id)
        .limit(1)
        .execute()
    )
    ledger = response.data[0]
    ledger["has_entries"] = bool(entries_resp.data)
    return ledger


@router.put("/{ledger_id}", response_model=Ledger)
async def update_ledger(ledger_id: str, ledger: LedgerUpdate, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    payload = ledger.model_dump(exclude_unset=True)
    if "name" in payload:
        payload["name"] = (payload["name"] or "").strip()
        if not payload["name"]:
            raise HTTPException(status_code=400, detail="Ledger name cannot be empty")
        if _name_taken(supabase, org_id, payload["name"], exclude_id=ledger_id):
            raise HTTPException(status_code=400, detail="A ledger with this name already exists")
    if "type" in payload and not payload["type"]:
        raise HTTPException(status_code=400, detail="Type cannot be empty")
    if payload.get("is_orders_ledger") and _orders_ledger_taken(supabase, org_id, exclude_id=ledger_id):
        raise HTTPException(
            status_code=400,
            detail="Another ledger is already the Orders ledger. Unset it first.",
        )
    if payload.get("include_in_cash_in_hand") and _is_system_cash(supabase, org_id, ledger_id):
        # Cash In Hand already counts this account once, via the cashbook's
        # closing balance (getPhysicalCashInHand in ledgers.js) — including it
        # again here would silently double the headline figure. Tempting to tick
        # precisely because of the account's name, so it is blocked rather than
        # documented.
        raise HTTPException(
            status_code=400,
            detail="The Cash account is already counted in Cash In Hand.",
        )
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    response = (
        org_table(supabase, org_id, "ledgers")
        .update(payload)
        .eq("id", ledger_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")
    return response.data[0]


@router.delete("/{ledger_id}", response_model=DeleteLedgerResult)
async def delete_ledger(ledger_id: str, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    entries_resp = (
        org_table(supabase, org_id, "cashbook_entries")
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

    response = org_table(supabase, org_id, "ledgers").delete().eq("id", ledger_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")
    return {"status": "deleted", "id": ledger_id}


@router.get("/{ledger_id}/entries", response_model=List[dict])
async def list_ledger_entries(ledger_id: str, org_id: str = Depends(get_org_id)):
    """Cashbook entries linked to this ledger (via folio), as ledger-format rows.

    entry_type is already the folio ledger's own side (see "THE TWO PERSPECTIVES"
    in supabase_schema.sql), so it maps straight across here - no inversion. The
    Cashbook screen is the one that reads these entries from cash's side."""
    response = (
        org_table(get_supabase(), org_id, "cashbook_entries")
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
            "debit": amount if entry_type == "debit" else 0,
            "credit": amount if entry_type == "credit" else 0,
            "created_at": entry.get("created_at"),
            "updated_at": entry.get("updated_at"),
        })
    return entries

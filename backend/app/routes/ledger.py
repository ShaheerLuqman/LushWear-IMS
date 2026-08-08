from fastapi import APIRouter, Depends, HTTPException
from typing import List, Literal
from pydantic import BaseModel
from app.auth import get_org_id
from app.database import get_supabase
from app.ledger_roles import SYSTEM_LEDGER_LABELS
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
    """Collapse the embedded finances_ledger_balances(balance) relation into a flat
    `balance` field; missing (no entries yet) defaults to 0."""
    embedded = row.pop("finances_ledger_balances", None)
    row["balance"] = float(embedded["balance"]) if embedded else 0.0
    return row


def _system_key(supabase, org_id: str, ledger_id: str):
    """This ledger's system role, or None for an ordinary account."""
    resp = (
        org_table(supabase, org_id, "finances_ledgers")
        .select("system_key")
        .eq("id", ledger_id)
        .limit(1)
        .execute()
    )
    return resp.data[0].get("system_key") if resp.data else None


def _name_taken(supabase, org_id: str, name: str, exclude_id: str = None) -> bool:
    """Case-insensitive name clash check within this org (mirrors findLedgerByName
    in renderer.js). Backstopped by idx_ledgers_org_id_name_lower for races/non-API
    writers; this just gives a friendly error for the common case."""
    target = name.strip().lower()
    resp = org_table(supabase, org_id, "finances_ledgers").select("id, name").execute()
    return any(
        row["id"] != exclude_id and (row.get("name") or "").strip().lower() == target
        for row in resp.data or []
    )


@router.get("/", response_model=List[Ledger])
async def list_ledgers(org_id: str = Depends(get_org_id)):
    response = (
        org_table(get_supabase(), org_id, "finances_ledgers")
        .select("*, finances_ledger_balances(balance)")
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

    response = org_table(supabase, org_id, "finances_ledgers").insert({
        "name": name,
        "type": ledger.type,
        "include_in_cash_in_hand": ledger.include_in_cash_in_hand,
        "opening_balance": ledger.opening_balance,
        "report_category": ledger.report_category,
    }).execute()
    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create ledger")
    return response.data[0]


@router.get("/{ledger_id}", response_model=Ledger)
async def get_ledger(ledger_id: str, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    response = (
        org_table(supabase, org_id, "finances_ledgers")
        .select("*")
        .eq("id", ledger_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")

    # Journal lines, matching what delete_ledger actually refuses on: an account
    # can be posted to by a bill or a manual entry as well as by the cashbook.
    lines_resp = (
        org_table(supabase, org_id, "finances_journal_lines")
        .select("id")
        .eq("account_id", ledger_id)
        .limit(1)
        .execute()
    )
    ledger = response.data[0]
    ledger["has_entries"] = bool(lines_resp.data)
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
    if payload.get("include_in_cash_in_hand") and _system_key(supabase, org_id, ledger_id) == "cash":
        # Cash In Hand already counts this account once, via its own balance
        # (getPhysicalCashInHand in ledgers.js) — including it again here would
        # silently double the headline figure. Tempting to tick
        # precisely because of the account's name, so it is blocked rather than
        # documented.
        raise HTTPException(
            status_code=400,
            detail="The Cash account is already counted in Cash In Hand.",
        )
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    response = (
        org_table(supabase, org_id, "finances_ledgers")
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

    role = _system_key(supabase, org_id, ledger_id)
    if role:
        raise HTTPException(
            status_code=400,
            detail=f"{SYSTEM_LEDGER_LABELS.get(role, role)} is a system account and cannot be deleted.",
        )

    # Journal lines, not cashbook entries: since Phase 1 an account can also be
    # posted to by a bill or a manual entry, and those would otherwise only be
    # caught by the ON DELETE RESTRICT foreign key, as a raw database error.
    lines_resp = (
        org_table(supabase, org_id, "finances_journal_lines")
        .select("id")
        .eq("account_id", ledger_id)
        .limit(1)
        .execute()
    )
    if lines_resp.data:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete ledger: it has entries posted against it",
        )

    response = org_table(supabase, org_id, "finances_ledgers").delete().eq("id", ledger_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Ledger not found")
    return {"status": "deleted", "id": ledger_id}


@router.get("/{ledger_id}/entries", response_model=List[dict])
async def list_ledger_entries(ledger_id: str, org_id: str = Depends(get_org_id)):
    """This account's journal lines, as a statement.

    Reads the journal rather than cashbook_entries, so everything that moves the
    balance also explains itself: cashbook entries, purchase bills, manual
    journal entries and the opening balance are all lines on the same account.
    Reading cashbook_entries left a received bill changing the supplier's balance
    with no row to account for it.

    The opening balance arrives as a real line here (Phase 1 posts it against
    Opening Balance Equity), so the statement must not synthesise another one."""
    resp = get_supabase().rpc("get_ledger_statement", {
        "p_org_id": org_id,
        "p_ledger_id": ledger_id,
    }).execute()

    return [
        {
            "id": row["id"],
            "ledger_id": ledger_id,
            "entry_date": row["entry_date"],
            "particulars": row.get("particulars") or "",
            "debit": float(row.get("debit") or 0),
            "credit": float(row.get("credit") or 0),
            "voucher_type": row.get("voucher_type"),
            "source_type": row.get("source_type"),
        }
        for row in resp.data or []
    ]

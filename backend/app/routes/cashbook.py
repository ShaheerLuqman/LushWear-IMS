from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from datetime import date, timedelta
from app.database import get_supabase
from app.models import (
    CashbookEntryCreate,
    CashbookEntryUpdate,
)
from app.advance_status import recompute_advance_statuses

router = APIRouter(prefix="/cashbook", tags=["cashbook"])

ENTRY_TYPES = {"inflow", "outflow"}


def _normalize_entry_payload(payload: dict, is_create: bool = False) -> dict:
    if "entry_date" in payload and payload["entry_date"] is not None:
        if isinstance(payload["entry_date"], date):
            payload["entry_date"] = payload["entry_date"].isoformat()
    if "entry_type" in payload and payload["entry_type"] is not None:
        payload["entry_type"] = str(payload["entry_type"]).strip().lower()
    # Folio is required - normalize to string UUID
    if "folio" in payload:
        if payload["folio"] is not None:
            payload["folio"] = str(payload["folio"]).strip() or None
        # On create, folio cannot be null/empty
        if is_create and not payload.get("folio"):
            raise ValueError("folio is required")
    # order_number: only set for order-advance entries; normalize empty to null
    if "order_number" in payload:
        if payload["order_number"] is not None:
            payload["order_number"] = str(payload["order_number"]).strip().lstrip("#") or None
    return payload


async def _recalculate_daily_balance(supabase, target_date: str):
    """Recalculate and upsert daily balance for a specific date."""
    # Get all entries for this date
    entries_resp = supabase.table("cashbook_entries").select("entry_type, amount").eq("entry_date", target_date).execute()
    entries = entries_resp.data or []
    
    total_inflow = sum(float(e["amount"]) for e in entries if e["entry_type"] == "inflow")
    total_outflow = sum(float(e["amount"]) for e in entries if e["entry_type"] == "outflow")
    
    # Get opening balance (previous day's closing balance)
    prev_date = (date.fromisoformat(target_date) - timedelta(days=1)).isoformat()
    prev_balance_resp = supabase.table("cashbook_daily_balances").select("closing_balance").eq("balance_date", prev_date).limit(1).execute()
    
    if prev_balance_resp.data:
        opening_balance = float(prev_balance_resp.data[0]["closing_balance"])
    else:
        opening_balance = 0.0
    
    closing_balance = opening_balance + total_inflow - total_outflow
    
    # Check if balance record exists for this date
    existing = supabase.table("cashbook_daily_balances").select("id").eq("balance_date", target_date).limit(1).execute()
    
    balance_data = {
        "balance_date": target_date,
        "opening_balance": opening_balance,
        "total_inflow": total_inflow,
        "total_outflow": total_outflow,
        "closing_balance": closing_balance,
    }
    
    if existing.data:
        # Update existing record
        supabase.table("cashbook_daily_balances").update(balance_data).eq("id", existing.data[0]["id"]).execute()
    elif total_inflow > 0 or total_outflow > 0:
        # Insert new record only if there are entries
        supabase.table("cashbook_daily_balances").insert(balance_data).execute()
    
    return closing_balance


async def _recalculate_balances_from_date(supabase, from_date: str):
    """Recalculate daily balances from a specific date onwards."""
    # Get all dates with entries from this date onwards
    entries_resp = (
        supabase.table("cashbook_entries")
        .select("entry_date")
        .gte("entry_date", from_date)
        .order("entry_date", desc=False)
        .execute()
    )
    
    # Get unique dates
    dates = sorted(set(e["entry_date"] for e in (entries_resp.data or [])))
    
    # Also get dates from daily_balances that might need updating
    balances_resp = (
        supabase.table("cashbook_daily_balances")
        .select("balance_date")
        .gte("balance_date", from_date)
        .execute()
    )
    balance_dates = set(b["balance_date"] for b in (balances_resp.data or []))
    
    # Combine and sort all dates
    all_dates = sorted(set(dates) | balance_dates)
    
    # Recalculate each date in order
    for d in all_dates:
        await _recalculate_daily_balance(supabase, d)


@router.get("/entries", response_model=List[dict])
async def get_cashbook_entries(
    start_date: Optional[date] = Query(None, description="Filter from entry_date (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Filter to entry_date (YYYY-MM-DD)"),
):
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


@router.post("/entries", response_model=dict)
async def create_cashbook_entry(entry: CashbookEntryCreate):
    try:
        payload = _normalize_entry_payload(entry.model_dump(), is_create=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    entry_type = payload.get("entry_type")
    if entry_type not in ENTRY_TYPES:
        raise HTTPException(status_code=400, detail="entry_type must be inflow or outflow")
    if payload.get("amount") is None or float(payload["amount"]) <= 0:
        raise HTTPException(status_code=400, detail="amount must be greater than 0")
    if not payload.get("folio"):
        raise HTTPException(status_code=400, detail="folio (ledger) is required")

    supabase = get_supabase()
    response = supabase.table("cashbook_entries").insert(payload).execute()
    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create cashbook entry")

    entry_date = payload.get("entry_date")
    if entry_date:
        await _recalculate_balances_from_date(supabase, entry_date)

    if payload.get("order_number"):
        try:
            recompute_advance_statuses(supabase, [payload["order_number"]])
        except Exception:
            pass

    return response.data[0]


@router.put("/entries/{entry_id}", response_model=dict)
async def update_cashbook_entry(entry_id: str, entry: CashbookEntryUpdate):
    supabase = get_supabase()

    existing_resp = supabase.table("cashbook_entries").select("entry_date, order_number").eq("id", entry_id).limit(1).execute()
    if not existing_resp.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")
    old_date = existing_resp.data[0]["entry_date"]
    old_order_number = existing_resp.data[0].get("order_number")

    try:
        payload = _normalize_entry_payload(entry.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if "entry_type" in payload and payload["entry_type"] not in ENTRY_TYPES:
        raise HTTPException(status_code=400, detail="entry_type must be inflow or outflow")
    if "amount" in payload and (payload["amount"] is None or float(payload["amount"]) <= 0):
        raise HTTPException(status_code=400, detail="amount must be greater than 0")
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    response = supabase.table("cashbook_entries").update(payload).eq("id", entry_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")

    new_date = payload.get("entry_date", old_date)
    earliest_date = min(old_date, new_date)
    await _recalculate_balances_from_date(supabase, earliest_date)

    # Cover both old and new order numbers in case the entry was reassigned.
    new_order_number = payload.get("order_number", old_order_number)
    affected_orders = {n for n in [old_order_number, new_order_number] if n}
    if affected_orders:
        try:
            recompute_advance_statuses(supabase, list(affected_orders))
        except Exception:
            pass

    return response.data[0]


@router.delete("/entries/{entry_id}", response_model=dict)
async def delete_cashbook_entry(entry_id: str):
    supabase = get_supabase()

    existing_resp = supabase.table("cashbook_entries").select("entry_date, order_number").eq("id", entry_id).limit(1).execute()
    if not existing_resp.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")
    entry_date = existing_resp.data[0]["entry_date"]
    order_number = existing_resp.data[0].get("order_number")

    response = supabase.table("cashbook_entries").delete().eq("id", entry_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")

    await _recalculate_balances_from_date(supabase, entry_date)

    if order_number:
        try:
            recompute_advance_statuses(supabase, [order_number])
        except Exception:
            pass

    return {"status": "deleted", "id": entry_id}


@router.get("/daily-balances", response_model=List[dict])
async def get_daily_balances(
    start_date: Optional[date] = Query(None, description="Filter from date (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Filter to date (YYYY-MM-DD)"),
):
    """Get daily balance summaries."""
    supabase = get_supabase()
    query = (
        supabase.table("cashbook_daily_balances")
        .select("*")
        .order("balance_date", desc=False)
    )
    if start_date:
        query = query.gte("balance_date", start_date.isoformat())
    if end_date:
        query = query.lte("balance_date", end_date.isoformat())
    response = query.execute()
    return response.data


@router.get("/daily-balance/{target_date}", response_model=dict)
async def get_daily_balance(target_date: date):
    """Get balance for a specific date."""
    supabase = get_supabase()
    response = (
        supabase.table("cashbook_daily_balances")
        .select("*")
        .eq("balance_date", target_date.isoformat())
        .limit(1)
        .execute()
    )
    if response.data:
        return response.data[0]

    # No record yet: derive opening from the previous day's closing.
    prev_date = (target_date - timedelta(days=1)).isoformat()
    prev_resp = (
        supabase.table("cashbook_daily_balances")
        .select("closing_balance")
        .eq("balance_date", prev_date)
        .limit(1)
        .execute()
    )
    opening = float(prev_resp.data[0]["closing_balance"]) if prev_resp.data else 0.0
    return {
        "balance_date": target_date.isoformat(),
        "opening_balance": opening,
        "total_inflow": 0.0,
        "total_outflow": 0.0,
        "closing_balance": opening,
    }


@router.post("/recalculate-all", response_model=dict)
async def recalculate_all_balances():
    """Recalculate all daily balances from the earliest entry. Use after migration."""
    supabase = get_supabase()
    earliest_resp = (
        supabase.table("cashbook_entries")
        .select("entry_date")
        .order("entry_date", desc=False)
        .limit(1)
        .execute()
    )
    if not earliest_resp.data:
        return {"status": "no entries to recalculate"}

    earliest_date = earliest_resp.data[0]["entry_date"]
    await _recalculate_balances_from_date(supabase, earliest_date)
    return {"status": "recalculated", "from_date": earliest_date}

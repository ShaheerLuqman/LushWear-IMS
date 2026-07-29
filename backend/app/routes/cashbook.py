from fastapi import APIRouter, HTTPException, Query
from typing import List, Optional
from datetime import date, timedelta
from app.database import get_supabase
from app.models import (
    CashbookDailyBalance,
    CashbookDay,
    CashbookEntry,
    CashbookEntryAuditLog,
    CashbookEntryCreate,
    CashbookEntryUpdate,
)
from app.advance_status import recompute_advance_statuses

router = APIRouter(prefix="/cashbook", tags=["cashbook"])

ENTRY_TYPES = {"credit", "debit"}


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
    if "idempotency_key" in payload:
        payload["idempotency_key"] = (str(payload["idempotency_key"]).strip() or None) if payload.get("idempotency_key") else None
    return payload


def _get_entry_meta_or_404(supabase, entry_id: str) -> dict:
    resp = supabase.table("cashbook_entries").select("order_number, folio").eq("id", entry_id).limit(1).execute()
    if not resp.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")
    return resp.data[0]


def _ledger_balances(supabase, ledger_ids) -> List[dict]:
    """Current balance for each ledger_id, piggybacked on write responses so
    the frontend doesn't need a separate fetch to keep Cash In Hand in sync."""
    ids = {lid for lid in ledger_ids if lid}
    if not ids:
        return []
    resp = supabase.table("ledger_balances").select("ledger_id, balance").in_("ledger_id", list(ids)).execute()
    found = {row["ledger_id"]: float(row["balance"]) for row in resp.data or []}
    return [{"ledger_id": lid, "balance": found.get(lid, 0.0)} for lid in ids]


def _safe_recompute_advance_statuses(supabase, order_numbers) -> None:
    """Best-effort: a failure here shouldn't fail the cashbook write that triggered it."""
    try:
        recompute_advance_statuses(supabase, list(order_numbers))
    except Exception:
        pass


def _split_existing_by_idempotency_key(supabase, payloads: List[dict]) -> tuple:
    """Looks up which of these payloads' idempotency_keys already have a row
    (a replayed create). Returns (existing_rows_by_key, payloads_still_to_insert)."""
    keys = [p["idempotency_key"] for p in payloads if p.get("idempotency_key")]
    if not keys:
        return {}, payloads
    resp = supabase.table("cashbook_entries").select("*").in_("idempotency_key", keys).execute()
    existing_by_key = {row["idempotency_key"]: row for row in resp.data or []}
    to_insert = [p for p in payloads if p.get("idempotency_key") not in existing_by_key]
    return existing_by_key, to_insert


@router.get("/entries", response_model=List[CashbookEntry])
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


@router.post("/entries", response_model=CashbookEntry)
async def create_cashbook_entry(entry: CashbookEntryCreate):
    try:
        payload = _normalize_entry_payload(entry.model_dump(), is_create=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    supabase = get_supabase()

    if payload.get("idempotency_key"):
        existing_by_key, _ = _split_existing_by_idempotency_key(supabase, [payload])
        if existing_by_key:
            entry = next(iter(existing_by_key.values()))
            entry["ledger_balances"] = _ledger_balances(supabase, [entry["folio"]])
            return entry

    response = supabase.table("cashbook_entries").insert(payload).execute()
    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create cashbook entry")

    if payload.get("order_number"):
        _safe_recompute_advance_statuses(supabase, [payload["order_number"]])

    entry = response.data[0]
    entry["ledger_balances"] = _ledger_balances(supabase, [payload["folio"]])
    return entry


@router.post("/entries/bulk", response_model=List[CashbookEntry])
async def create_cashbook_entries_bulk(entries: List[CashbookEntryCreate]):
    """One INSERT for the rows that are actually new (used by the bulk-text-
    entry modal and the two-sided/order-advance modals, so a paired entry is
    atomic instead of two racing POSTs). All-or-nothing for that insert:
    relies on the caller having already validated each entry (folio resolved
    against a real ledger, amount > 0) before submitting. Rows whose
    idempotency_key already exists are treated as a replay and returned as-is
    instead of being inserted again."""
    if not entries:
        raise HTTPException(status_code=400, detail="No entries provided")

    try:
        # entry_type/amount/folio are already enforced by CashbookEntryCreate
        # itself (Literal, Field(gt=0), NonBlankStr), so only normalization is
        # needed here, not the manual re-checks create_cashbook_entry has.
        payloads = [_normalize_entry_payload(e.model_dump(), is_create=True) for e in entries]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    supabase = get_supabase()
    existing_by_key, to_insert = _split_existing_by_idempotency_key(supabase, payloads)

    inserted = []
    if to_insert:
        response = supabase.table("cashbook_entries").insert(to_insert).execute()
        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to create cashbook entries")
        inserted = response.data

    order_numbers = {row["order_number"] for row in to_insert if row.get("order_number")}
    if order_numbers:
        _safe_recompute_advance_statuses(supabase, order_numbers)

    result_rows = list(existing_by_key.values()) + inserted
    balances = _ledger_balances(supabase, {row["folio"] for row in payloads})
    for entry in result_rows:
        entry["ledger_balances"] = balances
    return result_rows


@router.put("/entries/{entry_id}", response_model=CashbookEntry)
async def update_cashbook_entry(entry_id: str, entry: CashbookEntryUpdate):
    supabase = get_supabase()
    old_meta = _get_entry_meta_or_404(supabase, entry_id)
    old_order_number = old_meta.get("order_number")
    old_folio = old_meta.get("folio")

    try:
        payload = _normalize_entry_payload(entry.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if "entry_type" in payload and payload["entry_type"] not in ENTRY_TYPES:
        raise HTTPException(status_code=400, detail="entry_type must be credit or debit")
    if "amount" in payload and (payload["amount"] is None or float(payload["amount"]) <= 0):
        raise HTTPException(status_code=400, detail="amount must be greater than 0")
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    response = supabase.table("cashbook_entries").update(payload).eq("id", entry_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")

    # Cover both old and new order numbers in case the entry was reassigned.
    new_order_number = payload.get("order_number", old_order_number)
    affected_orders = {n for n in [old_order_number, new_order_number] if n}
    if affected_orders:
        _safe_recompute_advance_statuses(supabase, affected_orders)

    # Cover both old and new folio in case the entry was moved to another ledger.
    new_folio = payload.get("folio", old_folio)
    entry_out = response.data[0]
    entry_out["ledger_balances"] = _ledger_balances(supabase, {old_folio, new_folio})
    return entry_out


@router.delete("/entries/{entry_id}", response_model=dict)
async def delete_cashbook_entry(entry_id: str):
    supabase = get_supabase()
    old_meta = _get_entry_meta_or_404(supabase, entry_id)
    order_number = old_meta.get("order_number")
    folio = old_meta.get("folio")

    response = supabase.table("cashbook_entries").delete().eq("id", entry_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")

    if order_number:
        _safe_recompute_advance_statuses(supabase, [order_number])

    return {"status": "deleted", "id": entry_id, "ledger_balances": _ledger_balances(supabase, [folio])}


@router.get("/entries/audit-log", response_model=List[CashbookEntryAuditLog])
async def get_cashbook_entry_audit_log(
    entry_id: Optional[str] = Query(None, description="Filter to deletions of one entry"),
    start_date: Optional[date] = Query(None, description="Filter from entry_date (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Filter to entry_date (YYYY-MM-DD)"),
):
    """Deleted cashbook entries, snapshotted by a DB trigger — see
    cashbook_entry_audit_log in supabase_schema.sql. Records what was deleted
    and when, not who (no per-user identity exists yet)."""
    query = (
        get_supabase()
        .table("cashbook_entry_audit_log")
        .select("*")
        .order("deleted_at", desc=True)
    )
    if entry_id:
        query = query.eq("entry_id", entry_id)
    if start_date:
        query = query.gte("entry_date", start_date.isoformat())
    if end_date:
        query = query.lte("entry_date", end_date.isoformat())
    response = query.execute()
    return response.data


def _fetch_daily_balance(supabase, target_date: date) -> dict:
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
        "total_credit": 0.0,
        "total_debit": 0.0,
        "closing_balance": opening,
    }


def _fetch_entries_for_date(supabase, target_date: date) -> list:
    response = (
        supabase.table("cashbook_entries")
        .select("*")
        .eq("entry_date", target_date.isoformat())
        .order("created_at", desc=False)
        .execute()
    )
    return response.data


@router.get("/daily-balance/{target_date}", response_model=CashbookDailyBalance)
async def get_daily_balance(target_date: date):
    """Get balance for a specific date."""
    return _fetch_daily_balance(get_supabase(), target_date)


@router.get("/day/{target_date}", response_model=CashbookDay)
async def get_cashbook_day(target_date: date):
    """Bundles daily-balance + that date's entries — the Cashbook view's two
    always-together reads — into a single request."""
    supabase = get_supabase()
    return {
        "daily_balance": _fetch_daily_balance(supabase, target_date),
        "entries": _fetch_entries_for_date(supabase, target_date),
    }

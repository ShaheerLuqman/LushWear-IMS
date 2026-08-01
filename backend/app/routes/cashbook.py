from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Literal, Optional
from datetime import date, timedelta
from pydantic import BaseModel
from app.auth import get_org_id
from app.database import get_supabase
from app.models import (
    CashbookDailyBalance,
    CashbookDay,
    CashbookEntry,
    CashbookEntryAuditLog,
    CashbookEntryCreate,
    CashbookEntryUpdate,
    LedgerBalance,
)
from app.advance_status import recompute_advance_statuses
from app.org_scope import org_table

router = APIRouter(prefix="/cashbook", tags=["cashbook"])

# The two sides of an entry. NULL on a side means cash, so an entry only moves
# Cash in Hand when one of these is None.
SIDE_FIELDS = ("from_account_id", "to_account_id")


def _normalize_entry_payload(payload: dict, is_create: bool = False) -> dict:
    if "entry_date" in payload and payload["entry_date"] is not None:
        if isinstance(payload["entry_date"], date):
            payload["entry_date"] = payload["entry_date"].isoformat()
    # Blank strings from a form field mean "cash on this side", not "".
    for field in SIDE_FIELDS:
        if field in payload and payload[field] is not None:
            payload[field] = str(payload[field]).strip() or None
    # order_number: only set for order-advance entries; normalize empty to null
    if "order_number" in payload:
        if payload["order_number"] is not None:
            payload["order_number"] = str(payload["order_number"]).strip().lstrip("#") or None
    if "idempotency_key" in payload:
        payload["idempotency_key"] = (str(payload["idempotency_key"]).strip() or None) if payload.get("idempotency_key") else None
    return payload


def _get_entry_meta_or_404(supabase, org_id: str, entry_id: str) -> dict:
    resp = (
        org_table(supabase, org_id, "cashbook_entries")
        .select("order_number, from_account_id, to_account_id")
        .eq("id", entry_id)
        .limit(1)
        .execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")
    return resp.data[0]


def _sides(row: dict):
    """Both named accounts of an entry; a None side is cash and has no ledger
    balance of its own to refresh."""
    return [row.get(field) for field in SIDE_FIELDS]


def _ledger_balances(supabase, org_id: str, ledger_ids) -> List[dict]:
    """Current balance for each ledger_id, piggybacked on write responses so
    the frontend doesn't need a separate fetch to keep Cash In Hand in sync."""
    ids = {lid for lid in ledger_ids if lid}
    if not ids:
        return []
    resp = org_table(supabase, org_id, "ledger_balances").select("ledger_id, balance").in_("ledger_id", list(ids)).execute()
    found = {row["ledger_id"]: float(row["balance"]) for row in resp.data or []}
    return [{"ledger_id": lid, "balance": found.get(lid, 0.0)} for lid in ids]


def _safe_recompute_advance_statuses(supabase, org_id: str, order_numbers) -> None:
    """Best-effort: a failure here shouldn't fail the cashbook write that triggered it."""
    try:
        recompute_advance_statuses(supabase, org_id, list(order_numbers))
    except Exception:
        pass


def _split_existing_by_idempotency_key(supabase, org_id: str, payloads: List[dict]) -> tuple:
    """Looks up which of these payloads' idempotency_keys already have a row
    (a replayed create). Returns (existing_rows_by_key, payloads_still_to_insert)."""
    keys = [p["idempotency_key"] for p in payloads if p.get("idempotency_key")]
    if not keys:
        return {}, payloads
    resp = org_table(supabase, org_id, "cashbook_entries").select("*").in_("idempotency_key", keys).execute()
    existing_by_key = {row["idempotency_key"]: row for row in resp.data or []}
    to_insert = [p for p in payloads if p.get("idempotency_key") not in existing_by_key]
    return existing_by_key, to_insert


@router.get("/entries", response_model=List[CashbookEntry])
async def get_cashbook_entries(
    start_date: Optional[date] = Query(None, description="Filter from entry_date (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Filter to entry_date (YYYY-MM-DD)"),
    org_id: str = Depends(get_org_id),
):
    supabase = get_supabase()
    query = (
        org_table(supabase, org_id, "cashbook_entries")
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
async def create_cashbook_entry(entry: CashbookEntryCreate, org_id: str = Depends(get_org_id)):
    try:
        payload = _normalize_entry_payload(entry.model_dump(), is_create=True)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    supabase = get_supabase()

    if payload.get("idempotency_key"):
        existing_by_key, _ = _split_existing_by_idempotency_key(supabase, org_id, [payload])
        if existing_by_key:
            entry = next(iter(existing_by_key.values()))
            entry["ledger_balances"] = _ledger_balances(supabase, org_id, _sides(entry))
            return entry

    response = org_table(supabase, org_id, "cashbook_entries").insert(payload).execute()
    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create cashbook entry")

    if payload.get("order_number"):
        _safe_recompute_advance_statuses(supabase, org_id, [payload["order_number"]])

    entry = response.data[0]
    entry["ledger_balances"] = _ledger_balances(supabase, org_id, _sides(payload))
    return entry


@router.post("/entries/bulk", response_model=List[CashbookEntry])
async def create_cashbook_entries_bulk(entries: List[CashbookEntryCreate], org_id: str = Depends(get_org_id)):
    """One INSERT for the rows that are actually new (used by the bulk-text-
    entry modal and the two-sided/order-advance modals, so a paired entry is
    atomic instead of two racing POSTs). All-or-nothing for that insert:
    relies on the caller having already validated each entry (each named
    side resolved against a real ledger, amount > 0) before submitting. Rows whose
    idempotency_key already exists are treated as a replay and returned as-is
    instead of being inserted again."""
    if not entries:
        raise HTTPException(status_code=400, detail="No entries provided")

    try:
        # amount and the two-distinct-sides rule are already enforced by
        # CashbookEntryCreate itself, so only normalization is needed here.
        payloads = [_normalize_entry_payload(e.model_dump(), is_create=True) for e in entries]
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    supabase = get_supabase()
    existing_by_key, to_insert = _split_existing_by_idempotency_key(supabase, org_id, payloads)

    inserted = []
    if to_insert:
        response = org_table(supabase, org_id, "cashbook_entries").insert(to_insert).execute()
        if not response.data:
            raise HTTPException(status_code=500, detail="Failed to create cashbook entries")
        inserted = response.data

    order_numbers = {row["order_number"] for row in to_insert if row.get("order_number")}
    if order_numbers:
        _safe_recompute_advance_statuses(supabase, org_id, order_numbers)

    result_rows = list(existing_by_key.values()) + inserted
    balances = _ledger_balances(supabase, org_id, [a for row in payloads for a in _sides(row)])
    for entry in result_rows:
        entry["ledger_balances"] = balances
    return result_rows


@router.put("/entries/{entry_id}", response_model=CashbookEntry)
async def update_cashbook_entry(entry_id: str, entry: CashbookEntryUpdate, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    old_meta = _get_entry_meta_or_404(supabase, org_id, entry_id)
    old_order_number = old_meta.get("order_number")
    old_sides = _sides(old_meta)

    try:
        payload = _normalize_entry_payload(entry.model_dump(exclude_unset=True))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if "amount" in payload and (payload["amount"] is None or float(payload["amount"]) <= 0):
        raise HTTPException(status_code=400, detail="amount must be greater than 0")
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    # A partial update only carries the side being changed, so the two-sides rule
    # has to be checked against the MERGED result - CashbookEntryUpdate cannot
    # see the side it isn't touching. Without this, setting one side to whatever
    # the other already holds reaches the database and comes back as a raw
    # constraint violation, i.e. a 500.
    merged_from, merged_to = (
        payload.get(field, old_meta.get(field)) for field in SIDE_FIELDS
    )
    if merged_from is None and merged_to is None:
        raise HTTPException(
            status_code=400,
            detail="An entry needs a From or a To account (the empty side is cash).",
        )
    if merged_from is not None and merged_from == merged_to:
        raise HTTPException(
            status_code=400,
            detail="From and To cannot be the same account.",
        )

    response = org_table(supabase, org_id, "cashbook_entries").update(payload).eq("id", entry_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")

    # Cover both old and new order numbers in case the entry was reassigned.
    new_order_number = payload.get("order_number", old_order_number)
    affected_orders = {n for n in [old_order_number, new_order_number] if n}
    if affected_orders:
        _safe_recompute_advance_statuses(supabase, org_id, affected_orders)

    # Cover the old and new sides both, in case the entry was moved between
    # accounts - the account it left needs refreshing as much as the one it
    # joined.
    entry_out = response.data[0]
    entry_out["ledger_balances"] = _ledger_balances(
        supabase, org_id, old_sides + _sides(entry_out)
    )
    return entry_out


class DeleteCashbookEntryResult(BaseModel):
    status: Literal["deleted"]
    id: str
    ledger_balances: List[LedgerBalance]


@router.delete("/entries/{entry_id}", response_model=DeleteCashbookEntryResult)
async def delete_cashbook_entry(entry_id: str, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    old_meta = _get_entry_meta_or_404(supabase, org_id, entry_id)
    order_number = old_meta.get("order_number")
    sides = _sides(old_meta)

    response = org_table(supabase, org_id, "cashbook_entries").delete().eq("id", entry_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Cashbook entry not found")

    if order_number:
        _safe_recompute_advance_statuses(supabase, org_id, [order_number])

    return {"status": "deleted", "id": entry_id, "ledger_balances": _ledger_balances(supabase, org_id, sides)}


@router.get("/entries/audit-log", response_model=List[CashbookEntryAuditLog])
async def get_cashbook_entry_audit_log(
    entry_id: Optional[str] = Query(None, description="Filter to deletions of one entry"),
    start_date: Optional[date] = Query(None, description="Filter from entry_date (YYYY-MM-DD)"),
    end_date: Optional[date] = Query(None, description="Filter to entry_date (YYYY-MM-DD)"),
    org_id: str = Depends(get_org_id),
):
    """Deleted cashbook entries, snapshotted by a DB trigger — see
    cashbook_entry_audit_log in supabase_schema.sql. Records what was deleted
    and when, not who (no per-user identity exists yet)."""
    query = (
        org_table(get_supabase(), org_id, "cashbook_entry_audit_log")
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


def _fetch_daily_balance(supabase, org_id: str, target_date: date) -> dict:
    response = (
        org_table(supabase, org_id, "cashbook_daily_balances")
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
        org_table(supabase, org_id, "cashbook_daily_balances")
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


def _fetch_entries_for_date(supabase, org_id: str, target_date: date) -> list:
    response = (
        org_table(supabase, org_id, "cashbook_entries")
        .select("*")
        .eq("entry_date", target_date.isoformat())
        .order("created_at", desc=False)
        .execute()
    )
    return response.data


@router.get("/daily-balance/{target_date}", response_model=CashbookDailyBalance)
async def get_daily_balance(target_date: date, org_id: str = Depends(get_org_id)):
    """Get balance for a specific date."""
    return _fetch_daily_balance(get_supabase(), org_id, target_date)


@router.get("/day/{target_date}", response_model=CashbookDay)
async def get_cashbook_day(target_date: date, org_id: str = Depends(get_org_id)):
    """Bundles daily-balance + that date's entries — the Cashbook view's two
    always-together reads — into a single request."""
    supabase = get_supabase()
    return {
        "daily_balance": _fetch_daily_balance(supabase, org_id, target_date),
        "entries": _fetch_entries_for_date(supabase, org_id, target_date),
    }

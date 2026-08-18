"""Purchase bills / accounts payable (FINANCE_ACCOUNTING_PLAN.md Phase 2).

A supplier is a ledger, not a separate contact, so a bill credits the supplier's
own account and there is no Accounts Payable control account.

Payments are NOT recorded here. A bill records what is owed; the money leaving
is an ordinary transaction entry against the supplier's ledger, made when it
actually moves. Settlement is derived from that ledger balance, applied to the
supplier's bills oldest-first (the bills_with_paid view).

Receiving needs several writes to stay consistent — post the journal entry, add
stock, flip the status — so it is a Postgres function rather than a sequence of
PostgREST calls. unreceive_bill is its exact reverse.
"""
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_org_id, require_auth
from app.database import get_supabase
from app.models import ApAgeingRow, Bill, BillCreate, BillUpdate
from app.org_scope import org_table

router = APIRouter(prefix="/bills", tags=["bills"])


class BillActionResult(BaseModel):
    status: str
    id: str


def _rpc(supabase, name: str, params: dict):
    """The bill functions raise for every caller error (wrong status, nothing
    to post), so a failure here is a 400, not a server fault."""
    try:
        return supabase.rpc(name, params).execute()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _get_bill_or_404(supabase, org_id: str, bill_id: str) -> dict:
    resp = (
        org_table(supabase, org_id, "finances_bills_with_paid")
        .select("*")
        .eq("id", bill_id)
        .limit(1)
        .execute()
    )
    if not resp.data:
        raise HTTPException(status_code=404, detail="Bill not found")
    return resp.data[0]


def _attach_items(supabase, org_id: str, bills: List[dict]) -> List[dict]:
    """One query for the whole page rather than one per bill."""
    if not bills:
        return []
    items = (
        org_table(supabase, org_id, "finances_bill_items")
        .select("*")
        .in_("bill_id", [b["id"] for b in bills])
        .order("created_at", desc=False)
        .execute()
    ).data or []

    by_bill = {}
    for row in items:
        by_bill.setdefault(row["bill_id"], []).append(row)
    for bill in bills:
        bill["items"] = by_bill.get(bill["id"], [])
    return bills


def _replace_items(supabase, org_id: str, bill_id: str, items) -> None:
    org_table(supabase, org_id, "finances_bill_items").delete().eq("bill_id", bill_id).execute()
    if not items:
        return
    org_table(supabase, org_id, "finances_bill_items").insert([
        {
            "bill_id": bill_id,
            "product_id": item.product_id,
            "variant_id": item.variant_id,
            "description": item.description,
            "quantity": item.quantity,
            "unit_cost": item.unit_cost,
            "amount": item.amount,
        }
        for item in items
    ]).execute()


def _require_draft(bill: dict) -> None:
    if bill["status"] != "draft":
        raise HTTPException(
            status_code=400,
            detail=f"Only a draft bill can be edited (this one is {bill['status']})",
        )


@router.get("/", response_model=List[Bill])
async def list_bills(
    status: Optional[str] = Query(None, description="draft | received | cancelled"),
    supplier_id: Optional[str] = Query(None),
    org_id: str = Depends(get_org_id),
):
    supabase = get_supabase()
    query = (
        org_table(supabase, org_id, "finances_bills_with_paid")
        .select("*")
        .order("bill_date", desc=True)
        .order("bill_number", desc=True)
    )
    if status:
        query = query.eq("status", status)
    if supplier_id:
        query = query.eq("supplier_id", supplier_id)
    return _attach_items(supabase, org_id, query.execute().data or [])


@router.get("/ap-ageing", response_model=List[ApAgeingRow])
async def get_ap_ageing(
    as_of: Optional[date] = Query(None, description="Ageing as at this date (default today)"),
    org_id: str = Depends(get_org_id),
):
    """What is owed to each supplier, bucketed by how overdue it is. Only
    received bills are debts — drafts and cancelled bills are not."""
    resp = get_supabase().rpc("get_ap_ageing", {
        "p_org_id": org_id,
        "p_as_of": (as_of or date.today()).isoformat(),
    }).execute()
    return resp.data or []


@router.get("/{bill_id}", response_model=Bill)
async def get_bill(bill_id: str, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    bill = _get_bill_or_404(supabase, org_id, bill_id)
    return _attach_items(supabase, org_id, [bill])[0]


@router.post("/", response_model=Bill)
async def create_bill(
    bill: BillCreate,
    org_id: str = Depends(get_org_id),
    auth: dict = Depends(require_auth),
):
    """Creates a draft. Nothing is posted and no stock moves until it is
    received — a draft is a record of intent, not a liability."""
    supabase = get_supabase()

    number = supabase.rpc("next_bill_number", {"p_org_id": org_id}).execute().data
    if not number:
        raise HTTPException(status_code=500, detail="Could not allocate a bill number")

    resp = org_table(supabase, org_id, "finances_bills").insert({
        "bill_number": number,
        "supplier_id": bill.supplier_id,
        "supplier_ref": bill.supplier_ref,
        "bill_date": bill.bill_date.isoformat(),
        "due_date": bill.due_date.isoformat() if bill.due_date else None,
        "discount_amount": bill.discount_amount,
        "tax_amount": bill.tax_amount,
        "other_expense_amount": bill.other_expense_amount,
        "notes": bill.notes,
        "status": "draft",
        "created_by": auth.get("sub"),
    }).execute()
    if not resp.data:
        raise HTTPException(status_code=500, detail="Failed to create bill")

    bill_id = resp.data[0]["id"]
    try:
        _replace_items(supabase, org_id, bill_id, bill.items)
        _rpc(supabase, "recalc_bill_totals", {"p_bill_id": bill_id})
    except Exception:
        # The header and its lines are separate PostgREST calls with no
        # transaction around them, so a failure here would otherwise strand a
        # line-less draft that can never be received (receive_bill rejects a
        # zero total) and only clutters the list.
        org_table(supabase, org_id, "finances_bills").delete().eq("id", bill_id).execute()
        raise

    return _attach_items(supabase, org_id, [_get_bill_or_404(supabase, org_id, bill_id)])[0]


@router.put("/{bill_id}", response_model=Bill)
async def update_bill(bill_id: str, update: BillUpdate, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    _require_draft(_get_bill_or_404(supabase, org_id, bill_id))

    payload = update.model_dump(exclude_unset=True, exclude={"items"})
    for field in ("bill_date", "due_date"):
        if payload.get(field) is not None:
            payload[field] = payload[field].isoformat()

    if payload:
        org_table(supabase, org_id, "finances_bills").update(payload).eq("id", bill_id).execute()
    if update.items is not None:
        _replace_items(supabase, org_id, bill_id, update.items)

    _rpc(supabase, "recalc_bill_totals", {"p_bill_id": bill_id})
    return _attach_items(supabase, org_id, [_get_bill_or_404(supabase, org_id, bill_id)])[0]


@router.delete("/{bill_id}", response_model=BillActionResult)
async def delete_bill(bill_id: str, org_id: str = Depends(get_org_id)):
    """Drafts only. A received bill is posted history — cancel it instead, which
    leaves the record in place."""
    supabase = get_supabase()
    _require_draft(_get_bill_or_404(supabase, org_id, bill_id))

    org_table(supabase, org_id, "finances_bills").delete().eq("id", bill_id).execute()
    return {"status": "deleted", "id": bill_id}


@router.post("/{bill_id}/receive", response_model=Bill)
async def receive_bill(bill_id: str, org_id: str = Depends(get_org_id)):
    """Posts Dr Inventory/Expense per line, Dr Tax on Purchases, Cr the supplier
    ledger — and adds the lines' stock. Idempotent."""
    supabase = get_supabase()
    _get_bill_or_404(supabase, org_id, bill_id)
    _rpc(supabase, "receive_bill", {"p_bill_id": bill_id})
    return _attach_items(supabase, org_id, [_get_bill_or_404(supabase, org_id, bill_id)])[0]


@router.post("/{bill_id}/unreceive", response_model=Bill)
async def unreceive_bill(bill_id: str, org_id: str = Depends(get_org_id)):
    """Back to draft: unposts the journal entry and removes the stock again.
    The supplier's balance moves with it, so what the bill leaves owing follows
    automatically."""
    supabase = get_supabase()
    _get_bill_or_404(supabase, org_id, bill_id)
    _rpc(supabase, "unreceive_bill", {"p_bill_id": bill_id})
    return _attach_items(supabase, org_id, [_get_bill_or_404(supabase, org_id, bill_id)])[0]


@router.post("/{bill_id}/cancel", response_model=Bill)
async def cancel_bill(bill_id: str, org_id: str = Depends(get_org_id)):
    supabase = get_supabase()
    bill = _get_bill_or_404(supabase, org_id, bill_id)
    if bill["status"] == "received":
        # Unposts and reverses stock first.
        _rpc(supabase, "unreceive_bill", {"p_bill_id": bill_id})

    org_table(supabase, org_id, "finances_bills").update({"status": "cancelled"}).eq("id", bill_id).execute()
    return _attach_items(supabase, org_id, [_get_bill_or_404(supabase, org_id, bill_id)])[0]

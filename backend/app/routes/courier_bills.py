"""Courier payment bills: what each courier owes for the parcels it picked up on one date.

A bill is the (courier, pickup_date) bundle the Courier Payment Report page shows. Its
money is never stored - shopify_courier_bills_with_totals derives every figure from the
member orders, so a PostEx CSV that changes charges or settles an order is reflected with
no bill write at all (see 20260830030000_courier_bills.sql).

Membership is maintained by assign_courier_bills(), called after any write that can change
an order's courier or pickup date. Orders without a pickup date belong to no bill and are
absent from this page entirely - they cannot be placed on the pickup-date timeline.
"""
import logging
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_org_id
from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table

logger = logging.getLogger("app.courier_bills")

router = APIRouter(prefix="/courier-bills", tags=["courier-bills"])

BILL_ORDER_SELECT = (
    "id, order_number, customer_name, courier, tracking_number, order_status, "
    "total_amount, advance_amount, delivery_charge, tax_amount, cost_price, "
    "is_order_settled, courier_pickup_date, order_receiving_date"
)


class CourierBillUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None


@router.get("/")
async def list_courier_bills(
    date_from: Optional[date] = Query(None, description="Earliest pickup date (inclusive)."),
    date_to: Optional[date] = Query(None, description="Latest pickup date (inclusive)."),
    courier: Optional[List[str]] = Query(None, description="Restrict to these couriers."),
    payment_status: Optional[List[str]] = Query(None, description="paid/partially_paid/unpaid/in_transit."),
    org_id: str = Depends(get_org_id),
):
    """Bills in a pickup-date range, newest first.

    The range is applied in the database, so unlike the old client-side grouping this
    reaches the org's whole history rather than only the periods /orders/ happens to
    return. payment_status is a derived column of the view, so filtering on it here is
    equivalent to (and replaces) the frontend's post-hoc filter.
    """
    try:
        supabase = get_supabase()

        def build():
            q = org_table(supabase, org_id, "shopify_courier_bills_with_totals").select("*")
            if date_from:
                q = q.gte("pickup_date", date_from.isoformat())
            if date_to:
                q = q.lte("pickup_date", date_to.isoformat())
            if courier:
                q = q.in_("courier", courier)
            if payment_status:
                q = q.in_("payment_status", payment_status)
            return q.order("pickup_date", desc=True).order("courier")

        return fetch_all(build)
    except Exception:
        logger.exception("courier bills list failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{bill_id}")
async def get_courier_bill(bill_id: str, org_id: str = Depends(get_org_id)):
    """One bill with its member orders - the detail screen's payload."""
    try:
        supabase = get_supabase()
        bill = (
            org_table(supabase, org_id, "shopify_courier_bills_with_totals")
            .select("*").eq("id", bill_id).limit(1).execute()
        )
        if not bill.data:
            raise HTTPException(status_code=404, detail="Courier bill not found")

        orders = fetch_all(
            lambda: org_table(supabase, org_id, "shopify_orders")
            .select(BILL_ORDER_SELECT)
            .eq("courier_bill_id", bill_id)
            .order("order_number")
        )
        return {**bill.data[0], "orders": orders}
    except HTTPException:
        raise
    except Exception:
        logger.exception("courier bill fetch failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.patch("/{bill_id}")
async def update_courier_bill(bill_id: str, body: CourierBillUpdate, org_id: str = Depends(get_org_id)):
    """Set a bill's workflow status or notes.

    Marking a bill settled freezes its membership: assign_courier_bills will not move an
    order out of it afterwards, so a courier correcting a pickup date cannot silently
    change a bill you have already closed out.
    """
    update = body.model_dump(exclude_unset=True)
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")
    if "status" in update and update["status"] not in ("open", "settled"):
        raise HTTPException(status_code=400, detail="status must be 'open' or 'settled'")

    try:
        supabase = get_supabase()
        update["updated_at"] = datetime.now(timezone.utc).isoformat()
        if "status" in update:
            update["settled_at"] = update["updated_at"] if update["status"] == "settled" else None
        response = (
            org_table(supabase, org_id, "shopify_courier_bills")
            .update(update).eq("id", bill_id).execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Courier bill not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception:
        logger.exception("courier bill update failed")
        raise HTTPException(status_code=500, detail="Internal server error")

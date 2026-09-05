import asyncio
import json
import logging
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import httpx
from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from supabase import create_client

from app import shopify
from app.advance_status import recompute_advance_statuses
from app.auth import get_org_id
from app.config import settings
from app.database import get_supabase
from app.db_utils import fetch_all
from app.fiscal_settings import DEFAULT_FISCAL_MONTH_START_DAY, get_org_fiscal_settings
from app.models import Order, OrderCreate, OrderUpdate
from app.money import money
from app.order_pdf import extract_order_numbers
from app.ordering import _order_number_sort_key
from app.org_scope import org_table
from app.org_settings import OrgIntegrationSettings, ensure_valid_shopify_token, get_org_integration_settings
from app.rate_limit import limiter
from app.services import couriers_next, event_bus, postex
from app.services.courier_cities import get_courier_cities
from app.services.pdf.courier_bill_summary import generate_courier_bill_summary_pdf
from app.services.pdf.invoice import _build_invoice_order_context, _generate_pdf_invoice
from app.services.pdf.load_sheet import _generate_pdf_load_sheet
from app.services.pdf.packaging_list import (
    _aggregate_packaging_items,
    _generate_pdf_packaging_list,
    _order_line_rows,
)
from app.services.shopify_orders import (
    _fetch_shopify_order_by_order_number,
    _fetch_shopify_unfulfilled_orders,
)
from app.services.shopify_sync import (
    PRICE_REDUCTION_DISCOUNT_CODES,
    has_settled_tag,
    SyncShopifyOrdersResult,
    _cost_from_line_items,
    _delivery_charge_from_other_tags,
    _get_sync_status_row,
    _line_items_incomplete,
    _line_items_signature,
    _order_total_from_fulfillments,
    _resolve_line_item_cost,
    _sync_shopify_orders,
)
from app.timezones import PKT_TIMEZONE

logger = logging.getLogger("app.orders")

# Shopify's source_name for orders created from a draft (replacements, manual orders):
# they never went through checkout, so they have no transaction to settle against.
DRAFT_ORDER_SOURCE = "shopify_draft_order"
router = APIRouter(prefix="/orders", tags=["orders"])

# Backstop on user-supplied PDF batch endpoints (invoice/packaging-list/load-sheet) -
# ReportLab rendering time scales with order count, and this is the cheapest bound on
# worst-case request latency. The rendering itself runs off the event loop (see
# asyncio.to_thread below) so a large batch no longer blocks other requests, but it can
# still make one request very slow; this caps that.
MAX_PDF_BATCH_ORDERS = 500

# Cap on concurrent outbound requests (Shopify/Couriers Next fetches, DB save writes) -
# keeps us from opening hundreds of simultaneous connections to any one service.
_BULK_CONCURRENCY = 20


def _period_start_end(month: int, year: int, start_day: int = DEFAULT_FISCAL_MONTH_START_DAY):
    """Return (start_iso, end_iso) for period: month's `start_day` 00:00:00 PKT to next
    month's `start_day` 00:00:00 PKT (exclusive). `start_day` is the org's own
    fiscal_month_start_day (app.fiscal_settings) - defaults to 22, LushWear's original
    22nd-to-21st cycle. Returns dates in UTC for database comparison.
    PKT (Pakistan Time) is UTC+5, so 00:00 PKT = 19:00 UTC (previous day).
    Example: with start_day=22, the December period = Dec 22 00:00 PKT (inclusive) to
    Jan 22 00:00 PKT (exclusive), so all of Jan 21 up to 23:59:59.999999 PKT is included."""
    # Create start date: month's start_day at 00:00:00 PKT
    start_pkt = datetime(year, month, start_day, 0, 0, 0, 0, tzinfo=PKT_TIMEZONE)

    # Calculate next month and year
    next_month = month % 12 + 1
    next_year = year if month != 12 else year + 1

    # Create end date: next month's start_day at 00:00:00 PKT (exclusive boundary)
    # This ensures we include everything up to but not including the next period start
    end_pkt = datetime(next_year, next_month, start_day, 0, 0, 0, 0, tzinfo=PKT_TIMEZONE)

    # Convert to UTC for database comparison
    start_utc = start_pkt.astimezone(timezone.utc)
    end_utc = end_pkt.astimezone(timezone.utc)

    # Return ISO format strings with timezone info (Z suffix for UTC)
    return start_utc.isoformat().replace('+00:00', 'Z'), end_utc.isoformat().replace('+00:00', 'Z')


RECENT_ORDERS_MONTHS = 3


def _period_containing(dt_pkt: datetime, start_day: int = DEFAULT_FISCAL_MONTH_START_DAY) -> Tuple[int, int]:
    """(month, year) of the order period (`start_day` to next month's `start_day` - 1)
    containing a PKT-aware datetime."""
    if dt_pkt.day >= start_day:
        return dt_pkt.month, dt_pkt.year
    month, year = dt_pkt.month - 1, dt_pkt.year
    return (12, year - 1) if month == 0 else (month, year)


def _shift_period(month: int, year: int, back: int) -> Tuple[int, int]:
    """(month, year) of the period `back` periods before the given one."""
    total = year * 12 + (month - 1) - back
    return total % 12 + 1, total // 12


def _recent_orders_cutoff_iso(start_day: int = DEFAULT_FISCAL_MONTH_START_DAY) -> str:
    """UTC ISO instant for the start of the oldest period in "Recent Orders" (the last
    RECENT_ORDERS_MONTHS periods) - the same period boundaries as the period filter
    (org's own start_day), not a raw calendar-months-back date, so a period's oldest
    order always matches between the two views."""
    month, year = _period_containing(datetime.now(PKT_TIMEZONE), start_day)
    oldest_month, oldest_year = _shift_period(month, year, RECENT_ORDERS_MONTHS - 1)
    start_iso, _ = _period_start_end(oldest_month, oldest_year, start_day)
    return start_iso


def _period_start_end_dates(month: int, year: int, start_day: int = DEFAULT_FISCAL_MONTH_START_DAY):
    """Return (start_date, end_date) as YYYY-MM-DD for the period (`start_day` to next
    month's `start_day` - 1, inclusive). Subtracting a day from next month's start_day
    (rather than hardcoding `start_day - 1`) is what makes start_day=1 (a plain
    calendar month) roll back to the current month's actual last day instead of day 0."""
    start_date = date(year, month, start_day)
    next_month = month % 12 + 1
    next_year = year if month != 12 else year + 1
    end_date = date(next_year, next_month, start_day) - timedelta(days=1)
    return start_date.isoformat(), end_date.isoformat()


# The orders list is the one place `delivery_status` gets fetched at scale (hundreds-1000+
# rows), and the frontend list view only ever renders `latest_status` from it - the full
# `status_history` array (the bulk of that column's size) is only needed by the per-order
# detail modal, which fetches it fresh on its own. Extracting just latest_status via
# PostgREST's ->> operator cuts payload roughly 10x for this query without changing what
# the frontend receives (see _reshape_delivery_status_latest below).
ORDERS_LIST_SELECT = (
    "id, order_number, courier, tracking_number, folio, order_status, piece_received, "
    "total_amount, advance_amount, delivery_charge, tax_amount, cost_price, "
    "order_receiving_date, courier_pickup_date, line_items, advance_status, is_order_settled, replacement_of_order_no, "
    "created_at, updated_at, delivery_status_latest:delivery_status->>latest_status"
)


def _reshape_delivery_status_latest(rows: List[dict]) -> List[dict]:
    """Rebuild the `delivery_status` shape the frontend expects ({"latest_status": ...})
    from the flattened `delivery_status_latest` column ORDERS_LIST_SELECT produces."""
    for row in rows:
        latest = row.pop("delivery_status_latest", None)
        row["delivery_status"] = {"latest_status": latest} if latest else None
    return rows


@router.get("/", response_model=List[Order])
async def get_all_orders(
    month: int = Query(None, ge=1, le=12, description="Filter by period month (1-12). Period boundaries follow the org's fiscal_month_start_day."),
    year: int = Query(None, ge=2000, le=2100, description="Filter by period year."),
    org_id: str = Depends(get_org_id),
):
    """Orders for a month period, or the last RECENT_ORDERS_MONTHS months (newest first) when no period is given ('Recent Orders')."""
    try:
        t_start = time.perf_counter()
        supabase = get_supabase()
        start_day = get_org_fiscal_settings(org_id)["fiscal_month_start_day"]

        if month is not None and year is not None:
            start_iso, end_iso = _period_start_end(month, year, start_day)
            period_orders = fetch_all(
                lambda: org_table(supabase, org_id, "shopify_orders")
                .select(ORDERS_LIST_SELECT)
                .gte("order_receiving_date", start_iso)
                .lt("order_receiving_date", end_iso)
                .order("order_receiving_date", desc=True)
                .order("order_number", desc=True)
            )
            period_orders = _reshape_delivery_status_latest(period_orders)
            t_query = time.perf_counter()
            logger.info(
                "[get_all_orders] period=%s-%s query=%.2fs (rows=%d)",
                month, year, t_query - t_start, len(period_orders),
            )
            return period_orders

        # "Recent Orders": orders from the last RECENT_ORDERS_MONTHS periods, ranked by
        # order_receiving_date (the actual recency the feature means, not insertion order).
        cutoff_iso = _recent_orders_cutoff_iso(start_day)
        recent = fetch_all(
            lambda: org_table(supabase, org_id, "shopify_orders")
            .select(ORDERS_LIST_SELECT)
            .gte("order_receiving_date", cutoff_iso)
            .order("order_receiving_date", desc=True)
            .order("order_number", desc=True)
        )
        recent = _reshape_delivery_status_latest(recent)
        t_query = time.perf_counter()
        logger.info(
            "[get_all_orders] recent since=%s query=%.2fs (rows=%d)",
            cutoff_iso, t_query - t_start, len(recent),
        )
        return recent
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


class CustomerStatus(BaseModel):
    tier: str  # "new" | "trusted" | "low" | "medium" | "high"
    label: str
    received: int
    total: int


class UnfulfilledOrderLineItem(BaseModel):
    name: str
    variant_title: str = "-"
    qty: int = 0


class UnfulfilledOrder(BaseModel):
    id: str
    order_number: int
    name: str
    address: str
    mobile: str
    tags: List[str]
    city: str
    order_date: datetime
    total_amount: float
    advance_amount: float
    line_items: List[UnfulfilledOrderLineItem]
    customer_status: CustomerStatus


def _customer_status_tier(received: int, total: int) -> Tuple[str, str]:
    """Bucket a customer's delivery track record (received/total past orders, this order
    excluded) into the Order Fulfillment view's risk tiers."""
    if total == 0:
        return "new", "New Customer"
    ratio = received / total
    if total >= 3 and ratio >= 0.999:
        return "trusted", "Trusted"
    if ratio >= 0.75:
        return "low", "Low Risk"
    if ratio >= 0.40:
        return "medium", "Medium Risk"
    return "high", "High Risk"


@router.get("/unfulfilled", response_model=List[UnfulfilledOrder])
async def get_unfulfilled_orders(org_id: str = Depends(get_org_id)):
    """Unfulfilled orders for the Order Fulfillment view, across all periods (this is an
    action queue, not a period report). Customer name/address/phone/city/id are captured
    once per order at sync time (see shopify_sync._apply_customer_fields) and read
    straight off shopify_orders here - no live Shopify lookup for customer data. Order
    tags aren't persisted, though, so those still come from a live per-order lookup (same
    fetch pattern generate-invoice uses).

    customer_status is this customer's delivery track record across their *other* orders,
    found by grouping our own shopify_orders rows on customer_id - bounded to what we've
    synced (unlike a live Shopify customer-orders lookup, which sees every order Shopify
    has, synced or not); see _customer_status_tier."""
    try:
        t_start = time.perf_counter()
        supabase = get_supabase()
        rows = fetch_all(
            lambda: org_table(supabase, org_id, "shopify_orders")
            .select("id, order_number, order_receiving_date, total_amount, advance_amount, line_items, customer_id, customer_name, customer_phone, customer_address, customer_city")
            .eq("order_status", "unfulfilled")
            .order("order_receiving_date", desc=True)
        )
        if not rows:
            return []
        t_db_rows = time.perf_counter()

        org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
        fetch_sem = asyncio.Semaphore(_BULK_CONCURRENCY)

        # One sweep for the store's most-recently-created unfulfilled Shopify orders (see
        # _fetch_shopify_unfulfilled_orders), instead of looking each row up individually.
        # Any row it misses (older than its cutoff, or Shopify's sync lagged) still gets
        # picked up by the per-order fallback below. Tags are all this is used for now.
        sp_orders_list = await _fetch_shopify_unfulfilled_orders(org_creds)
        sp_order_by_number: Dict[int, dict] = {}
        for o in sp_orders_list:
            try:
                sp_order_by_number[int(o.get("order_number"))] = o
            except (TypeError, ValueError):
                continue
        t_sweep = time.perf_counter()

        async def _fetch_order_bounded(num: int):
            async with fetch_sem:
                try:
                    return await _fetch_shopify_order_by_order_number(str(num), org_creds)
                except Exception:
                    return None

        # Fallback for any DB row the sweep didn't cover (sync lag: DB still says unfulfilled,
        # Shopify has moved on) - rare, so this costs ~nothing in the common case.
        missing_rows = [row for row in rows if row["order_number"] not in sp_order_by_number]
        if missing_rows:
            fallback_sp_orders = await asyncio.gather(*(_fetch_order_bounded(row["order_number"]) for row in missing_rows))
            for row, sp_order in zip(missing_rows, fallback_sp_orders):
                if sp_order:
                    sp_order_by_number[row["order_number"]] = sp_order
        t_fallback = time.perf_counter()

        def _tags_for(order_number: int) -> List[str]:
            sp_order = sp_order_by_number.get(order_number)
            if not sp_order:
                return []
            return [t.strip() for t in (sp_order.get("tags") or "").split(",") if t.strip()]

        customer_ids = {row["customer_id"] for row in rows if row.get("customer_id") is not None}
        history_by_customer: Dict[int, List[dict]] = {}
        if customer_ids:
            history_rows = fetch_all(
                lambda: org_table(supabase, org_id, "shopify_orders")
                .select("order_number, customer_id, delivery_status")
                .in_("customer_id", list(customer_ids))
            )
            for h in history_rows:
                history_by_customer.setdefault(h["customer_id"], []).append(h)
        t_history_query = time.perf_counter()

        results = []
        for row in rows:
            cid = row.get("customer_id")
            history = [h for h in history_by_customer.get(cid, []) if h["order_number"] != row["order_number"]] if cid is not None else []
            total = len(history)
            received = sum(1 for h in history if _delivery_status_indicates_delivered(h.get("delivery_status") or {}))
            tier, label = _customer_status_tier(received, total)
            results.append({
                "id": row["id"],
                "order_number": row["order_number"],
                "name": row.get("customer_name") or "-",
                "address": row.get("customer_address") or "-",
                "mobile": row.get("customer_phone") or "-",
                "tags": _tags_for(row["order_number"]),
                "city": row.get("customer_city") or "-",
                "order_date": row["order_receiving_date"],
                "total_amount": float(row.get("total_amount") or 0),
                "advance_amount": float(row.get("advance_amount") or 0),
                "line_items": [
                    {
                        "name": li.get("name") or "",
                        "variant_title": li.get("variant_title") or "-",
                        "qty": int(li.get("qty") or 0),
                    }
                    for li in (row.get("line_items") or [])
                ],
                "customer_status": {"tier": tier, "label": label, "received": received, "total": total},
            })

        logger.info(
            "[get_unfulfilled_orders] rows=%d db_query=%.2fs shopify_sweep=%.2fs(found=%d/%d) "
            "fallback_fetch=%.2fs(n=%d) history_db_query=%.2fs(customers=%d) total=%.2fs",
            len(rows), t_db_rows - t_start, t_sweep - t_db_rows, len(sp_order_by_number), len(rows),
            t_fallback - t_sweep, len(missing_rows),
            t_history_query - t_fallback, len(customer_ids),
            time.perf_counter() - t_start,
        )
        return results
    except HTTPException:
        raise
    except Exception:
        logger.exception("unfulfilled orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/courier-cities")
async def get_courier_supported_cities(courier: str, org_id: str = Depends(get_org_id)):
    """Cities a specific courier actually supports, for the Order Fulfillment view's
    per-row courier-city dropdown - populated once a courier is picked in the side
    panel. Empty list for any courier without a live cities API (see
    app/services/courier_cities.py); a missing-credentials courier raises instead,
    so that surfaces as a toast rather than silently disabling the dropdown."""
    try:
        org_creds = get_org_integration_settings(org_id)
        if courier == "postex" and not org_creds.postex_merchant_token:
            raise HTTPException(status_code=400, detail="PostEx credentials are not configured for this organization. Set them in Settings > Integrations.")
        cities = await get_courier_cities(courier, org_id, org_creds)
        return {"cities": cities}
    except HTTPException:
        raise
    except Exception:
        logger.exception("Failed to fetch supported cities for courier %s", courier)
        raise HTTPException(status_code=500, detail="Failed to fetch supported cities")


class FulfillOrderRequest(BaseModel):
    order_id: str
    courier_city: str
    # PostEx-only (see postex.ORDER_TYPES); ignored for couriers whose API has no
    # equivalent, which is why it defaults rather than being required.
    order_type: str = "Normal"
    # Per-order overrides typed into the fulfillment row's details modal. cod_amount
    # None means "use the computed total - advance"; a value (including 0) overrides it.
    # pieces None falls back to the summed line-item quantity; invoice_division is
    # PostEx-only (airway-bill split count).
    cod_amount: Optional[float] = None
    customer_email: Optional[str] = None
    instructions: Optional[str] = None
    pieces: Optional[int] = None
    invoice_division: Optional[int] = None
    # "Standard" | "Fragile". Neither courier's API has a handling field, so "Fragile"
    # is surfaced by prefixing the instructions note the courier does receive.
    handling: Optional[str] = None


class FulfillOrdersBody(BaseModel):
    courier: str
    pickup_address_code: str
    orders: List[FulfillOrderRequest]


class FulfillOrderResult(BaseModel):
    order_id: str
    order_number: Optional[int] = None
    ok: bool
    tracking_number: Optional[str] = None
    error: Optional[str] = None


# Display name per bookable courier - stored as the order's `courier`, sent to the courier
# as the tracking company, and written to Shopify as the order's courier tag, so these must
# stay spelled the way the rest of the app already writes them (see the Couriers Next
# tracking route and orders-columns.js COURIER_LOGOS).
#
# The rest of the frontend's courier list still has to be fulfilled in that courier's own
# portal - a courier absent here is rejected by /fulfill rather than silently ignored.
_FULFILL_COURIER_NAMES = {"postex": "PostEx", "couriers_next": "Couriers Next"}

# Public tracking page per bookable courier, formatted with the tracking number. Sent to
# Shopify with the fulfillment so the number is a working link in the customer's shipping
# email - Shopify can only infer a carrier URL for carriers it knows, which is none of
# these, so an absent template leaves the number as plain text.
_FULFILL_TRACKING_URLS = {
    "postex": "https://postex.pk/tracking?cn={tracking_number}",
    "couriers_next": "https://portal.couriersnext.com/track-details.php?track_code={tracking_number}",
}

# Couriers Next books a parcel from a named origin city rather than from a stored pickup
# address, so unlike PostEx the shipper profile does not carry one. Their account is
# Karachi-based and every dispatch leaves from there.
_COURIERS_NEXT_ORIGIN = "Karachi"


def _order_detail_string(line_items: List[dict]) -> Optional[str]:
    """The per-parcel contents line the courier prints on the airway bill, one
    "[ <qty> x <product> <size> ]" token per line. `variant_title` is "-" for a
    product with no variants, so the size is dropped there. Capped at 250 chars
    to stay within what the courier APIs accept for the field."""
    parts = []
    for li in line_items:
        name = li.get("name")
        if not name:
            continue
        size = (li.get("variant_title") or "").strip()
        label = f"{name} {size}" if size and size != "-" else name
        parts.append(f"[ {li.get('qty')} x {label} ]")
    return " ".join(parts)[:250] or None


async def _book_one_order(
    client: httpx.AsyncClient, body: FulfillOrdersBody, order_id: str,
    request: FulfillOrderRequest, row: Optional[dict], courier_name: str,
    credential: str, client_code: Optional[str], supabase, org_id: str,
) -> Tuple[FulfillOrderResult, Optional[Tuple[dict, str]]]:
    """Book one parcel with the courier and record the tracking number locally. Returns
    the order's outcome and, only when the booking succeeded, the (row, tracking_number)
    pair the Shopify fulfillment push needs. Never raises for an expected
    booking/validation failure - those come back as an ok=False result so the caller can
    report each order separately.

    The parcel is booked before anything is written locally, so a DB failure can leave a
    booked shipment unrecorded, but never the reverse: an order marked fulfilled here
    always has a real parcel behind it.
    """
    if not row:
        return FulfillOrderResult(order_id=order_id, ok=False, error="Order not found"), None
    order_number = row["order_number"]
    # Re-checked against the DB rather than trusting the client's list, which can be
    # minutes stale - without this a double-submit books the same parcel twice.
    if row.get("order_status") != "unfulfilled" or row.get("tracking_number"):
        return FulfillOrderResult(
            order_id=order_id, order_number=order_number, ok=False, error="Already fulfilled",
        ), None

    missing = [
        label for label, value in (
            ("customer name", row.get("customer_name")),
            ("phone", row.get("customer_phone")),
            ("address", row.get("customer_address")),
            ("courier city", request.courier_city),
        ) if not (value or "").strip()
    ]
    if missing:
        return FulfillOrderResult(
            order_id=order_id, order_number=order_number, ok=False,
            error=f"Missing {', '.join(missing)}",
        ), None

    # Shopify stores whatever the customer typed - normalised to 03xxxxxxxxx (what PostEx
    # mandates, and what Couriers Next riders dial) and rejected here so it reads as a
    # fixable data problem rather than the courier generic validation error.
    customer_phone = postex.normalize_phone(row["customer_phone"])
    if not customer_phone:
        return FulfillOrderResult(
            order_id=order_id, order_number=order_number, ok=False,
            error=f"Invalid phone number ({row['customer_phone']})",
        ), None

    line_items = row.get("line_items") or []
    # What the rider collects: the order value less whatever the customer already paid, so
    # a fully-prepaid order books at 0 rather than being charged twice. An explicit
    # cod_amount from the row's details modal (0 included) overrides that.
    if request.cod_amount is not None and request.cod_amount >= 0:
        cod_amount = float(request.cod_amount)
    else:
        cod_amount = max(0.0, float(row.get("total_amount") or 0) - float(row.get("advance_amount") or 0))
    customer_email = (request.customer_email or "").strip() or None
    instructions = (request.instructions or "").strip() or None
    if (request.handling or "").strip().lower() == "fragile" and not (instructions and "FRAGILE" in instructions.upper()):
        instructions = f"{instructions}\n- FRAGILE" if instructions else "- FRAGILE"
    items = (
        request.pieces
        if request.pieces is not None and request.pieces > 0
        else sum(int(li.get("qty") or 0) for li in line_items) or 1
    )
    order_detail = _order_detail_string(line_items)

    try:
        if body.courier == "postex":
            tracking_number = await postex.create_order(
                client,
                credential,
                order_ref_number=str(order_number),
                customer_name=row["customer_name"].strip(),
                customer_phone=customer_phone,
                delivery_address=row["customer_address"].strip(),
                city_name=request.courier_city.strip(),
                invoice_payment=cod_amount,
                items=items,
                pickup_address_code=body.pickup_address_code,
                order_type=request.order_type,
                order_detail=order_detail,
                instructions=instructions,
                customer_email=customer_email,
                invoice_division=request.invoice_division,
            )
        else:
            tracking_number = await couriers_next.create_order(
                client,
                credential,
                client_code=client_code,
                profile_id=body.pickup_address_code,
                order_ref_number=str(order_number),
                customer_name=row["customer_name"].strip(),
                customer_phone=customer_phone,
                delivery_address=row["customer_address"].strip(),
                origin_city=_COURIERS_NEXT_ORIGIN,
                city_name=request.courier_city.strip(),
                collection_amount=cod_amount,
                items=items,
                order_detail=order_detail,
                instructions=instructions,
                customer_email=customer_email,
            )
    except (postex.PostexBookingError, couriers_next.CouriersNextBookingError) as exc:
        return FulfillOrderResult(
            order_id=order_id, order_number=order_number, ok=False, error=str(exc),
        ), None

    try:
        org_table(supabase, org_id, "shopify_orders").update({
            "courier": courier_name,
            "tracking_number": tracking_number,
            "order_status": "fulfilled",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", order_id).execute()
    except Exception:
        # The parcel exists at the courier regardless, so surface the tracking number
        # instead of losing it with the exception.
        logger.exception("Order %s booked with %s (%s) but the local update failed",
                         order_number, courier_name, tracking_number)
        return FulfillOrderResult(
            order_id=order_id, order_number=order_number, ok=False, tracking_number=tracking_number,
            error=f"Booked as {tracking_number}, but saving it locally failed - record it manually.",
        ), None

    return (
        FulfillOrderResult(
            order_id=order_id, order_number=order_number, ok=True, tracking_number=tracking_number,
        ),
        (row, tracking_number),
    )


@router.post("/fulfill")
async def fulfill_orders(body: FulfillOrdersBody, org_id: str = Depends(get_org_id)):
    """Book the selected orders with the courier and stream each outcome as it lands.

    Bookings run sequentially, not gathered like the read-side Shopify sweeps: each one
    creates a real shipment, so a mid-flight failure must leave a knowable number of
    parcels behind, and PostEx rate-limits create-order far more tightly than its read
    APIs. One order failing (unserviceable city, duplicate ref number, bad phone) never
    aborts the rest.

    The response is newline-delimited JSON so the Order Fulfillment progress screen can
    fill in row by row: one `{"type": "order", "result": {...}}` line per order the
    instant it resolves, an optional `{"type": "shopify_sync"}` marker while successful
    bookings are mirrored into Shopify, then a final
    `{"type": "done", "booked_count", "failed_count"}` line.
    """
    if body.courier not in _FULFILL_COURIER_NAMES:
        raise HTTPException(status_code=400, detail=f"Fulfillment is not supported for courier '{body.courier}' yet.")
    if not body.orders:
        raise HTTPException(status_code=400, detail="No orders selected.")
    if body.courier == "postex":
        bad_types = {o.order_type for o in body.orders} - set(postex.ORDER_TYPES)
        if bad_types:
            raise HTTPException(status_code=400, detail=f"Unknown PostEx order type(s): {', '.join(sorted(bad_types))}.")

    org_creds = get_org_integration_settings(org_id)
    courier_name = _FULFILL_COURIER_NAMES[body.courier]
    credential = (
        org_creds.postex_merchant_token if body.courier == "postex" else org_creds.couriers_next_auth_key
    )
    if not credential:
        raise HTTPException(status_code=400, detail=f"{courier_name} credentials are not configured for this organization. Set them in Settings > Integrations.")

    # Couriers Next identifies the merchant on every booking by a client_code that is
    # not stored alongside the auth key - it is read back from the same call that lists
    # the shipper profiles, so it is fetched once here rather than per order.
    client_code = None
    if body.courier == "couriers_next":
        client_code, _ = await couriers_next.fetch_shippers(credential)
        if not client_code:
            raise HTTPException(status_code=502, detail="Could not read the Couriers Next account profile - check the auth key in Settings > Integrations.")

    supabase = get_supabase()
    requested = {o.order_id: o for o in body.orders}
    rows = (
        org_table(supabase, org_id, "shopify_orders")
        .select("id, order_number, order_status, tracking_number, total_amount, advance_amount, line_items, "
                "customer_name, customer_phone, customer_address")
        .in_("id", list(requested))
        .execute()
        .data
        or []
    )
    rows_by_id = {r["id"]: r for r in rows}

    async def stream():
        results: List[FulfillOrderResult] = []
        booked: List[Tuple[dict, str]] = []
        async with httpx.AsyncClient(timeout=60.0) as client:
            for order_id, request in requested.items():
                result, booked_row = await _book_one_order(
                    client, body, order_id, request, rows_by_id.get(order_id),
                    courier_name, credential, client_code, supabase, org_id,
                )
                results.append(result)
                if booked_row:
                    booked.append(booked_row)
                yield json.dumps({"type": "order", "result": result.model_dump()}) + "\n"

        if booked:
            event_bus.publish(org_id, {"type": "orders_changed"})
            yield json.dumps({"type": "shopify_sync"}) + "\n"
            await _push_fulfillments_to_shopify(booked, body.courier, courier_name, org_id, org_creds)

        yield json.dumps({
            "type": "done",
            "booked_count": sum(1 for r in results if r.ok),
            "failed_count": sum(1 for r in results if not r.ok),
        }) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


async def _push_fulfillments_to_shopify(
    booked: List[Tuple[dict, str]], courier: str, courier_name: str, org_id: str,
    org_creds: OrgIntegrationSettings
) -> None:
    """Mirror successful bookings into Shopify so the store shows them fulfilled with
    tracking, and the customer gets the shipping notification.

    Best-effort by design: every failure is logged and swallowed, because the courier
    booking it reflects has already happened and must not be reported back as failed.
    A miss here is recoverable - the next Shopify sync reconciles it - whereas a parcel
    booked twice is not.
    """
    try:
        org_creds = await ensure_valid_shopify_token(org_id, org_creds)
    except Exception:
        logger.exception("Could not refresh the Shopify token - skipping fulfillment push for %d order(s)", len(booked))
        return

    for row, tracking_number in booked:
        try:
            sp_order = await _fetch_shopify_order_by_order_number(str(row["order_number"]), org_creds)
            if not sp_order:
                logger.warning("Order %s not found in Shopify - skipping fulfillment push", row["order_number"])
                continue
            tracking_url = _FULFILL_TRACKING_URLS.get(courier)
            await shopify.create_fulfillment(
                sp_order["id"], tracking_number, courier_name,
                tracking_url.format(tracking_number=tracking_number) if tracking_url else None,
                org_creds,
            )
        except Exception:
            logger.exception("Shopify fulfillment push failed for order %s (booked as %s)",
                             row["order_number"], tracking_number)


async def _push_settlements_to_shopify(
    order_numbers: List[int], org_id: str, delivered_order_numbers: Optional[Set[int]] = None
) -> None:
    """Mirror settled orders into Shopify: tag them "Settled" and, for delivered orders,
    record the courier's payout so the store reflects money that has actually arrived.

    Every order is tagged "Settled" - that tag is what stops the sync reading a later
    "paid" as a customer advance. Only orders in delivered_order_numbers are also marked
    paid: a returned or otherwise-undelivered parcel was never paid for, so recording its
    balance would invent money that never arrived (see shopify.mark_order_settled).

    Best-effort by design, same as _push_fulfillments_to_shopify: the payout is already
    recorded locally and must not be reported back as failed because Shopify was
    unreachable. A miss here is recoverable by re-settling the order.

    Runs the orders concurrently over one shared client: a payout CSV settles hundreds
    at 2-4 Shopify calls each, which sequentially ran into minutes. _request_with_retry
    absorbs the 429s the extra concurrency provokes.
    """
    if not order_numbers:
        return
    try:
        org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
    except Exception:
        logger.exception("Could not refresh the Shopify token - skipping settlement push for %d order(s)", len(order_numbers))
        return
    if not (org_creds.shopify_store_url and org_creds.shopify_access_token):
        return

    delivered = delivered_order_numbers or set()
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def _settle(order_number: int, client: httpx.AsyncClient) -> None:
        async with sem:
            try:
                sp_order = await _fetch_shopify_order_by_order_number(str(order_number), org_creds)
                if not sp_order:
                    logger.warning("Order %s not found in Shopify - skipping settlement push", order_number)
                    return
                # Replacement orders come from draft orders, which carry no checkout
                # transaction to capture against - tag those instead of posting a payment
                # Shopify would reject (see shopify.mark_order_settled).
                await shopify.mark_order_settled(
                    sp_order["id"], org_creds,
                    record_payment=(
                        sp_order.get("source_name") != DRAFT_ORDER_SOURCE
                        and order_number in delivered
                    ),
                    client=client)
            except Exception:
                logger.exception("Shopify settlement push failed for order %s", order_number)

    async with httpx.AsyncClient(timeout=shopify._TIMEOUT) as client:
        await asyncio.gather(*(_settle(n, client) for n in order_numbers))


@router.get("/courier-pickup-addresses")
async def get_courier_pickup_addresses(courier: str, org_id: str = Depends(get_org_id)):
    """The pickup identities this org can dispatch under, for the Order Fulfillment
    view's picker. Neither bookable courier will accept an order without one - PostEx
    needs a pickup address code (see postex.fetch_pickup_addresses), Couriers Next a
    shipper profile_id - so an empty list here means fulfillment cannot proceed until
    one is added in that courier own portal."""
    if courier not in _FULFILL_COURIER_NAMES:
        return {"addresses": []}
    org_creds = get_org_integration_settings(org_id)
    courier_name = _FULFILL_COURIER_NAMES[courier]
    credential = (
        org_creds.postex_merchant_token if courier == "postex" else org_creds.couriers_next_auth_key
    )
    if not credential:
        raise HTTPException(status_code=400, detail=f"{courier_name} credentials are not configured for this organization. Set them in Settings > Integrations.")
    try:
        if courier == "postex":
            return {"addresses": await postex.fetch_pickup_addresses(credential)}
        _, shippers = await couriers_next.fetch_shippers(credential)
        return {"addresses": shippers}
    except Exception:
        logger.exception("Failed to fetch pickup addresses for courier %s", courier)
        raise HTTPException(status_code=500, detail="Failed to fetch pickup addresses")


@router.get("/sync-status")
async def get_sync_status(org_id: str = Depends(get_org_id)):
    try:
        supabase = get_supabase()
        row = _get_sync_status_row(supabase, org_id)
        return {"last_synced_at": row.get("last_synced_at"), "in_progress": bool(row.get("in_progress"))}
    except Exception:
        logger.exception("Failed to fetch sync status")
        raise HTTPException(status_code=500, detail="Error fetching sync status")


@router.post("/sync-shopify", response_model=SyncShopifyOrdersResult)
@limiter.limit("10/minute")
async def sync_shopify_orders(request: Request, org_id: str = Depends(get_org_id)):
    return await _sync_shopify_orders(org_id)


@router.post("/upload-postex-csv")
@limiter.limit("10/minute")
async def upload_postex_csv(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    assignment_number: Optional[str] = Form(None),
    org_id: str = Depends(get_org_id),
):
    """
    Upload a PostEx CSV file. Matches rows by ORDER_REF_NUMBER to orders and updates
    delivery_charge (from SHIPPING_CHARGES), tax_amount (GST + WH_INCOME_TAX + WH_SALES_TAX),
    courier (set to PostEx), tracking_number (from TRACKING_NUMBER; parses 14-digit numbers
    including exponential notation e.g. 2.63E+13), optionally folio (from assignment_number),
    and marks the order as settled (the CSV is PostEx's payout report).

    Mirroring those settlements into Shopify runs after the response is sent - it is
    best-effort and far slower than the local write, which the upload should not wait on.
    Only delivered orders are marked paid there; returned/other rows are tagged only.
    """
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a CSV file.")
    try:
        content = await file.read()
        try:
            rows, csv_order_numbers = postex.parse_rows(content)
        except postex.CsvFormatError as e:
            raise HTTPException(status_code=400, detail=str(e))
        if not rows:
            return {"updated": 0, "message": "No valid rows with ORDER_REF_NUMBER in CSV."}
        supabase = get_supabase()
        # Only the orders the CSV actually names - a payout report covers a few hundred
        # rows, so paging the org's whole order table to build the lookup was pure waste.
        # order_number is INTEGER, so the "4446-R" replacement forms normalize_order_number
        # emits cannot go into the filter; they never matched a DB row anyway and still
        # land in unmatched_order_numbers below.
        wanted_order_numbers = sorted({int(n) for n in csv_order_numbers if n.isdigit()})
        if not wanted_order_numbers:
            return {"updated": 0, "message": "No CSV order numbers matched any orders."}
        all_orders = fetch_all(
            lambda: org_table(supabase, org_id, "shopify_orders")
            .select("id, order_number, total_amount, advance_amount, order_status, order_receiving_date, "
                    "delivery_charge, tax_amount, courier, is_order_settled, tracking_number, folio")
            .in_("order_number", wanted_order_numbers)
            .order("order_number")
        )
        order_number_to_order = {}
        db_order_numbers = []
        for o in all_orders:
            on = o.get("order_number")
            if on is not None:
                order_key = str(on)
                order_number_to_order[order_key] = o
                db_order_numbers.append(order_key)
        
        # Find matches and detect receivable vs CSV net amount mismatches
        matched_order_numbers = []
        updated_count = 0
        unmatched_order_numbers = []
        cancelled_order_numbers = []
        updated_order_ids = []
        # Orders whose CSV-derived values (charge/tax/courier/tracking/folio) exactly match what's
        # already stored and already settled - re-uploading the same payout report a second time
        # (e.g. re-checking a file) shouldn't re-push a no-op settlement to Shopify for each one.
        order_numbers_to_push = []
        delivered_order_numbers_to_push = []
        # { order_number, folio, order_status, total_amount, advance_amount, cod, delivery_charge,
        #   tax_amount, receivable, csv_net_amount, mismatch }
        order_breakdown = []
        orders_to_upsert = []
        totals = {
            "total_amount": 0.0, "advance_total": 0.0, "cod_total": 0.0,
            "delivery_charges": 0.0, "taxes": 0.0, "returned_total": 0.0, "net_receivable": 0.0,
        }
        current_time = datetime.now(timezone.utc).isoformat()

        for r in rows:
            order_num = r["order_number"]
            order = order_number_to_order.get(order_num)
            if not order:
                unmatched_order_numbers.append(order_num)
                continue
            if (order.get("order_status") or "").strip().lower() == "cancelled":
                cancelled_order_numbers.append(order_num)
                continue
            matched_order_numbers.append(order_num)
            update_data = {
                "id": order["id"],
                # An upsert is INSERT ... ON CONFLICT, and Postgres checks NOT NULL on the
                # proposed row before it resolves the conflict - so every NOT NULL column
                # without a default has to be carried even though this only ever updates.
                "order_number": order["order_number"],
                "order_status": order["order_status"],
                "total_amount": order["total_amount"],
                "order_receiving_date": order["order_receiving_date"],
                "delivery_charge": r["delivery_charge"],
                "tax_amount": r["tax_amount"],
                "courier": "PostEx",
                "is_order_settled": True,
                "updated_at": current_time,
            }
            if r.get("tracking_number"):
                update_data["tracking_number"] = r["tracking_number"]
            if assignment_number is not None and assignment_number.strip():
                update_data["folio"] = assignment_number.strip()

            order_status = (order.get("order_status") or "").strip().lower()
            is_returned = order_status == "returned"

            unchanged = (
                bool(order.get("is_order_settled"))
                and (order.get("courier") or "") == "PostEx"
                and money(order.get("delivery_charge") or 0) == money(r["delivery_charge"])
                and money(order.get("tax_amount") or 0) == money(r["tax_amount"])
                and (not update_data.get("tracking_number") or order.get("tracking_number") == update_data["tracking_number"])
                and (not update_data.get("folio") or order.get("folio") == update_data["folio"])
            )
            if not unchanged:
                order_numbers_to_push.append(order_num)
                if order_status == "delivered":
                    delivered_order_numbers_to_push.append(order_num)

            orders_to_upsert.append(update_data)
            updated_order_ids.append(order["id"])
            updated_count += 1

            # Receivable must match grid formula: returned -> -delivery_charge; else -> total - advance - delivery - tax
            total_amount = float(order.get("total_amount") or 0)
            advance_amount = float(order.get("advance_amount") or 0)
            delivery_charge = float(r["delivery_charge"])
            tax_amount = float(r["tax_amount"])
            cod = total_amount - advance_amount
            if is_returned:
                receivable = money(-delivery_charge)
            else:
                receivable = money(total_amount - advance_amount - delivery_charge - tax_amount)

            csv_net = r.get("csv_net_amount")
            csv_net_rounded = money(csv_net) if csv_net is not None else None
            order_breakdown.append({
                "order_number": order_num,
                "folio": update_data.get("folio"),
                "order_status": order_status or None,
                "total_amount": money(total_amount),
                "advance_amount": money(advance_amount),
                "cod": money(cod),
                "delivery_charge": money(delivery_charge),
                "tax_amount": money(tax_amount),
                "receivable": receivable,
                "csv_net_amount": csv_net_rounded,
                "mismatch": csv_net_rounded is not None and receivable != csv_net_rounded,
            })
            totals["total_amount"] += total_amount
            totals["advance_total"] += advance_amount
            totals["delivery_charges"] += delivery_charge
            totals["net_receivable"] += receivable
            if is_returned:
                totals["returned_total"] += total_amount
            else:
                totals["cod_total"] += cod
                totals["taxes"] += tax_amount

        if orders_to_upsert:
            batch_size = 1000
            for i in range(0, len(orders_to_upsert), batch_size):
                org_table(supabase, org_id, "shopify_orders").upsert(orders_to_upsert[i:i + batch_size], on_conflict="id").execute()
            event_bus.publish(org_id, {"type": "orders_changed"})
            # The CSV forces courier to PostEx, which re-bills any order that was previously
            # under another courier. Charges/taxes/settled changing needs no bill write at
            # all - the totals view derives those from the orders on every read.
            await _assign_courier_bills(org_id, updated_order_ids)
            # Deferred: the local settlement is already committed above and the push is
            # best-effort, so hundreds of Shopify round trips must not hold the response.
            background_tasks.add_task(
                _push_settlements_to_shopify, order_numbers_to_push, org_id,
                set(delivered_order_numbers_to_push),
            )

        # Build response message with debugging info
        message = f"Updated delivery charges, tax, courier (PostEx), tracking, and marked settled for {updated_count} order(s)."
        if unmatched_order_numbers:
            message += f" {len(unmatched_order_numbers)} order number(s) from CSV did not match any orders."
            if len(unmatched_order_numbers) <= 10:
                message += f" Unmatched: {', '.join(map(str, unmatched_order_numbers[:10]))}"
        if cancelled_order_numbers:
            message += f" {len(cancelled_order_numbers)} order(s) skipped because they are cancelled."

        return {
            "updated": updated_count,
            "message": message,
            "updated_order_ids": updated_order_ids,
            "matched_order_numbers": matched_order_numbers,
            "cancelled_order_numbers": cancelled_order_numbers,
            "csv_rows_processed": len(rows),
            "csv_order_numbers_count": len(csv_order_numbers),
            "db_order_numbers_count": len(set(db_order_numbers)),
            "matched_count": len(matched_order_numbers),
            "unmatched_count": len(unmatched_order_numbers),
            "cancelled_count": len(cancelled_order_numbers),
            "order_breakdown": order_breakdown,
            "totals": {k: money(v) for k, v in totals.items()},
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error processing CSV")
        raise HTTPException(status_code=500, detail="Error processing CSV")


class ForceSyncOrdersBody(BaseModel):
    order_numbers: List[int]


class ForceSyncOrdersResult(BaseModel):
    requested_count: int
    processed_count: int
    created_count: int
    updated_count: int
    created_order_numbers: List[int]
    updated_order_numbers: List[int]
    shopify_fetch_failed_count: int
    shopify_fetch_failed_order_numbers: List[int]


@router.post("/sync-shopify-force", response_model=ForceSyncOrdersResult)
@limiter.limit("10/minute")
async def sync_shopify_orders_force(request: Request, body: ForceSyncOrdersBody, org_id: str = Depends(get_org_id)):
    """
    Force-sync specific orders from Shopify by order number.
    Skips normal sync restrictions (delivered/returned freeze, assigned courier guard, etc.).
    """
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")

    try:
        supabase = get_supabase()
        org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
        current_time = datetime.now(timezone.utc).isoformat()
        order_numbers_input = list(dict.fromkeys(body.order_numbers))

        # products cost map for item-based cost calculation fallback
        products_cost_map: Dict[str, float] = {}
        costs_by_id: Dict[str, float] = {}    # products.id -> cost_price, for line item cost_price snapshots
        product_id_by_shopify: Dict[int, str] = {}   # shopify_product_id -> products.id
        products_response = org_table(supabase, org_id, "shopify_products").select("id, name, cost_price, shopify_product_id").execute()
        for p in products_response.data or []:
            name = (p.get("name") or "").strip().lower()
            if name:
                try:
                    products_cost_map[name] = float(p.get("cost_price") or 0.0)
                except (TypeError, ValueError):
                    products_cost_map[name] = 0.0
            if p.get("shopify_product_id") is not None and p.get("id"):
                product_id_by_shopify[int(p["shopify_product_id"])] = p["id"]
            if p.get("id") and p.get("cost_price") is not None:
                try:
                    costs_by_id[p["id"]] = float(p["cost_price"])
                except (TypeError, ValueError):
                    pass

        variant_id_by_shopify: Dict[int, str] = {}   # shopify_variant_id -> variants.id
        costs_by_variant_id: Dict[str, float] = {}   # variants.id -> cost_price, preferred over costs_by_id
        for v in (org_table(supabase, org_id, "shopify_variants").select("id, shopify_variant_id, cost_price").execute().data or []):
            if v.get("shopify_variant_id") is not None and v.get("id"):
                variant_id_by_shopify[int(v["shopify_variant_id"])] = v["id"]
            if v.get("id") and v.get("cost_price") is not None:
                try:
                    costs_by_variant_id[v["id"]] = float(v["cost_price"])
                except (TypeError, ValueError):
                    pass

        # existing orders map by order_number
        existing_orders_map: Dict[int, Dict[str, Any]] = {}
        existing_rows = (
            org_table(supabase, org_id, "shopify_orders")
            .select(
                "id, order_number, courier, tracking_number, order_status, piece_received, delivery_status, "
                "delivery_charge, tax_amount, order_receiving_date, replacement_of_order_no, "
                "cost_price, line_items"
            )
            .in_("order_number", order_numbers_input)
            .execute()
            .data
            or []
        )
        for row in existing_rows:
            key = row.get("order_number")
            if key is not None:
                existing_orders_map[key] = row

        def _parse_iso_local(s):
            if not s:
                return None
            if isinstance(s, datetime):
                return s
            try:
                return datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
            except (ValueError, TypeError):
                return None

        def extract_courier(order):
            fulfillments = order.get("fulfillments") or []
            if not fulfillments:
                return "Unassigned"
            active = [f for f in fulfillments if f.get("status") != "cancelled"]
            fulfillments_to_check = active if active else fulfillments
            latest_fulfillment = None
            latest_timestamp = None
            for fulfillment in fulfillments_to_check:
                timestamp_str = fulfillment.get("updated_at") or fulfillment.get("created_at")
                ts = _parse_iso_local(timestamp_str)
                if ts and (latest_timestamp is None or ts > latest_timestamp):
                    latest_timestamp = ts
                    latest_fulfillment = fulfillment
            if not latest_fulfillment and fulfillments_to_check:
                latest_fulfillment = fulfillments_to_check[-1]
            tracking_company = (latest_fulfillment or {}).get("tracking_company")
            tracking_company = str(tracking_company or "").strip()
            return tracking_company or "Unassigned"

        def extract_tracking_number(order):
            fulfillments = order.get("fulfillments") or []
            if not fulfillments:
                return None
            active = [f for f in fulfillments if f.get("status") != "cancelled"]
            fulfillments_to_check = active if active else fulfillments
            latest_fulfillment = None
            latest_timestamp = None
            for fulfillment in fulfillments_to_check:
                timestamp_str = fulfillment.get("updated_at") or fulfillment.get("created_at")
                ts = _parse_iso_local(timestamp_str)
                if ts and (latest_timestamp is None or ts > latest_timestamp):
                    latest_timestamp = ts
                    latest_fulfillment = fulfillment
            if not latest_fulfillment and fulfillments_to_check:
                latest_fulfillment = fulfillments_to_check[-1]
            tn = str((latest_fulfillment or {}).get("tracking_number") or "").strip()
            return tn or None

        def extract_order_status(order):
            cancelled_at_raw = order.get("cancelled_at")
            fulfillment_dt = None
            for f in order.get("fulfillments") or []:
                # A cancelled fulfillment never shipped, so it can't make a later
                # order cancellation a "return".
                if f.get("status") == "cancelled":
                    continue
                ct = f.get("created_at")
                parsed = _parse_iso_local(ct)
                if parsed and (fulfillment_dt is None or parsed > fulfillment_dt):
                    fulfillment_dt = parsed
            if cancelled_at_raw and fulfillment_dt is not None:
                cancelled_at = _parse_iso_local(cancelled_at_raw)
                if cancelled_at and cancelled_at > fulfillment_dt:
                    return "returned"
            if cancelled_at_raw is not None:
                return "cancelled"
            fulfillment_status = order.get("fulfillment_status")
            if fulfillment_status == "fulfilled":
                return "fulfilled"
            return "unfulfilled"

        def extract_tax_amount(order):
            if "current_total_tax_set" in order and order["current_total_tax_set"]:
                shop_money = order["current_total_tax_set"].get("shop_money", {})
                if shop_money:
                    try:
                        return float(shop_money.get("amount", "0.00"))
                    except (TypeError, ValueError):
                        pass
            try:
                return float(order.get("current_total_tax") or 0)
            except (TypeError, ValueError):
                pass
            if "total_tax_set" in order and order["total_tax_set"]:
                shop_money = order["total_tax_set"].get("shop_money", {})
                if shop_money:
                    try:
                        return float(shop_money.get("amount", "0.00"))
                    except (TypeError, ValueError):
                        pass
            try:
                return float(order.get("total_tax", "0.00"))
            except (TypeError, ValueError):
                return 0.0

        def extract_cost_price(order):
            for attr in order.get("note_attributes") or []:
                if attr.get("name") in ["cost_price", "Cost Price", "cost"]:
                    try:
                        return float(attr.get("value", 0))
                    except (TypeError, ValueError):
                        return None
            return None

        def extract_line_items(order, order_status=None):
            """Structured line_items (one object per line, real qty) from Shopify line_items.
            Resolves product_id/variant_id via Shopify ids; snapshots name/variant_title/cost_price.
            Excludes removed lines (current_quantity 0) - except for "returned" orders, where
            current_quantity is 0 on every line by definition (the whole order was refunded back),
            so falling back to it would erase the historical record of what was actually
            shipped/invoiced; use the original quantity there instead."""
            rows: List[Dict[str, Any]] = []
            for item in order.get("line_items") or []:
                qty = item.get("quantity") if order_status == "returned" else item.get("current_quantity")
                if qty is None:
                    qty = item.get("quantity") or 0
                try:
                    qty = int(qty)
                except (TypeError, ValueError):
                    qty = 0
                if qty <= 0:
                    continue
                sp_product_id = item.get("product_id")
                sp_variant_id = item.get("variant_id")
                try:
                    unit_price = float(item.get("price") or 0)
                except (TypeError, ValueError):
                    unit_price = 0.0
                resolved_product_id = product_id_by_shopify.get(int(sp_product_id)) if sp_product_id is not None else None
                resolved_variant_id = variant_id_by_shopify.get(int(sp_variant_id)) if sp_variant_id is not None else None
                name = (item.get("title") or item.get("name") or "").strip()
                rows.append({
                    "variant_id": resolved_variant_id,
                    "product_id": resolved_product_id,
                    "name": name,
                    "variant_title": (item.get("variant_title") or "").strip() or "-",
                    "qty": qty,
                    "unit_price": unit_price,
                    "cost_price": _resolve_line_item_cost(
                        name, resolved_product_id, costs_by_id, products_cost_map,
                        resolved_variant_id, costs_by_variant_id,
                    ),
                })
            return rows

        # Bounded concurrency (shares _BULK_CONCURRENCY with the delivery-status bulk fetches
        # below): an unbounded gather here once opened one httpx.AsyncClient per order number
        # simultaneously, which on Windows (uvicorn forces the selector event loop there,
        # capped at ~512 fds by select()) crashed the whole server for large batches.
        fetch_sem = asyncio.Semaphore(_BULK_CONCURRENCY)

        async def _fetch_bounded(n: int):
            async with fetch_sem:
                return await _fetch_shopify_order_by_order_number(n, org_creds)

        fetch_tasks = [_fetch_bounded(n) for n in order_numbers_input]
        fetch_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

        to_insert: List[Dict[str, Any]] = []
        to_update: List[Dict[str, Any]] = []
        created_order_numbers: List[int] = []
        updated_order_numbers: List[int] = []
        shopify_fetch_failed: List[int] = []

        for requested_number, sp_order_result in zip(order_numbers_input, fetch_results):
            if isinstance(sp_order_result, Exception) or not sp_order_result:
                shopify_fetch_failed.append(requested_number)
                continue

            sp_order = sp_order_result
            shopify_order_number_raw = sp_order.get("order_number")
            if shopify_order_number_raw is None:
                shopify_fetch_failed.append(requested_number)
                continue
            shopify_order_number = int(shopify_order_number_raw)
            target_order_number = requested_number if requested_number in existing_orders_map else shopify_order_number
            existing_order = existing_orders_map.get(target_order_number)

            courier = extract_courier(sp_order)
            tracking_number = extract_tracking_number(sp_order)
            order_status = extract_order_status(sp_order)
            shopify_tax = extract_tax_amount(sp_order) or 0.0
            fulfillment_based_total = _order_total_from_fulfillments(sp_order)
            if fulfillment_based_total is not None:
                total_amount = fulfillment_based_total + shopify_tax
            else:
                current_total = sp_order.get("current_total_price")
                total_price_val = sp_order.get("total_price")
                if current_total is not None and str(current_total).strip() != "":
                    total_amount = float(current_total)
                elif total_price_val is not None and str(total_price_val).strip() != "":
                    total_amount = float(total_price_val)
                else:
                    try:
                        total_amount = float(sp_order.get("total_line_items_price") or 0) + shopify_tax
                    except (TypeError, ValueError):
                        total_amount = shopify_tax

            discount_codes = sp_order.get("discount_codes") or []
            normalized_discount_codes = {
                str(code_obj.get("code") or "").strip().upper()
                for code_obj in discount_codes
                if isinstance(code_obj, dict)
            }
            has_price_reduction_discount_code = any(
                code in PRICE_REDUCTION_DISCOUNT_CODES
                for code in normalized_discount_codes
            )
            total_discounts = float(sp_order.get("current_total_discounts") or sp_order.get("total_discounts") or 0)
            financial_status = (sp_order.get("financial_status") or "").strip().lower()
            # A settled COD payout is marked paid in Shopify too, so only an untagged
            # "paid" means the customer paid up front (same rule as shopify_sync's).
            paid_in_advance = financial_status == "paid" and not has_settled_tag(sp_order.get("tags"))
            if has_price_reduction_discount_code:
                total_amount = max(0.0, total_amount - total_discounts)
                advance_amount = total_amount if paid_in_advance else 0.0
            else:
                advance_amount = total_amount if paid_in_advance else total_discounts

            # Shopify zeroes a cancelled order's total - mirror that instead of carrying
            # forward a stale amount (see the same rule in shopify_sync._sync_shopify_orders).
            if order_status == "cancelled":
                total_amount = 0.0
                advance_amount = 0.0

            structured_line_items = extract_line_items(sp_order, order_status)
            cost_price = extract_cost_price(sp_order)
            if cost_price is None or cost_price == 0.0:
                cost_price = _cost_from_line_items(structured_line_items)

            replacement_of = None
            is_replacement_order = False
            tags_raw = sp_order.get("tags")
            tags_str = (tags_raw if isinstance(tags_raw, str) else (str(tags_raw) if tags_raw is not None else "")).strip()
            for tag in tags_str.split(","):
                tag = tag.strip()
                m = re.match(r"^(\d+)-R$", tag, re.IGNORECASE)
                if m:
                    replacement_of = int(m.group(1))
                    is_replacement_order = True
                    break

            # Only refresh line_items/cost_price (which snapshot each line's cost_price) when
            # the order's own items actually changed, or the existing snapshot is missing
            # cost_price/unit_price (e.g. orders backfilled from the old legacy items[]
            # column, which never carried per-item price/cost) - not on every force-sync, so
            # a product's cost_price changing later doesn't silently overwrite a real old
            # order's cost snapshot.
            existing_line_items = existing_order.get("line_items") if existing_order else None
            if (
                existing_order
                and not _line_items_incomplete(existing_line_items)
                and _line_items_signature(structured_line_items) == _line_items_signature(existing_line_items)
            ):
                final_line_items = existing_line_items
                final_cost_price = 0.0 if is_replacement_order else float(existing_order.get("cost_price") or 0.0)
            else:
                final_line_items = structured_line_items
                final_cost_price = 0.0 if is_replacement_order else float(cost_price or 0.0)

            order_received_date = sp_order.get("created_at")
            if order_received_date:
                parsed = _parse_iso_local(order_received_date)
                order_received_date = parsed.isoformat() if parsed else current_time
            else:
                order_received_date = current_time

            other_charge = _delivery_charge_from_other_tags(courier, sp_order.get("tags"))
            delivery_charge = 180.0 if str(courier or "").strip().upper() == "SCS" else (other_charge if other_charge is not None else 0.0)
            tax_amount = 0.0

            if existing_order:
                existing_delivery_charge = float(existing_order.get("delivery_charge") or 0)
                # The courier tag is the authoritative source for "Other" - not stored anywhere
                # to diff against, so just re-derive from Shopify's live tags on every
                # force-sync; falls back to what's on file when no tag matches, so a manually
                # set charge isn't zeroed out just because the order has no courier tag.
                if str(courier or "").strip().lower() == "other":
                    final_delivery_charge = other_charge if other_charge is not None else existing_delivery_charge
                else:
                    final_delivery_charge = existing_delivery_charge
            else:
                final_delivery_charge = delivery_charge

            payload: Dict[str, Any] = {
                "order_number": target_order_number,
                "courier": courier,
                "tracking_number": tracking_number,
                "order_status": order_status,
                "piece_received": (existing_order.get("piece_received") if existing_order else "Pending") or "Pending",
                "delivery_status": existing_order.get("delivery_status") if existing_order else None,
                "total_amount": total_amount,
                "advance_amount": advance_amount,
                "delivery_charge": final_delivery_charge,
                "tax_amount": float(existing_order.get("tax_amount") or 0) if existing_order else tax_amount,
                "cost_price": final_cost_price,
                "order_receiving_date": (existing_order.get("order_receiving_date") if existing_order else order_received_date),
                "line_items": final_line_items,
                "replacement_of_order_no": replacement_of,
                "updated_at": current_time,
            }
            if existing_order:
                payload["id"] = existing_order["id"]
                updated_order_numbers.append(target_order_number)
                to_update.append(payload)
            else:
                payload["created_at"] = current_time
                created_order_numbers.append(target_order_number)
                to_insert.append(payload)

        # Insert/update batches are sent separately, never mixed in the same call: PostgREST's
        # bulk upsert derives its column list from the JSON keys present and fills anything
        # missing with SQL NULL rather than the column's DEFAULT - a payload without "id"
        # (new orders, meant to get the DB-generated UUID) sharing a batch with payloads that
        # do have "id" (existing orders) makes it null out id for the new rows instead of
        # leaving it unset, which trips the NOT NULL constraint.
        batch_size = 500
        for i in range(0, len(to_insert), batch_size):
            batch = to_insert[i:i + batch_size]
            org_table(supabase, org_id, "shopify_orders").insert(batch).execute()
        for i in range(0, len(to_update), batch_size):
            batch = to_update[i:i + batch_size]
            org_table(supabase, org_id, "shopify_orders").upsert(batch, on_conflict="org_id,order_number").execute()
        if to_insert or to_update:
            event_bus.publish(org_id, {"type": "orders_changed"})

        return {
            "requested_count": len(order_numbers_input),
            "processed_count": len(to_insert) + len(to_update),
            "created_count": len(created_order_numbers),
            "updated_count": len(updated_order_numbers),
            "created_order_numbers": created_order_numbers,
            "updated_order_numbers": updated_order_numbers,
            "shopify_fetch_failed_count": len(shopify_fetch_failed),
            "shopify_fetch_failed_order_numbers": shopify_fetch_failed,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/by-number/{order_number}")
async def get_order_by_number(order_number: int, org_id: str = Depends(get_org_id)):
    """Get a single order by order_number. Used when order is not in current grid (e.g. different period)."""
    try:
        supabase = get_supabase()
        response = org_table(supabase, org_id, "shopify_orders").select("*").eq("order_number", order_number).limit(1).execute()
        if not response.data or len(response.data) == 0:
            raise HTTPException(status_code=404, detail="Order not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


class LoadSheetLogCreate(BaseModel):
    assignment_number: str
    rider_name: str
    order_numbers: List[str]
    delivery_charge: Optional[float] = None  # delivery charges to store in log and apply to all orders


class LoadSheetLogResult(BaseModel):
    id: str
    assignment_number: str
    rider_name: str
    order_numbers: List[str]
    delivery_charge: Optional[float] = None
    created_at: Optional[datetime] = None
    # Present only when some of the requested orders were excluded for being cancelled.
    cancelled_order_numbers: Optional[List[str]] = None


# Load Sheet Logs (must be before /{order_id} so "load-sheet-logs" is not matched as order_id)
@router.post("/load-sheet-logs", response_model=LoadSheetLogResult)
async def create_load_sheet_log(body: LoadSheetLogCreate, org_id: str = Depends(get_org_id)):
    """Save a load sheet log (assignment number, rider name, order numbers, delivery_charge). Updates all orders with the given delivery_charge."""
    try:
        if not body.assignment_number or not body.assignment_number.strip():
            raise HTTPException(status_code=400, detail="Assignment number is required")
        if not body.rider_name or not body.rider_name.strip():
            raise HTTPException(status_code=400, detail="Rider name is required")
        if not body.order_numbers:
            raise HTTPException(status_code=400, detail="At least one order is required")
        dc = body.delivery_charge
        if dc is not None and dc < 0:
            raise HTTPException(status_code=400, detail="delivery_charge must be 0 or greater")
        supabase = get_supabase()

        # A cancelled order isn't being shipped, so it can't go on a rider's load sheet.
        status_rows = (
            org_table(supabase, org_id, "shopify_orders")
            .select("order_number, order_status")
            .in_("order_number", body.order_numbers)
            .execute()
            .data
            or []
        )
        cancelled_order_numbers = [
            str(r.get("order_number")) for r in status_rows
            if (r.get("order_status") or "").strip().lower() == "cancelled"
        ]
        order_numbers = [n for n in body.order_numbers if n not in cancelled_order_numbers]
        if not order_numbers:
            raise HTTPException(status_code=400, detail="All selected orders are cancelled")

        row = {
            "assignment_number": body.assignment_number.strip(),
            "rider_name": body.rider_name.strip(),
            "order_numbers": order_numbers,
        }
        if dc is not None:
            row["delivery_charge"] = float(dc)
        response = org_table(supabase, org_id, "shopify_load_sheet_logs").insert(row).execute()
        if not response.data or len(response.data) == 0:
            raise HTTPException(status_code=500, detail="Failed to create load sheet log")
        # Update all orders in this load sheet: set folio to assignment number, and optionally delivery_charge
        update_data = {
            "folio": body.assignment_number.strip(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if dc is not None:
            update_data["delivery_charge"] = float(dc)
        org_table(supabase, org_id, "shopify_orders").update(update_data).in_("order_number", order_numbers).execute()
        event_bus.publish(org_id, {"type": "orders_changed"})
        result = dict(response.data[0])
        if cancelled_order_numbers:
            result["cancelled_order_numbers"] = cancelled_order_numbers
        return result
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/load-sheet-logs", response_model=List[dict])
async def list_load_sheet_logs(org_id: str = Depends(get_org_id)):
    """List all load sheet logs, newest first."""
    try:
        supabase = get_supabase()
        response = (
            org_table(supabase, org_id, "shopify_load_sheet_logs")
            .select("*")
            .execute()
        )
        rows = response.data if response.data is not None else []
        out = []
        allowed_keys = {"id", "assignment_number", "rider_name", "delivery_charge", "created_at", "order_numbers", "order_ids"}
        for row in rows:
            try:
                if isinstance(row, dict):
                    r = {k: v for k, v in row.items() if k in allowed_keys}
                else:
                    r = {k: getattr(row, k, None) for k in allowed_keys if hasattr(row, k)}
                    r = {k: v for k, v in r.items() if v is not None or k in ("order_numbers", "order_ids")}
            except Exception:
                r = {}
            if "order_numbers" not in r and "order_ids" in r:
                r["order_numbers"] = r.get("order_ids")
            out.append(r)
        out.sort(key=lambda x: (x.get("created_at") or ""), reverse=True)
        result = []
        for r in out:
            clean = {}
            for k, v in r.items():
                if hasattr(v, "isoformat"):
                    clean[k] = v.isoformat()
                elif hasattr(v, "hex"):
                    clean[k] = str(v)
                else:
                    clean[k] = v
            result.append(clean)
        return result
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        err_msg = str(e)
        if "does not exist" in err_msg.lower() or "shopify_load_sheet_logs" in err_msg or "relation" in err_msg.lower():
            raise HTTPException(
                status_code=503,
                detail="Load sheet logs table is not set up. Add the shopify_load_sheet_logs table (see supabase_schema.sql) and run the migration."
            )
        raise HTTPException(status_code=500, detail=err_msg)


@router.get("/load-sheet-logs/{log_id}/pdf")
@limiter.limit("10/minute")
async def get_load_sheet_log_pdf(request: Request, log_id: str, org_id: str = Depends(get_org_id)):
    """Regenerate and download the PDF for a load sheet log."""
    try:
        supabase = get_supabase()
        log_response = (
            org_table(supabase, org_id, "shopify_load_sheet_logs")
            .select("*")
            .eq("id", log_id)
            .limit(1)
            .execute()
        )
        if not log_response.data or len(log_response.data) == 0:
            raise HTTPException(status_code=404, detail="Load sheet log not found")
        log_row = log_response.data[0]
        order_numbers = log_row.get("order_numbers") or []
        order_ids = log_row.get("order_ids") or []
        if order_numbers:
            orders_response = org_table(supabase, org_id, "shopify_orders").select("*").in_("order_number", order_numbers).execute()
        elif order_ids:
            orders_response = org_table(supabase, org_id, "shopify_orders").select("*").in_("id", order_ids).execute()
        else:
            raise HTTPException(status_code=400, detail="No orders in this load sheet log")
        orders = orders_response.data or []
        if not orders:
            raise HTTPException(status_code=404, detail="Orders not found")
        assignment_number = (log_row.get("assignment_number") or "").strip() or None
        rider_name = (log_row.get("rider_name") or "").strip() or None
        pdf_buffer = await asyncio.to_thread(
            _generate_pdf_load_sheet, orders, None, assignment_number=assignment_number, rider_name=rider_name
        )
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=load_sheet.pdf"},
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.delete("/load-sheet-logs/{log_id}")
async def delete_load_sheet_log(log_id: str, org_id: str = Depends(get_org_id)):
    """Delete a load sheet log by ID. Clears folio on all orders that were in this load sheet."""
    try:
        supabase = get_supabase()
        # Fetch the log to get order_numbers before deleting
        log_response = org_table(supabase, org_id, "shopify_load_sheet_logs").select("order_numbers").eq("id", log_id).execute()
        if not log_response.data or len(log_response.data) == 0:
            raise HTTPException(status_code=404, detail="Load sheet log not found")
        order_numbers = log_response.data[0].get("order_numbers") or []
        # Clear folio on all orders that were in this load sheet
        if order_numbers:
            org_table(supabase, org_id, "shopify_orders").update({
                "folio": None,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).in_("order_number", order_numbers).execute()
            event_bus.publish(org_id, {"type": "orders_changed"})
        # Delete the load sheet log
        response = (
            org_table(supabase, org_id, "shopify_load_sheet_logs")
            .delete()
            .eq("id", log_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Load sheet log not found")
        return {"message": "Load sheet log deleted"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/returned-delivery-charges-sum")
async def get_returned_delivery_charges_sum(org_id: str = Depends(get_org_id)):
    """Sum of delivery_charge for all orders with order_status 'returned'."""
    try:
        supabase = get_supabase()
        response = (
            org_table(supabase, org_id, "shopify_orders")
            .select("delivery_charge")
            .ilike("order_status", "returned")
            .execute()
        )
        total = sum(float(row.get("delivery_charge") or 0) for row in (response.data or []))
        return {"sum": total}
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/courier-bill-summary-pdf")
@limiter.limit("10/minute")
async def get_courier_bill_summary_pdf(
    request: Request,
    pickup_date: str = Query(..., description="Pickup date as YYYY-MM-DD"),
    courier: str = Query(...),
    org_id: str = Depends(get_org_id),
):
    """Settlement summary PDF for one courier payment bill (one courier's pickup on one day)."""
    try:
        try:
            day = datetime.strptime(pickup_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="pickup_date must be YYYY-MM-DD")

        supabase = get_supabase()
        # courier_pickup_date is TIMESTAMPTZ, so the day is a half-open range rather than an
        # equality match, and the bounds are anchored to PKT - the frontend groups by the
        # browser's local calendar date, and bare dates would be read as UTC, shifting the
        # window five hours and pulling in the neighbouring day's pickups.
        start = datetime(day.year, day.month, day.day, tzinfo=PKT_TIMEZONE)
        response = (
            org_table(supabase, org_id, "shopify_orders")
            .select("*")
            .gte("courier_pickup_date", start.isoformat())
            .lt("courier_pickup_date", (start + timedelta(days=1)).isoformat())
            .execute()
        )
        courier_name = courier.strip()
        orders = [
            row for row in (response.data or [])
            if (row.get("courier") or "").strip().lower() == courier_name.lower()
        ]
        if not orders:
            raise HTTPException(status_code=404, detail="No orders found for this bill")

        pdf_buffer = await asyncio.to_thread(
            generate_courier_bill_summary_pdf, orders, pickup_date, courier_name
        )
        filename = f"courier_summary_{courier_name.replace(' ', '_')}_{pickup_date}.pdf"
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{order_id}")
async def get_order(order_id: str, org_id: str = Depends(get_org_id)):
    """Get a single order by ID"""
    try:
        supabase = get_supabase()
        response = org_table(supabase, org_id, "shopify_orders").select("*").eq("id", order_id).single().execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Order not found")
        return response.data
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/postex-airway-bills")
async def get_postex_airway_bills(order_ids: List[str] = Body(..., embed=False), org_id: str = Depends(get_org_id)):
    """One combined PDF of PostEx airway bills for several booked orders.

    postex.get_airway_bill chunks the tracking numbers across get-invoice calls as needed
    and merges the results, so any selection up to MAX_PDF_BATCH_ORDERS comes back as one
    PDF. Couriers Next has no equivalent batch endpoint (each order's invoice_link is
    independent), so the frontend downloads those directly and only routes PostEx orders
    through this endpoint.
    """
    if not order_ids:
        raise HTTPException(status_code=400, detail="No orders selected.")
    if len(order_ids) > MAX_PDF_BATCH_ORDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot generate airway bills for more than {MAX_PDF_BATCH_ORDERS} orders at once.")

    supabase = get_supabase()
    rows = org_table(supabase, org_id, "shopify_orders").select(
        "id, order_number, courier, tracking_number"
    ).in_("id", order_ids).execute().data or []
    postex_name = _FULFILL_COURIER_NAMES["postex"]
    tracking_numbers = [
        r["tracking_number"] for r in rows
        if (r.get("courier") or "").strip() == postex_name and r.get("tracking_number")
    ]
    if not tracking_numbers:
        raise HTTPException(status_code=400, detail="None of the selected orders are booked PostEx orders.")

    org_creds = get_org_integration_settings(org_id)
    if not org_creds.postex_merchant_token:
        raise HTTPException(status_code=400, detail="PostEx credentials are not configured for this organization.")

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            pdf_bytes = await postex.get_airway_bill(client, org_creds.postex_merchant_token, tracking_numbers)
    except postex.PostexInvoiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": "inline; filename=airway_bills.pdf"},
    )


@router.post("/couriers-next-airway-bills")
async def get_couriers_next_airway_bills(order_ids: List[str] = Body(..., embed=False), org_id: str = Depends(get_org_id)):
    """One combined airway bill URL covering several Couriers Next orders.

    invoicehtml.php accepts a comma-separated order_id list and renders every one on the
    same page (confirmed live) - the same combined-document shape as PostEx's get-invoice,
    so the whole selection resolves to one link via couriers_next.get_airway_bill_link
    (one GetOrderList.php fetch, cached, regardless of how many orders are asked for).
    """
    if not order_ids:
        raise HTTPException(status_code=400, detail="No orders selected.")

    supabase = get_supabase()
    rows = org_table(supabase, org_id, "shopify_orders").select(
        "id, order_number, courier, tracking_number"
    ).in_("id", order_ids).execute().data or []
    couriers_next_name = _FULFILL_COURIER_NAMES["couriers_next"]
    tracking_numbers = [
        r["tracking_number"] for r in rows
        if (r.get("courier") or "").strip() == couriers_next_name and r.get("tracking_number")
    ]
    if not tracking_numbers:
        raise HTTPException(status_code=400, detail="None of the selected orders are booked Couriers Next orders.")

    org_creds = get_org_integration_settings(org_id)
    if not org_creds.couriers_next_auth_key:
        raise HTTPException(status_code=400, detail="Couriers Next credentials are not configured for this organization.")

    try:
        url = await couriers_next.get_airway_bill_link(org_creds.couriers_next_auth_key, tracking_numbers)
    except couriers_next.CouriersNextInvoiceError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"url": url}


def _delivery_status_is_final(delivery_status_data: dict) -> bool:
    """True if latest status is final (Delivered to Customer or Returned at Merchant Warehouse). No need to fetch from PostEx again."""
    if not delivery_status_data:
        return False
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if not latest:
        return False
    if "Delivered to Customer" in latest:
        return True
    if "Returned at Merchant Warehouse" in latest:
        return True
    return False


DELIVERY_STATUS_CACHE_TTL = timedelta(hours=1)


def _delivery_status_is_fresh(delivery_status_data: Optional[dict]) -> bool:
    """True if delivery_status_data was fetched less than an hour ago, so a courier
    API call can be skipped in favor of the cached value."""
    if not delivery_status_data:
        return False
    fetched_at = delivery_status_data.get("fetched_at")
    if not fetched_at:
        return False
    try:
        fetched_dt = datetime.fromisoformat(fetched_at)
    except (ValueError, TypeError):
        return False
    if fetched_dt.tzinfo is None:
        fetched_dt = fetched_dt.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - fetched_dt < DELIVERY_STATUS_CACHE_TTL


def _merge_delivery_status_data(previous: Optional[dict], incoming: Optional[dict]) -> Optional[dict]:
    """Merge a freshly-fetched delivery status onto whatever was on file - a blank
    status_history or latest_status from the courier API (transient glitch, rate limit,
    etc.) must not overwrite the real value already saved, field by field."""
    if not incoming:
        return previous
    merged = dict(incoming)
    if not merged.get("status_history") and previous and previous.get("status_history"):
        merged["status_history"] = previous["status_history"]
    if not merged.get("latest_status") and previous and previous.get("latest_status"):
        merged["latest_status"] = previous["latest_status"]
    return merged


def _delivery_status_indicates_returned(delivery_status_data: dict) -> bool:
    """True if delivery status contains 'Return to KARACHI' (e.g. in latest_status or status_history)."""
    if not delivery_status_data:
        return False
    needle = "Return to KARACHI"
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if needle in latest:
        return True
    for item in delivery_status_data.get("status_history") or []:
        if needle in (item.get("status") or ""):
            return True
    return False


def _delivery_status_indicates_delivered(delivery_status_data: dict) -> bool:
    """True if delivery status contains 'Delivered to Customer' (e.g. in latest_status or status_history)."""
    if not delivery_status_data:
        return False
    needle = "Delivered to Customer"
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if needle in latest:
        return True
    for item in delivery_status_data.get("status_history") or []:
        if needle in (item.get("status") or ""):
            return True
    return False


def _delivery_status_indicates_rfd(delivery_status_data: dict) -> bool:
    """True if delivery status contains 'Attempt Made: RFD' (e.g. in latest_status or status_history)."""
    if not delivery_status_data:
        return False
    needle = "Attempt Made: RFD"
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if needle in latest:
        return True
    for item in delivery_status_data.get("status_history") or []:
        if needle in (item.get("status") or ""):
            return True
    return False


def _delivery_status_indicates_ica(delivery_status_data: dict) -> bool:
    """True if delivery status contains 'Attempt Made: ICA' (e.g. in latest_status or status_history)."""
    if not delivery_status_data:
        return False
    needle = "Attempt Made: ICA"
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if needle in latest:
        return True
    for item in delivery_status_data.get("status_history") or []:
        if needle in (item.get("status") or ""):
            return True
    return False


def _delivery_status_indicates_cna(delivery_status_data: dict) -> bool:
    """True if delivery status contains 'Attempt Made: CNA' (e.g. in latest_status or status_history)."""
    if not delivery_status_data:
        return False
    needle = "Attempt Made: CNA"
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if needle in latest:
        return True
    for item in delivery_status_data.get("status_history") or []:
        if needle in (item.get("status") or ""):
            return True
    return False


def _classify_status(status_text: str, courier_normalized: str) -> Optional[str]:
    """Classify a status text into one of the relevant order statuses.

    Return detection is courier-specific: PostEx flags a return as soon as the parcel
    is en route back to the merchant warehouse; Couriers Next only reports the parcel
    reaching its office. Neither phrase appears in the other courier's statuses.
    """
    if not status_text:
        return None
    status_lower = status_text.lower()
    if courier_normalized == "postex" and "en route to merchant warehouse" in status_lower:
        return "returned"
    if courier_normalized in ("couriersnext", "couriernext") and "parcel return to office" in status_lower:
        return "returned"
    # "Return to KARACHI" is the marker bulk_update_order_status writes for a manual
    # "returned" override (_delivery_status_with_latest_status) - not courier text, so
    # it's checked regardless of courier, and must be classified or a later manual
    # override gets skipped over in favor of an earlier real courier status.
    if "return to karachi" in status_lower:
        return "returned"
    # Handle both PostEx ("Delivered to Customer") and Courier Next ("Delivered ...") variants.
    # "not_delivered"/"not delivered" contain "delivered" too, so they're excluded alongside
    # "undelivered" rather than misclassified as delivered.
    if "delivered to customer" in status_lower or (
        "delivered" in status_lower
        and "undelivered" not in status_lower
        and "not delivered" not in status_lower
        and "not_delivered" not in status_lower
    ):
        return "delivered"
    if "attempt made: rfd" in status_lower:
        return "RFD"
    if "attempt made: ica" in status_lower:
        return "ICA"
    if "attempt made: cna" in status_lower:
        return "CNA"
    return None


def _normalize_courier_name(courier: str) -> str:
    """Normalize courier names for resilient matching."""
    return re.sub(r"[^a-z0-9]+", "", (courier or "").strip().lower())


def _derive_order_status_from_latest(delivery_status_data: dict) -> Optional[str]:
    """
    Derive order_status by finding the most recent RELEVANT status from delivery history.
    Relevant statuses are: delivered, returned, RFD, ICA, CNA.
    This ensures we pick the latest meaningful status, not just the last entry.
    """
    if not delivery_status_data:
        return None

    courier_normalized = _normalize_courier_name(delivery_status_data.get("courier", ""))
    history = delivery_status_data.get("status_history") or []

    # Sort by datetime ascending (oldest first, newest last)
    sorted_history = sorted(
        history,
        key=lambda x: x.get("datetime", "") or ""
    )

    # Find the last relevant status by iterating from newest to oldest
    for entry in reversed(sorted_history):
        status_text = (entry.get("status") or "").strip()
        classified = _classify_status(status_text, courier_normalized)
        if classified:
            return classified

    # Fallback: check latest_status field if no relevant status found in history
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if latest:
        classified = _classify_status(latest, courier_normalized)
        if classified:
            return classified

    return None

@router.post("/", response_model=Order)
async def create_order(order: OrderCreate, org_id: str = Depends(get_org_id)):
    """Create a new order"""
    try:
        supabase = get_supabase()
        order_data = order.model_dump()
        order_data["piece_received"] = "Pending"
        now = datetime.now(timezone.utc).isoformat()
        order_data["created_at"] = now
        order_data["updated_at"] = now
        if not order_data.get("order_receiving_date"):
            order_data["order_receiving_date"] = now
        response = org_table(supabase, org_id, "shopify_orders").insert(order_data).execute()
        event_bus.publish(org_id, {"type": "orders_changed"})
        return response.data[0]
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

def _delivery_status_with_latest_status(existing: Optional[Dict[str, Any]], order_status: str) -> Dict[str, Any]:
    """Build delivery_status JSONB with latest_status set for bulk 'delivered', 'returned', or 'cancelled'.
    Preserves existing keys and uses only JSON-serializable values (str, list, dict).
    """
    if order_status == "delivered":
        latest_status = "Delivered to Customer"
    elif order_status == "returned":
        latest_status = "Return to KARACHI"
    elif order_status == "cancelled":
        latest_status = "Cancelled"
    else:
        latest_status = ""
    now_iso = datetime.now(timezone.utc).isoformat()
    # Start from existing JSONB, keeping only JSON-serializable values
    data: Dict[str, Any] = {}
    if existing:
        for k, v in existing.items():
            if k in ("status_history",):
                continue  # we rebuild below
            if v is None or isinstance(v, (str, int, float, bool)):
                data[k] = v
            elif isinstance(v, dict):
                data[k] = {str(a): b for a, b in v.items() if isinstance(b, (str, int, float, bool, type(None)))}
            else:
                data[k] = v
    data["latest_status"] = latest_status
    # status_history: list of { "status": str, "datetime": str } (and optional status_code, is_active)
    history_raw = (existing or {}).get("status_history")
    history: List[Dict[str, Any]] = []
    if isinstance(history_raw, list):
        for item in history_raw:
            if isinstance(item, dict):
                entry = {
                    "status": str(item.get("status", "")),
                    "datetime": str(item.get("datetime", "")),
                }
                if "status_code" in item and isinstance(item["status_code"], str):
                    entry["status_code"] = item["status_code"]
                if "is_active" in item:
                    entry["is_active"] = bool(item["is_active"])
                history.append(entry)
    new_entry: Dict[str, Any] = {"status": latest_status, "datetime": now_iso}
    if history and history[0].get("status") == latest_status:
        pass  # already at front
    else:
        history.insert(0, new_entry)
    data["status_history"] = history
    data["fetched_at"] = now_iso
    return data


class BulkUpdateStatusBody(BaseModel):
    order_numbers: List[int]
    order_status: str  # "delivered", "returned", or "cancelled"


@router.post("/bulk-update-status")
async def bulk_update_order_status(body: BulkUpdateStatusBody, org_id: str = Depends(get_org_id)):
    """Update order_status and delivery_status.latest_status for multiple orders by order_number."""
    if body.order_status not in ("delivered", "returned", "cancelled"):
        raise HTTPException(status_code=400, detail="order_status must be 'delivered', 'returned', or 'cancelled'")
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    try:
        supabase = get_supabase()
        # Fetch orders so we can merge delivery_status and optionally set piece_received per order
        response = (
            org_table(supabase, org_id, "shopify_orders")
            .select("id, order_number, delivery_status, piece_received")
            .in_("order_number", body.order_numbers)
            .execute()
        )
        orders = response.data or []
        updated_at = datetime.now(timezone.utc).isoformat()
        updated_order_numbers = []
        for order in orders:
            order_id = order.get("id")
            if not order_id:
                continue
            new_delivery_status = _delivery_status_with_latest_status(
                order.get("delivery_status"), body.order_status
            )
            update_payload = {
                "order_status": body.order_status,
                "delivery_status": new_delivery_status,
                "updated_at": updated_at,
            }
            # When marking as delivered: set piece_received to Done only if still Pending (first time). Do not overwrite if user already changed it.
            if body.order_status == "delivered":
                current_piece = (order.get("piece_received") or "").strip().lower()
                if current_piece == "pending":
                    update_payload["piece_received"] = "Done"
            org_table(supabase, org_id, "shopify_orders").update(update_payload).eq("id", order_id).execute()
            onum = order.get("order_number")
            if onum is not None:
                updated_order_numbers.append(onum)
        if updated_order_numbers:
            event_bus.publish(org_id, {"type": "orders_changed"})
        requested_set = set(body.order_numbers)
        updated_set = set(updated_order_numbers)
        not_found_order_numbers = sorted(requested_set - updated_set)
        return {
            "updated_count": len(updated_order_numbers),
            "order_status": body.order_status,
            "requested_count": len(body.order_numbers),
            "updated_order_numbers": sorted(updated_order_numbers),
            "not_found_order_numbers": not_found_order_numbers,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


class BulkUpdatePieceReceivedBody(BaseModel):
    order_numbers: List[int]


class BulkUpdateDeliveryChargeBody(BaseModel):
    order_numbers: List[int]
    delivery_charge: float


@router.post("/bulk-update-delivery-charges")
async def bulk_update_delivery_charges(body: BulkUpdateDeliveryChargeBody, org_id: str = Depends(get_org_id)):
    """Set delivery_charge for multiple orders by order_number."""
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    if body.delivery_charge < 0:
        raise HTTPException(status_code=400, detail="delivery_charge must be 0 or greater")
    try:
        supabase = get_supabase()
        update_data = {
            "delivery_charge": float(body.delivery_charge),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        response = (
            org_table(supabase, org_id, "shopify_orders")
            .update(update_data)
            .in_("order_number", body.order_numbers)
            .execute()
        )
        updated_rows = response.data or []
        updated_order_numbers = [o["order_number"] for o in updated_rows if o.get("order_number") is not None]
        if updated_order_numbers:
            event_bus.publish(org_id, {"type": "orders_changed"})
        requested_set = set(body.order_numbers)
        updated_set = set(updated_order_numbers)
        not_found_order_numbers = sorted(requested_set - updated_set)
        return {
            "updated_count": len(updated_order_numbers),
            "delivery_charge": body.delivery_charge,
            "requested_count": len(body.order_numbers),
            "updated_order_numbers": sorted(updated_order_numbers),
            "not_found_order_numbers": not_found_order_numbers,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/bulk-update-piece-received")
async def bulk_update_piece_received(body: BulkUpdatePieceReceivedBody, org_id: str = Depends(get_org_id)):
    """Set piece_received to 'Received' for multiple orders by order_number."""
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    try:
        supabase = get_supabase()
        update_data = {
            "piece_received": "Received",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        response = (
            org_table(supabase, org_id, "shopify_orders")
            .update(update_data)
            .in_("order_number", body.order_numbers)
            .execute()
        )
        updated_rows = response.data or []
        updated_order_numbers = [o["order_number"] for o in updated_rows if o.get("order_number") is not None]
        if updated_order_numbers:
            event_bus.publish(org_id, {"type": "orders_changed"})
        requested_set = set(body.order_numbers)
        updated_set = set(updated_order_numbers)
        not_found_order_numbers = sorted(requested_set - updated_set)
        return {
            "updated_count": len(updated_order_numbers),
            "piece_received": "Received",
            "requested_count": len(body.order_numbers),
            "updated_order_numbers": sorted(updated_order_numbers),
            "not_found_order_numbers": not_found_order_numbers,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


class BulkUpdateOrderSettledBody(BaseModel):
    order_numbers: List[int]
    is_order_settled: bool = True


@router.post("/bulk-update-order-settled")
async def bulk_update_order_settled(body: BulkUpdateOrderSettledBody, org_id: str = Depends(get_org_id)):
    """Mark (or unmark) multiple orders as paid out by the courier, by order_number."""
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    try:
        supabase = get_supabase()
        update_data = {
            "is_order_settled": body.is_order_settled,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        response = (
            org_table(supabase, org_id, "shopify_orders")
            .update(update_data)
            .in_("order_number", body.order_numbers)
            .execute()
        )
        updated_rows = response.data or []
        updated_order_numbers = [o["order_number"] for o in updated_rows if o.get("order_number") is not None]
        if updated_order_numbers:
            event_bus.publish(org_id, {"type": "orders_changed"})
        # Only settling pushes to Shopify - un-settling can't retract a payment already
        # recorded there, so that stays a local-only correction. Every settled order is
        # tagged there, but only delivered ones are marked paid (see mark_order_settled).
        if body.is_order_settled:
            delivered_order_numbers = {
                o["order_number"] for o in updated_rows
                if o.get("order_number") is not None
                and (o.get("order_status") or "").strip().lower() == "delivered"
            }
            await _push_settlements_to_shopify(updated_order_numbers, org_id, delivered_order_numbers)
        requested_set = set(body.order_numbers)
        updated_set = set(updated_order_numbers)
        not_found_order_numbers = sorted(requested_set - updated_set)
        return {
            "updated_count": len(updated_order_numbers),
            "is_order_settled": body.is_order_settled,
            "requested_count": len(body.order_numbers),
            "updated_order_numbers": sorted(updated_order_numbers),
            "not_found_order_numbers": not_found_order_numbers,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/{order_id}")
async def update_order(order_id: str, order: OrderUpdate, org_id: str = Depends(get_org_id)):
    """Update an existing order"""
    try:
        supabase = get_supabase()
        # Include only fields that were sent (so we can set optional fields like folio to null)
        update_data = {k: v for k, v in order.model_dump(exclude_unset=True).items()}
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
        response = org_table(supabase, org_id, "shopify_orders").update(update_data).eq("id", order_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Order not found")
        event_bus.publish(org_id, {"type": "orders_changed"})
        updated = response.data[0]
        if "courier" in update_data or "courier_pickup_date" in update_data:
            await _assign_courier_bills(org_id, [order_id])
        # If the advance amount changed, recompute this order's advance status.
        if "advance_amount" in update_data and updated.get("order_number"):
            try:
                new_status = recompute_advance_statuses(supabase, org_id, [updated["order_number"]])  # noqa: F841
                # Reflect the recomputed status in the response without a refetch
                refreshed = (
                    org_table(supabase, org_id, "shopify_orders")
                    .select("advance_status")
                    .eq("id", order_id)
                    .limit(1)
                    .execute()
                )
                if refreshed.data:
                    updated["advance_status"] = refreshed.data[0].get("advance_status")
            except Exception:
                pass
        return updated
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

_TZ_OFFSET_NO_COLON_RE = re.compile(r"([+-]\d{2})(\d{2})$")


def _courier_pickup_date_iso(delivery_status_data: dict) -> Optional[str]:
    """Courier pickup date for the courier_pickup_date column. Prefers PostEx's own
    order_pickup_date (their authoritative field, from dist.orderPickupDate) when present;
    otherwise falls back to status_history's second entry (oldest-first) - the first entry
    is the order being booked with the courier, the second is the courier actually
    collecting it. Couriers Next never reports order_pickup_date, so it always uses the
    history fallback. Returns None on missing/unparseable input rather than raising, so a
    save never fails over this."""
    data = delivery_status_data or {}
    raw = data.get("order_pickup_date")
    if not raw:
        history = data.get("status_history") or []
        raw = history[1].get("datetime") if len(history) >= 2 else None
    if not raw:
        return None
    # PostEx timestamps look like "2026-06-15T21:08:08.000+0500" - a UTC offset with no
    # colon, which datetime.fromisoformat() rejects on Python <3.11 ("Invalid isoformat
    # string"). Insert the colon so it parses; Couriers Next's "YYYY-MM-DD HH:MM:SS" (no
    # offset at all) is untouched and already parses fine.
    s = _TZ_OFFSET_NO_COLON_RE.sub(r"\1:\2", str(raw).strip().replace("Z", "+00:00"))
    try:
        return datetime.fromisoformat(s).isoformat()
    except (ValueError, TypeError):
        return None


def _parse_postex_dist(dist: dict, tracking_number: str) -> dict:
    """Normalize a PostEx `dist` object (from track-order or track-bulk-order's
    per-item trackingResponse) into our delivery_status_data shape."""
    status_history_raw = dist.get("transactionStatusHistory", [])
    status_history_parsed = [
        {
            "status": item.get("transactionStatusMessage", ""),
            "status_code": item.get("transactionStatusMessageCode", ""),
            "datetime": item.get("updatedAt", ""),
        }
        for item in status_history_raw
    ]
    # PostEx returns history in reverse chronological order (newest first); re-sort ascending.
    status_history_sorted = sorted(status_history_parsed, key=lambda e: e.get("datetime") or "")
    latest_status = status_history_sorted[-1]["status"] if status_history_sorted else ""
    return {
        "courier": "PostEx",
        "tracking_number": dist.get("trackingNumber", tracking_number),
        "customer_name": dist.get("customerName", ""),
        "order_pickup_date": dist.get("orderPickupDate", ""),
        "status_history": status_history_sorted,
        "latest_status": latest_status,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def _parse_couriersnext_rows(rows: List[dict], tracking_number: str) -> dict:
    """Build delivery_status_data from the history rows belonging to one tracking number."""
    status_history_parsed = [
        {
            "status": item.get("status", "") or "",
            "status_code": item.get("title", "") or "",
            "datetime": item.get("created", "") or "",
        }
        for item in rows
    ]
    # Sort by provider timestamp ascending (oldest first, newest last).
    status_history_sorted = sorted(status_history_parsed, key=lambda x: x.get("datetime", "") or "")
    latest_status = status_history_sorted[-1].get("status", "") if status_history_sorted else ""
    resolved_tracking = (rows[0].get("tracking_no") if rows else None) or tracking_number
    return {
        "courier": "Couriers Next",
        "tracking_number": resolved_tracking,
        "customer_name": "",
        "order_pickup_date": "",
        "status_history": status_history_sorted,
        "latest_status": latest_status,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


COURIERSNEXT_TRACK_URL = "https://portal.couriersnext.com/API/TrackOrder.php"


async def _fetch_couriersnext_rows(client: httpx.AsyncClient, tracking_numbers: List[str]) -> Dict[str, List[dict]]:
    """POST one or many tracking numbers to TrackOrder.php and group the flat history rows
    it returns by tracking number. The API takes a comma-separated list - undocumented, but
    the doc's own overview calls this endpoint "one to many". Separator must be a bare comma:
    a space after it makes the API silently return only the first number's history.
    Numbers it has no record of are simply absent from the response, not an error."""
    response = await client.post(
        COURIERSNEXT_TRACK_URL,
        json={"tracking_no": ",".join(tracking_numbers)},
        headers={"Content-Type": "application/json"},
    )
    response.raise_for_status()
    data = response.json()
    # A rejected request still comes back HTTP 200, as a bare string ("Tracking No is required").
    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail="Invalid response from Couriers Next tracking API")
    rows_by_tracking: Dict[str, List[dict]] = {}
    for item in data:
        if isinstance(item, dict) and item.get("tracking_no"):
            rows_by_tracking.setdefault(str(item["tracking_no"]), []).append(item)
    return rows_by_tracking


async def _fetch_couriersnext_status(client: httpx.AsyncClient, tracking_number: str) -> dict:
    rows_by_tracking = await _fetch_couriersnext_rows(client, [tracking_number])
    return _parse_couriersnext_rows(rows_by_tracking.get(tracking_number, []), tracking_number)


# track-bulk-order takes tracking numbers as repeated query params, so the batch size is
# bounded by URL length, not by any documented cap: 400 in one call returns 414 URI Too Long.
# 100 leaves plenty of headroom.
POSTEX_BULK_BATCH_SIZE = 100

# Each batch costs PostEx ~2s regardless of size, so batches run concurrently rather than
# back to back. Measured over 400 numbers: 10.0s sequential, 3.0s at 4, 2.7s at 8 - past 4
# the courier, not our fan-out, is the limit, so this stays low to avoid hammering them.
POSTEX_BULK_CONCURRENCY = 4


# TrackOrder.php returns every history row for every number in one flat array, so the
# response grows much faster than the request - 200 numbers came back as ~1900 rows / 260KB
# in testing (400 worked too). Batching at 200 keeps responses a sane size.
COURIERSNEXT_BULK_BATCH_SIZE = 200


# Cap on ids per `.in_()` query - keeps the request URL well under server/proxy length
# limits. Order ids are UUIDs (36 chars each), so this is kept lower than the 200-value
# chunk size used elsewhere for short order numbers.
IN_QUERY_ID_CHUNK_SIZE = 100


# Only the columns the bulk delivery-status fetch actually reads. Notably NOT `select("*")`:
# that pulled ~674KB per 300 orders against ~375KB here, most of the difference being
# line_items. delivery_status has to stay - _merge_delivery_status_data falls back to the
# stored status_history when the courier returns a blank one.
DELIVERY_STATUS_ORDER_SELECT = "id, order_status, courier, tracking_number, piece_received, delivery_status"


async def _fetch_couriersnext_bulk(tracking_numbers: List[Tuple[str, str]]) -> Dict[str, dict]:
    """Fetch delivery status for many Couriers Next tracking numbers, batched into as few
    requests as possible. Returns a dict keyed by tracking number."""
    results: Dict[str, dict] = {}
    unique = list(dict.fromkeys(tn for _, tn in tracking_numbers))

    async with httpx.AsyncClient(timeout=60.0) as client:
        for i in range(0, len(unique), COURIERSNEXT_BULK_BATCH_SIZE):
            batch = unique[i:i + COURIERSNEXT_BULK_BATCH_SIZE]
            try:
                rows_by_tracking = await _fetch_couriersnext_rows(client, batch)
            except Exception as e:
                for tn in batch:
                    results[tn] = {"error": str(e)}
                continue
            for tn in batch:
                rows = rows_by_tracking.get(tn)
                results[tn] = (
                    _parse_couriersnext_rows(rows, tn) if rows
                    else {"error": "No Couriers Next record found for this tracking number"}
                )
    return results


# Rows per apply_delivery_status_updates call. Each row carries a full delivery_status
# JSONB blob (status history included), so this bounds the request body rather than any
# server-side limit.
DELIVERY_STATUS_SAVE_BATCH_SIZE = 500


async def _assign_courier_bills(org_id: str, order_ids: List[str]) -> None:
    """Put the given orders on their (courier, pickup date) bill, creating it if needed.
    Call after any write that can change an order's courier or courier_pickup_date; it is
    idempotent, so calling it when nothing relevant changed costs one no-op query.

    Orders whose pickup date moved them off a bill already marked settled are refused by
    the function and logged here - silently rewriting a bill you have closed out with the
    courier would be worse than leaving it stale."""
    if not order_ids:
        return
    try:
        result = await asyncio.to_thread(
            lambda: get_supabase().rpc(
                "assign_courier_bills", {"p_org_id": org_id, "p_order_ids": order_ids}
            ).execute()
        )
        blocked = (result.data or [{}])[0].get("blocked") or []
        if blocked:
            logger.warning(
                "[courier-bills] %d order(s) kept on a settled bill despite a changed "
                "courier/pickup date: %s", len(blocked), blocked,
            )
    except Exception:
        logger.exception("[courier-bills] assignment failed for %d orders", len(order_ids))


async def _save_delivery_status_updates(org_id: str, results: Dict[str, dict], orders_by_id: Dict[str, dict]) -> None:
    """Persist delivery_status (and derived order_status/piece_received) for many orders in
    one round-trip per batch, via the apply_delivery_status_updates RPC. Partial per-column
    updates only - never a full-row write - so a stale in-memory snapshot here can't clobber
    an unrelated field someone else edited meanwhile."""
    updates = []
    for order_id, delivery_status_data in results.items():
        if "error" in delivery_status_data:
            continue
        row = {"id": order_id, "delivery_status": delivery_status_data}
        pickup_date = _courier_pickup_date_iso(delivery_status_data)
        if pickup_date:
            row["courier_pickup_date"] = pickup_date
        derived_status = _derive_order_status_from_latest(delivery_status_data)
        if derived_status:
            row["order_status"] = derived_status
            # Only on the first transition to delivered - never overwrite a value the user set.
            if derived_status == "delivered" and (orders_by_id[order_id].get("piece_received") or "").strip().lower() == "pending":
                row["piece_received"] = "Done"
        updates.append(row)

    if not updates:
        return

    supabase = get_supabase()
    for i in range(0, len(updates), DELIVERY_STATUS_SAVE_BATCH_SIZE):
        batch = updates[i:i + DELIVERY_STATUS_SAVE_BATCH_SIZE]
        try:
            await asyncio.to_thread(
                lambda b=batch: supabase.rpc(
                    "apply_delivery_status_updates", {"p_org_id": org_id, "p_updates": b}
                ).execute()
            )
        except Exception:
            logger.exception(f"[delivery-status-bulk] Failed to save {len(batch)} orders")

    event_bus.publish(org_id, {"type": "orders_changed"})

    # Every write site that fills courier_pickup_date re-runs assignment (get_delivery_status
    # does the single-order equivalent). Best-effort: a failure here leaves the orders
    # correctly saved but unassigned, and the next run picks them up (assign is idempotent).
    await _assign_courier_bills(org_id, [u["id"] for u in updates if "courier_pickup_date" in u])


async def _fetch_postex_bulk(
    tracking_numbers: List[str], postex_token: str, with_raw: bool = False
) -> Dict[str, dict]:
    """Fetch delivery status for many PostEx tracking numbers in as few requests as possible.
    Returns a dict keyed by tracking number; numbers PostEx has no record of are simply absent.

    with_raw additionally carries PostEx's untouched trackingResponse under "_raw", which the
    settlement fetch needs for the fee/tax/invoice fields delivery_status_data drops."""
    if not tracking_numbers:
        return {}
    if not postex_token:
        raise HTTPException(status_code=400, detail="PostEx credentials are not configured for this organization. Set them in Settings > Integrations.")

    url = "https://api.postex.pk/services/integration/api/order/v1/track-bulk-order"
    batches = [
        tracking_numbers[i:i + POSTEX_BULK_BATCH_SIZE]
        for i in range(0, len(tracking_numbers), POSTEX_BULK_BATCH_SIZE)
    ]
    semaphore = asyncio.Semaphore(POSTEX_BULK_CONCURRENCY)

    async def fetch_batch(client: httpx.AsyncClient, batch: List[str]) -> dict:
        async with semaphore:
            # Doc says GET; body-less GET is what actually works, tracking numbers as repeated
            # query params (not the POST+JSON-body shape the doc's example implies).
            response = await client.get(
                url,
                headers={"token": postex_token},
                params=[("TrackingNumbers", tn) for tn in batch],
            )
            response.raise_for_status()
            return response.json()

    results: Dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=60.0) as client:
        # One failed batch must not lose the others' results - the caller reports per-order
        # errors for whatever is missing from the returned dict.
        responses = await asyncio.gather(
            *(fetch_batch(client, b) for b in batches), return_exceptions=True
        )
    for batch, data in zip(batches, responses):
        if isinstance(data, BaseException):
            logger.warning(f"[postex-bulk] Batch of {len(batch)} failed: {data}")
            continue
        if data.get("statusCode") != "200":
            continue
        for item in data.get("dist") or []:
            tr = item.get("trackingResponse") or {}
            tn = tr.get("trackingNumber")
            if tn:
                parsed = _parse_postex_dist(tr, tn)
                if with_raw:
                    parsed["_raw"] = tr
                results[tn] = parsed
    return results


async def _fetch_postex_payment_statuses(
    tracking_numbers: List[str], postex_token: str
) -> Dict[str, dict]:
    """Payment-status for many tracking numbers. There is no bulk endpoint, so this is one
    request per number, fanned out at the same concurrency as _fetch_postex_bulk. Returns
    postex.parse_payment_status() output keyed by tracking number; a number that errors is
    simply absent, and the caller settles it without a folio until the next run."""
    if not tracking_numbers:
        return {}

    url = "https://api.postex.pk/services/integration/api/order/v1/payment-status/"
    semaphore = asyncio.Semaphore(POSTEX_BULK_CONCURRENCY)

    async def fetch_one(client: httpx.AsyncClient, tn: str) -> tuple:
        async with semaphore:
            response = await client.get(url + tn, headers={"token": postex_token})
            response.raise_for_status()
            return tn, response.json()

    async with httpx.AsyncClient(timeout=60.0) as client:
        responses = await asyncio.gather(
            *(fetch_one(client, tn) for tn in tracking_numbers), return_exceptions=True
        )

    results: Dict[str, dict] = {}
    for item in responses:
        if isinstance(item, BaseException):
            logger.warning(f"[postex-payment-status] fetch failed: {item}")
            continue
        tn, data = item
        if data.get("statusCode") == "200":
            results[tn] = postex.parse_payment_status(data.get("dist"))
    return results


@router.get("/{order_id}/delivery-status")
async def get_delivery_status(order_id: str, save: bool = Query(False, description="If true, store fetched status in order.delivery_status"), force: bool = Query(False, description="If true, skip the cached-value check and always hit the courier API"), org_id: str = Depends(get_org_id)):
    """Fetch delivery status from courier API. Optionally store in order.delivery_status when save=true."""
    try:
        supabase = get_supabase()
        # Use limit(1) instead of single() so "not found" returns 404, not 500
        order_response = org_table(supabase, org_id, "shopify_orders").select("*").eq("id", order_id).limit(1).execute()
        
        if not order_response.data or len(order_response.data) == 0:
            raise HTTPException(status_code=404, detail="Order not found")
        
        order = order_response.data[0]
        if (order.get("order_status") or "").strip().lower() == "cancelled":
            raise HTTPException(status_code=400, detail="Order is cancelled")

        courier = order.get("courier", "").strip()
        courier_normalized = _normalize_courier_name(courier)
        tracking_number = order.get("tracking_number", "").strip()

        if not tracking_number:
            raise HTTPException(status_code=400, detail="Tracking number not available")

        if courier_normalized == "unassigned":
            raise HTTPException(status_code=400, detail="Courier not assigned")
        
        delivery_status_data = None
        existing_delivery = order.get("delivery_status")

        if not force and _delivery_status_is_fresh(existing_delivery):
            return existing_delivery

        if courier_normalized in ("postex",):
            org_creds = get_org_integration_settings(org_id)
            if not org_creds.postex_merchant_token:
                raise HTTPException(status_code=400, detail="PostEx credentials are not configured for this organization. Set them in Settings > Integrations.")
            # Always fetch fresh data from PostEx to ensure we have the latest status
            # (Previously we skipped fetch for "final" statuses, but this caused stale data issues)
            # Uses the merchant-authenticated endpoint (own account rate limit) instead of the
            # shared public guest endpoint, which required throttling to avoid rate limits.
            async with httpx.AsyncClient(timeout=30.0) as client:
                api_url = f"https://api.postex.pk/services/integration/api/order/v1/track-order/{tracking_number}"
                response = await client.get(api_url, headers={"token": org_creds.postex_merchant_token})
                response.raise_for_status()
                data = response.json()
                if data.get("statusCode") == "200" and "dist" in data:
                    delivery_status_data = _parse_postex_dist(data["dist"], tracking_number)
        elif courier_normalized in ("couriersnext", "couriernext"):
            async with httpx.AsyncClient(timeout=30.0) as client:
                delivery_status_data = await _fetch_couriersnext_status(client, tracking_number)
        else:
            raise HTTPException(status_code=400, detail="Only PostEx and Couriers Next are supported for delivery status tracking")
        
        if not delivery_status_data:
            raise HTTPException(status_code=500, detail="Failed to fetch delivery status")

        delivery_status_data = _merge_delivery_status_data(existing_delivery, delivery_status_data)

        # Persist fetched data and update order_status when save=true
        if save:
            update_payload = {
                "delivery_status": delivery_status_data,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            pickup_date = _courier_pickup_date_iso(delivery_status_data)
            if pickup_date:
                update_payload["courier_pickup_date"] = pickup_date
            # Derive order_status from the LAST courier status instead of using a fixed priority.
            derived_status = _derive_order_status_from_latest(delivery_status_data)
            logger.info(f"[delivery-status] order_id={order_id} latest_status={delivery_status_data.get('latest_status')!r} derived_status={derived_status!r}")
            if derived_status:
                update_payload["order_status"] = derived_status
                logger.info(f"[delivery-status] Updating order_status to {derived_status}")
                if derived_status == "delivered":
                    # Set piece_received to Done only when still Pending (first time delivered). Do not overwrite if user already changed it.
                    current_piece = (order.get("piece_received") or "").strip().lower()
                    if current_piece == "pending":
                        update_payload["piece_received"] = "Done"
            else:
                logger.info(f"[delivery-status] No derived_status, order_status not updated")
            org_table(supabase, org_id, "shopify_orders").update(update_payload).eq("id", order_id).execute()
            event_bus.publish(org_id, {"type": "orders_changed"})
            logger.info(f"[delivery-status] Update payload: {update_payload.keys()}")

            if "courier_pickup_date" in update_payload:
                await _assign_courier_bills(org_id, [order_id])

        return delivery_status_data
        
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Failed to fetch delivery status: {e.response.text}")
    except httpx.RequestError as e:
        err_msg = str(e) or getattr(e, "message", "") or type(e).__name__
        raise HTTPException(
            status_code=500,
            detail=f"Could not reach the courier tracking site ({type(e).__name__}: {err_msg}). "
                   "Check that this server can access the internet and that the courier site is not blocked."
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error fetching delivery status")
        raise HTTPException(status_code=500, detail="Error fetching delivery status")

@router.post("/delivery-status/bulk")
async def get_delivery_status_bulk(
    order_ids: List[str] = Body(..., embed=False),
    save: bool = Query(False, description="If true, store fetched status in each order's delivery_status"),
    org_id: str = Depends(get_org_id),
):
    """Fetch delivery status for many orders at once, batched per courier: PostEx via
    track-bulk-order, Couriers Next via TrackOrder.php's comma-separated list."""
    if not order_ids:
        raise HTTPException(status_code=400, detail="No orders selected")
    try:
        supabase = get_supabase()
        chunks = [order_ids[i:i + IN_QUERY_ID_CHUNK_SIZE] for i in range(0, len(order_ids), IN_QUERY_ID_CHUNK_SIZE)]

        def fetch_chunk(chunk):
            # Own client per chunk - sharing one client's HTTP/2 connection across threads
            # crashes with a stream-read error (same reason as advance_status.py's fetch_chunk).
            client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY) if len(chunks) > 1 else supabase
            return org_table(client, org_id, "shopify_orders").select(DELIVERY_STATUS_ORDER_SELECT).in_("id", chunk).execute().data or []

        if len(chunks) > 1:
            chunk_rows = await asyncio.gather(*(asyncio.to_thread(fetch_chunk, c) for c in chunks))
        else:
            chunk_rows = [await asyncio.to_thread(fetch_chunk, chunks[0])] if chunks else []
        orders_by_id = {o["id"]: o for rows in chunk_rows for o in rows}

        postex_orders: List[Tuple[str, str]] = []
        couriersnext_orders: List[Tuple[str, str]] = []
        results: Dict[str, dict] = {}
        fresh_ids: set = set()

        for order_id in order_ids:
            order = orders_by_id.get(order_id)
            if not order:
                results[order_id] = {"error": "Order not found"}
                continue
            if (order.get("order_status") or "").strip().lower() == "cancelled":
                results[order_id] = {"error": "Order is cancelled"}
                continue
            existing_delivery = order.get("delivery_status")
            if _delivery_status_is_fresh(existing_delivery):
                results[order_id] = existing_delivery
                fresh_ids.add(order_id)
                continue
            courier_normalized = _normalize_courier_name(order.get("courier", "").strip())
            tracking_number = (order.get("tracking_number") or "").strip()
            if not tracking_number:
                results[order_id] = {"error": "Tracking number not available"}
                continue
            if courier_normalized == "postex":
                postex_orders.append((order_id, tracking_number))
            elif courier_normalized in ("couriersnext", "couriernext"):
                couriersnext_orders.append((order_id, tracking_number))
            else:
                results[order_id] = {"error": "Courier not supported for delivery status tracking"}

        if postex_orders:
            # Only read once a PostEx order is actually in the batch - a Couriers-Next-only
            # refresh has no use for these credentials.
            org_creds = get_org_integration_settings(org_id)
            postex_by_tracking = await _fetch_postex_bulk([tn for _, tn in postex_orders], org_creds.postex_merchant_token)
            for order_id, tracking_number in postex_orders:
                data = postex_by_tracking.get(tracking_number)
                results[order_id] = (
                    _merge_delivery_status_data(orders_by_id[order_id].get("delivery_status"), data)
                    if data else {"error": "No PostEx record found for this tracking number"}
                )

        if couriersnext_orders:
            couriersnext_by_tracking = await _fetch_couriersnext_bulk(couriersnext_orders)
            for order_id, tracking_number in couriersnext_orders:
                data = couriersnext_by_tracking[tracking_number]
                results[order_id] = (
                    _merge_delivery_status_data(orders_by_id[order_id].get("delivery_status"), data)
                    if "error" not in data else data
                )

        if save:
            to_save = {oid: data for oid, data in results.items() if oid not in fresh_ids}
            await _save_delivery_status_updates(org_id, to_save, orders_by_id)

        response_list = []
        for order_id in order_ids:
            data = results.get(order_id, {"error": "Unknown error"})
            if "error" in data:
                response_list.append({"order_id": order_id, "error": data["error"]})
            else:
                response_list.append({"order_id": order_id, "delivery_status": data})
        return response_list
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error fetching bulk delivery status")
        raise HTTPException(status_code=500, detail="Error fetching delivery status")

@router.post("/fetch-postex-settlements")
async def fetch_postex_settlements(
    apply: bool = Query(True, description="If false, report what PostEx returns without writing"),
    recheck_derived: bool = Query(False, description="Also re-derive orders this endpoint already settled, correcting stale figures"),
    org_id: str = Depends(get_org_id),
):
    """Settle unsettled PostEx orders from the tracking API.

    Scans every unsettled, uncancelled PostEx order with a tracking number, asks PostEx for
    its current state, and for the ones it reports delivered or returned writes back
    delivery_charge, tax_amount and folio, marking them settled.

    delivery_charge is PostEx's own fee + GST. tax_amount is DERIVED (see
    postex.settlement_from_tracking) because the API never reports withholding - rows written
    here carry tax_amount_derived so a later CPR CSV upload overrides them with real figures.

    The folio is the payout date: a delivery's reservePaymentDate rides along in the bulk
    response, while a return's shows only on the per-order Payment Status API, fetched here
    for the returns in scope.

    recheck_derived additionally revisits orders this endpoint already settled, so a fix to
    the derivation can be applied to rows written under the old one. It deliberately never
    touches CSV-settled rows: those carry PostEx's authoritative figures, which a derivation
    must not overwrite.
    """
    try:
        supabase = get_supabase()
        def _candidate_query():
            q = (
                org_table(supabase, org_id, "shopify_orders")
                .select("id, order_number, tracking_number, order_status, total_amount, advance_amount, order_receiving_date, folio, courier, delivery_charge, tax_amount, is_order_settled")
                .eq("courier", "PostEx")
                .not_.is_("tracking_number", "null")
                .neq("tracking_number", "")
            )
            # Unsettled rows are always in scope; recheck_derived widens that to rows this
            # endpoint settled itself, which tax_amount_derived is exactly what identifies.
            q = q.or_("is_order_settled.eq.false,tax_amount_derived.eq.true") if recheck_derived else q.eq("is_order_settled", False)
            return q.order("order_number")

        candidates = fetch_all(_candidate_query)
        candidates = [
            o for o in candidates
            if (o.get("order_status") or "").strip().lower() != "cancelled"
            and str(o.get("tracking_number") or "").strip()
        ]
        if not candidates:
            return {"checked": 0, "updated": 0, "settlements": [], "message": "No unsettled PostEx orders with a tracking number."}

        org_creds = get_org_integration_settings(org_id)
        if not org_creds.postex_merchant_token:
            raise HTTPException(status_code=400, detail="PostEx credentials are not configured for this organization. Set them in Settings > Integrations.")

        by_tracking = await _fetch_postex_bulk(
            [str(o["tracking_number"]).strip() for o in candidates],
            org_creds.postex_merchant_token,
            with_raw=True,
        )

        # A delivery's folio is its reservePaymentDate, already in the bulk response. A
        # return carries none - its payout, and the CPR date the folio records, show only
        # on the per-order Payment Status API. Fetch it for the returns that still need it:
        # unsettled, or settled here earlier before this lookup existed.
        returned_tracking = []
        for candidate in candidates:
            tn = str(candidate["tracking_number"]).strip()
            raw = (by_tracking.get(tn) or {}).get("_raw") or {}
            if str(raw.get("transactionStatus") or "").strip().lower() == "returned" and not (
                candidate.get("is_order_settled") and (candidate.get("folio") or "").strip()
            ):
                returned_tracking.append(tn)
        payment_status_by_tracking = await _fetch_postex_payment_statuses(
            returned_tracking, org_creds.postex_merchant_token
        )

        settlements = []
        orders_to_upsert = []
        pending = []
        not_found = []
        unchanged = 0
        current_time = datetime.now(timezone.utc).isoformat()

        for order in candidates:
            tn = str(order["tracking_number"]).strip()
            fetched = by_tracking.get(tn)
            if not fetched:
                not_found.append(order.get("order_number"))
                continue
            derived = postex.settlement_from_tracking(
                fetched.get("_raw") or {},
                payment_status=payment_status_by_tracking.get(tn),
            )
            if derived is None:
                pending.append({
                    "order_number": order.get("order_number"),
                    "latest_status": fetched.get("latest_status") or "",
                })
                continue

            total_amount = float(order.get("total_amount") or 0)
            advance_amount = float(order.get("advance_amount") or 0)
            dc = derived["delivery_charge"]
            tax = derived["tax_amount"]
            is_return = derived["order_status"] == "returned"
            receivable = money(-dc) if is_return else money(total_amount - advance_amount - dc - tax)

            was_settled = bool(order.get("is_order_settled"))
            changed = (
                abs(dc - round(float(order.get("delivery_charge") or 0), 2)) > 0.011
                or abs(tax - round(float(order.get("tax_amount") or 0), 2)) > 0.011
                or bool(derived["folio"]) and derived["folio"] != (order.get("folio") or "")
            )
            # A recheck pass re-reads rows that are already correct; skip them so it writes
            # only genuine corrections and the summary is not padded with no-ops.
            if was_settled and not changed:
                unchanged += 1
                continue

            # A return whose payout PostEx has not booked to a CPR yet derives no folio -
            # keep the existing one; the next run fills it once the CPR date is available.
            folio = derived["folio"] or (order.get("folio") or "")
            settlements.append({
                "corrected": was_settled,
                "order_number": order.get("order_number"),
                "tracking_number": tn,
                "order_status": derived["order_status"],
                "folio": folio,
                "settlement_date": derived["settlement_date"],
                "invoice_payment": derived["invoice_payment"],
                "delivery_charge": dc,
                "tax_amount": tax,
                "receivable": receivable,
                "paid": derived["settled"],
            })
            if not apply:
                continue
            orders_to_upsert.append({
                "id": order["id"],
                # Upsert is INSERT ... ON CONFLICT and Postgres checks NOT NULL before
                # resolving the conflict, so every NOT NULL column without a default rides
                # along on this update-only write (same reason as upload_postex_csv). org_id
                # is the one exception - org_table.upsert injects it.
                "order_number": order["order_number"],
                "order_status": order["order_status"],
                "total_amount": order["total_amount"],
                "order_receiving_date": order["order_receiving_date"],
                "courier": order["courier"],
                "delivery_charge": dc,
                "tax_amount": tax,
                "tax_amount_derived": True,
                "is_order_settled": True,
                "updated_at": current_time,
            })
            if derived["folio"]:
                orders_to_upsert[-1]["folio"] = derived["folio"]

        if orders_to_upsert:
            for i in range(0, len(orders_to_upsert), 1000):
                org_table(supabase, org_id, "shopify_orders").upsert(orders_to_upsert[i:i + 1000], on_conflict="id").execute()
            event_bus.publish(org_id, {"type": "orders_changed"})

        updated = len(orders_to_upsert)
        corrected = sum(1 for s in settlements if s["corrected"])
        newly = len(settlements) - corrected
        if apply:
            message = f"Settled {newly} order(s) from PostEx."
            if corrected:
                message += f" Corrected {corrected} previously derived order(s)."
        else:
            message = f"{newly} order(s) ready to settle, {corrected} to correct (preview only, nothing written)."
        if pending:
            message += f" {len(pending)} still in transit."
        if not_found:
            message += f" {len(not_found)} not found at PostEx."

        return {
            "checked": len(candidates),
            "updated": updated,
            "corrected": corrected,
            "unchanged": unchanged,
            "applied": apply,
            "settlements": settlements,
            "pending": pending,
            "not_found": not_found,
            "message": message,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("Error fetching PostEx settlements")
        raise HTTPException(status_code=500, detail="Error fetching PostEx settlements")


@router.delete("/{order_id}")
async def delete_order(order_id: str, org_id: str = Depends(get_org_id)):
    """Delete an order"""
    try:
        supabase = get_supabase()
        response = org_table(supabase, org_id, "shopify_orders").delete().eq("id", order_id).execute()
        event_bus.publish(org_id, {"type": "orders_changed"})
        return {"message": "Order deleted successfully"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/generate-invoice")
@limiter.limit("10/minute")
async def generate_invoice(request: Request, order_ids: List[str] = Body(..., embed=False), org_id: str = Depends(get_org_id)):
    """Generate a PDF invoice with one table per selected order."""
    try:
        if not order_ids:
            raise HTTPException(status_code=400, detail="No orders selected")
        if len(order_ids) > MAX_PDF_BATCH_ORDERS:
            raise HTTPException(status_code=400, detail=f"Cannot generate an invoice for more than {MAX_PDF_BATCH_ORDERS} orders at once")
        supabase = get_supabase()
        org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
        orders_response = org_table(supabase, org_id, "shopify_orders").select("*").in_("id", order_ids).execute()
        orders = orders_response.data or []
        if not orders:
            raise HTTPException(status_code=404, detail="No orders found")
        # Bounded concurrency (shares _BULK_CONCURRENCY with sync_shopify_orders_force's
        # fetch below): an unbounded gather here once opened one httpx.AsyncClient per
        # order simultaneously, which on Windows (uvicorn forces the selector event loop
        # there, capped at ~512 fds by select()) crashed the whole server for large batches.
        invoice_fetch_sem = asyncio.Semaphore(_BULK_CONCURRENCY)

        async def _fetch_bounded(num: str):
            if not num:
                return None
            async with invoice_fetch_sem:
                try:
                    return await _fetch_shopify_order_by_order_number(num, org_creds)
                except Exception:
                    return None

        order_numbers = [str(o.get("order_number") or "").strip() for o in orders]
        sp_orders = await asyncio.gather(*(_fetch_bounded(num) for num in order_numbers))
        merged = [_build_invoice_order_context(o, sp_order) for o, sp_order in zip(orders, sp_orders)]
        pdf_buffer = await asyncio.to_thread(_generate_pdf_invoice, merged)
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=invoice.pdf"}
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error generating invoice")
        raise HTTPException(status_code=500, detail="Error generating invoice")


class OrderShippingInfo(BaseModel):
    order_number: int
    customer_name: str
    phone: str
    city: str


@router.post("/shipping-info", response_model=List[OrderShippingInfo])
@limiter.limit("10/minute")
async def get_orders_shipping_info(request: Request, order_ids: List[str] = Body(..., embed=False), org_id: str = Depends(get_org_id)):
    """Customer name/phone/city for the Courier Payment Report's bundle detail screen -
    read straight off shopify_orders (captured once per order at sync time; see
    shopify_sync._apply_customer_fields), no live Shopify lookup."""
    try:
        if not order_ids:
            raise HTTPException(status_code=400, detail="No orders selected")
        if len(order_ids) > MAX_PDF_BATCH_ORDERS:
            raise HTTPException(status_code=400, detail=f"Cannot look up shipping info for more than {MAX_PDF_BATCH_ORDERS} orders at once")
        supabase = get_supabase()
        orders_response = (
            org_table(supabase, org_id, "shopify_orders")
            .select("order_number, customer_name, customer_phone, customer_city")
            .in_("id", order_ids)
            .execute()
        )
        orders = orders_response.data or []
        if not orders:
            raise HTTPException(status_code=404, detail="No orders found")

        return [
            {
                "order_number": o.get("order_number"),
                "customer_name": o.get("customer_name") or "-",
                "phone": o.get("customer_phone") or "-",
                "city": o.get("customer_city") or "-",
            }
            for o in orders
        ]
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/generate-packaging-list")
@limiter.limit("10/minute")
async def generate_packaging_list(request: Request, order_ids: List[str] = Body(..., embed=False), org_id: str = Depends(get_org_id)):
    """
    Generate a combined packaging list PDF for the selected orders.
    Combines identical products across orders and counts each variant, so all
    products for a batch of orders can be fetched at once.
    """
    try:
        if not order_ids:
            raise HTTPException(status_code=400, detail="No orders selected")
        if len(order_ids) > MAX_PDF_BATCH_ORDERS:
            raise HTTPException(status_code=400, detail=f"Cannot generate a packaging list for more than {MAX_PDF_BATCH_ORDERS} orders at once")
        supabase = get_supabase()
        orders_response = org_table(supabase, org_id, "shopify_orders").select("id, order_number, order_status, line_items").in_("id", order_ids).execute()
        orders = orders_response.data or []
        if not orders:
            raise HTTPException(status_code=404, detail="No orders found")
        cancelled_count = sum(1 for o in orders if (o.get("order_status") or "").strip().lower() == "cancelled")
        orders = [o for o in orders if (o.get("order_status") or "").strip().lower() != "cancelled"]
        if not orders:
            raise HTTPException(status_code=400, detail="All selected orders are cancelled")
        products = org_table(supabase, org_id, "shopify_products").select("id, name, collection").execute().data or []
        resolve_collection = shopify.build_collection_resolver(products)
        aggregated, sizes = _aggregate_packaging_items(orders, resolve_collection)
        pdf_buffer = await asyncio.to_thread(_generate_pdf_packaging_list, aggregated, sizes, len(orders))
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={
                "Content-Disposition": "attachment; filename=packaging_list.pdf",
                "X-Cancelled-Excluded": str(cancelled_count),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error generating packaging list")
        raise HTTPException(status_code=500, detail="Error generating packaging list")


@router.post("/extract-order-numbers-from-pdf")
async def extract_order_numbers_from_pdf(file: UploadFile = File(...)):
    """Extract order numbers (#XXXX, 4-5 digits) from an uploaded labels PDF."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF file.")
    try:
        content = await file.read()
        order_numbers = extract_order_numbers(content)
        return {"order_numbers": order_numbers, "count": len(order_numbers)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Could not read PDF")
        raise HTTPException(status_code=400, detail="Could not read PDF")


class PackagingListByNumbersBody(BaseModel):
    order_numbers: List[int]


@router.post("/generate-packaging-list-by-numbers")
@limiter.limit("10/minute")
async def generate_packaging_list_by_numbers(request: Request, body: PackagingListByNumbersBody, org_id: str = Depends(get_org_id)):
    """
    Generate a combined packaging list PDF for orders identified by order_number
    (rather than by id). Mirrors /generate-packaging-list.
    """
    try:
        order_numbers = list(dict.fromkeys(body.order_numbers))
        if not order_numbers:
            raise HTTPException(status_code=400, detail="No order numbers provided")
        if len(order_numbers) > MAX_PDF_BATCH_ORDERS:
            raise HTTPException(status_code=400, detail=f"Cannot generate a packaging list for more than {MAX_PDF_BATCH_ORDERS} orders at once")
        supabase = get_supabase()
        orders_response = (
            org_table(supabase, org_id, "shopify_orders")
            .select("id, order_number, order_status, line_items")
            .in_("order_number", order_numbers)
            .execute()
        )
        orders = orders_response.data or []
        if not orders:
            raise HTTPException(status_code=404, detail="No orders found for the given order numbers")
        found = {o.get("order_number") for o in orders}
        not_found = sorted(set(order_numbers) - found, key=_order_number_sort_key)
        cancelled = sorted(
            (o.get("order_number") for o in orders if (o.get("order_status") or "").strip().lower() == "cancelled"),
            key=_order_number_sort_key,
        )
        orders = [o for o in orders if (o.get("order_status") or "").strip().lower() != "cancelled"]
        if not orders:
            raise HTTPException(status_code=400, detail="All matched orders are cancelled")
        products = org_table(supabase, org_id, "shopify_products").select("id, name, collection").execute().data or []
        resolve_collection = shopify.build_collection_resolver(products)
        aggregated, sizes = _aggregate_packaging_items(orders, resolve_collection)
        pdf_buffer = await asyncio.to_thread(_generate_pdf_packaging_list, aggregated, sizes, len(orders))
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={
                "Content-Disposition": "attachment; filename=packaging_list.pdf",
                "X-Matched-Count": str(len(orders)),
                "X-Not-Found": ",".join(str(n) for n in not_found),
                "X-Cancelled": ",".join(str(n) for n in cancelled),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error generating packaging list")
        raise HTTPException(status_code=500, detail="Error generating packaging list")


@router.post("/generate-load-sheet")
@limiter.limit("10/minute")
async def generate_load_sheet(request: Request, order_ids: List[str], org_id: str = Depends(get_org_id)):
    """Generate a PDF load sheet from template for selected orders"""
    try:
        if not order_ids:
            raise HTTPException(status_code=400, detail="No orders selected")
        if len(order_ids) > MAX_PDF_BATCH_ORDERS:
            raise HTTPException(status_code=400, detail=f"Cannot generate a load sheet for more than {MAX_PDF_BATCH_ORDERS} orders at once")

        # Get orders from database
        supabase = get_supabase()
        orders_response = org_table(supabase, org_id, "shopify_orders").select("*").in_("id", order_ids).execute()
        orders = orders_response.data

        if not orders:
            raise HTTPException(status_code=404, detail="No orders found")

        # Check if template exists (optional - for future use)
        template_path = None

        # Generate PDF
        pdf_buffer = await asyncio.to_thread(_generate_pdf_load_sheet, orders, template_path)
        
        # Return PDF file as download
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=load_sheet.pdf"}
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error generating PDF load sheet")
        raise HTTPException(status_code=500, detail="Error generating PDF load sheet")


@router.get("/month-summary/list")
async def get_month_summary_list(org_id: str = Depends(get_org_id)):
    """Get list of all available months with order data"""
    try:
        supabase = get_supabase()
        periods = supabase.rpc("get_month_summary_periods", {"p_org_id": org_id}).execute().data or []
        return [
            {"month": p["month"], "year": p["year"], "warning_orders_count": p.get("warning_orders_count") or 0}
            for p in periods
        ]
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/month-summary/{month}/{year}")
async def get_month_summary_detail(month: int, year: int, org_id: str = Depends(get_org_id)):
    """Get detailed summary for a specific month period"""
    try:
        if month < 1 or month > 12:
            raise HTTPException(status_code=400, detail="Invalid month")
        if year < 2000 or year > 2100:
            raise HTTPException(status_code=400, detail="Invalid year")

        # Get period start and end dates
        start_day = get_org_fiscal_settings(org_id)["fiscal_month_start_day"]
        start_iso, end_iso = _period_start_end(month, year, start_day)
        start_date, end_date = _period_start_end_dates(month, year, start_day)

        supabase = get_supabase()

        totals_resp = supabase.rpc("get_month_summary_totals", {
            "p_period_start": start_iso,
            "p_period_end": end_iso,
            "p_entry_start": start_date,
            "p_entry_end": end_date,
            "p_org_id": org_id,
        }).execute()
        totals = (totals_resp.data or [{}])[0]

        expense_lines_resp = supabase.rpc("get_month_summary_expense_lines", {
            "p_entry_start": start_date,
            "p_entry_end": end_date,
            "p_org_id": org_id,
        }).execute()
        expense_lines = [
            {"name": row["ledger_name"], "amount": round(float(row.get("amount") or 0), 2)}
            for row in (expense_lines_resp.data or [])
        ]
        total_expenses = round(sum(line["amount"] for line in expense_lines), 2)
        gross_profit = round(float(totals.get("gross_profit") or 0), 2)
        net_profit = round(gross_profit - total_expenses, 2)

        carrier_health_resp = supabase.rpc("get_month_summary_carrier_health", {
            "p_period_start": start_iso,
            "p_period_end": end_iso,
            "p_org_id": org_id,
        }).execute()
        carrier_health = [
            {
                "courier": row["courier"],
                "delivered_count": int(row.get("delivered_count") or 0),
                "total_count": int(row.get("total_count") or 0),
            }
            for row in (carrier_health_resp.data or [])
        ]

        # Only order_status/line_items are needed here - the rest of the period's
        # aggregation (sums/counts) now comes from the get_month_summary_totals RPC.
        orders = fetch_all(
            lambda: org_table(supabase, org_id, "shopify_orders")
            .select("order_status, line_items")
            .gte("order_receiving_date", start_iso)
            .lt("order_receiving_date", end_iso)
        )
        non_cancelled = [o for o in orders if (o.get("order_status") or "").strip().lower() != "cancelled"]

        # Products sold by collection (KNOWN_COLLECTIONS + Others for products without a collection)
        KNOWN_COLLECTIONS = shopify.KNOWN_COLLECTIONS
        products_resp = org_table(supabase, org_id, "shopify_products").select("id, name, collection, price").execute()
        products_list = []  # (name_lower, collection_display, price)
        products_map = {}   # name_lower -> (collection_display, price)
        products_by_id = {} # products.id -> (collection_display, price)
        for p in (products_resp.data or []):
            name = (p.get("name") or "").strip()
            if not name:
                continue
            name_lower = name.lower()
            coll_raw = (p.get("collection") or "").strip()
            collection_display = coll_raw if coll_raw in KNOWN_COLLECTIONS else "Others"
            price = float(p.get("price") or 0)
            products_list.append((name_lower, collection_display, price))
            products_map[name_lower] = (collection_display, price)
            if p.get("id"):
                products_by_id[p["id"]] = (collection_display, price)
            if " - " in name:
                base = name.rsplit(" - ", 1)[0].lower().strip()
                if base and base not in products_map:
                    products_map[base] = (collection_display, price)

        def resolve_item_to_collection_and_price(item_name):
            item_lower = (item_name or "").lower().strip()
            if not item_lower:
                return ("Others", 0.0)
            if item_lower in products_map:
                return products_map[item_lower]
            if " - " in item_name:
                base = item_name.rsplit(" - ", 1)[0].lower().strip()
                if base in products_map:
                    return products_map[base]
            for (name_lower, coll, price) in products_list:
                if name_lower in item_lower or item_lower in name_lower:
                    return (coll, price)
            return ("Others", 0.0)

        products_agg = {c: {"count": 0, "sum": 0.0, "items": {}} for c in KNOWN_COLLECTIONS + ["Others"]}
        for order in non_cancelled:
            for row in _order_line_rows(order):
                qty = row["quantity"]
                # Resolve via product_id (exact) when present, else fall back to name matching.
                if row.get("product_id") and row["product_id"] in products_by_id:
                    coll, price = products_by_id[row["product_id"]]
                else:
                    coll, price = resolve_item_to_collection_and_price(row["product"])
                products_agg[coll]["count"] += qty
                products_agg[coll]["sum"] += price * qty
                item = products_agg[coll]["items"].setdefault(row["product"] or "(unnamed)", {"count": 0, "sum": 0.0})
                item["count"] += qty
                item["sum"] += price * qty
        products_sold_by_collection = [
            {
                "collection": c,
                "count": products_agg[c]["count"],
                "sum": round(products_agg[c]["sum"], 2),
                "products": sorted(
                    (
                        {"name": name, "count": item["count"], "sum": round(item["sum"], 2)}
                        for name, item in products_agg[c]["items"].items()
                    ),
                    key=lambda p: -p["count"],
                ),
            }
            for c in KNOWN_COLLECTIONS + ["Others"]
        ]

        return {
            "month": month,
            "year": year,
            "total_orders": int(totals.get("total_orders") or 0),
            "total_gross_sale": round(float(totals.get("total_gross_sale") or 0), 2),
            "total_return_amount": round(float(totals.get("total_return_amount") or 0), 2),
            "return_orders_count": int(totals.get("return_orders_count") or 0),
            "delivered_orders_count": int(totals.get("delivered_orders_count") or 0),
            "enroute_orders_count": int(totals.get("enroute_orders_count") or 0),
            "unfulfilled_orders_count": int(totals.get("unfulfilled_orders_count") or 0),
            "cancelled_orders_count": int(totals.get("cancelled_orders_count") or 0),
            "net_sales": round(float(totals.get("net_sales") or 0), 2),
            "cost_of_goods_sold": round(float(totals.get("cost_of_goods_sold") or 0), 2),
            "tax_total": round(float(totals.get("tax_total") or 0), 2),
            "gross_profit": gross_profit,
            "total_expenses": total_expenses,
            "net_profit": net_profit,
            "dc_charges_delivered": round(float(totals.get("dc_charges_delivered") or 0), 2),
            "dc_charges_returned": round(float(totals.get("dc_charges_returned") or 0), 2),
            "dc_charges_total": round(float(totals.get("dc_charges_total") or 0), 2),
            "products_sold_by_collection": products_sold_by_collection,
            "carrier_health": carrier_health,
            "expense_lines": expense_lines,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


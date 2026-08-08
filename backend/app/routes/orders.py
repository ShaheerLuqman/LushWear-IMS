import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from supabase import create_client

from app import shopify
from app.advance_status import recompute_advance_statuses
from app.auth import get_org_id
from app.config import settings
from app.database import get_supabase
from app.db_utils import fetch_all
from app.models import Order, OrderCreate, OrderUpdate
from app.money import money
from app.order_pdf import extract_order_numbers
from app.ordering import _order_number_sort_key
from app.org_scope import org_table
from app.org_settings import get_org_integration_settings
from app.rate_limit import limiter
from app.services import postex
from app.services.pdf.invoice import _build_invoice_order_context, _generate_pdf_invoice
from app.services.pdf.load_sheet import _generate_pdf_load_sheet
from app.services.pdf.packaging_list import (
    _aggregate_packaging_items,
    _generate_pdf_packaging_list,
    _order_line_rows,
)
from app.services.shopify_orders import _fetch_shopify_order_by_order_number
from app.services.shopify_sync import (
    PRICE_REDUCTION_DISCOUNT_CODES,
    SyncShopifyOrdersResult,
    _cost_from_line_items,
    _get_sync_status_row,
    _line_items_incomplete,
    _line_items_signature,
    _order_total_from_fulfillments,
    _resolve_line_item_cost,
    _sync_shopify_orders,
)
from app.timezones import PKT_TIMEZONE

logger = logging.getLogger("app.orders")
router = APIRouter(prefix="/orders", tags=["orders"])

# Backstop on user-supplied PDF batch endpoints (invoice/packaging-list/load-sheet) -
# ReportLab rendering time scales with order count, and this is the cheapest bound on
# worst-case request latency. The rendering itself runs off the event loop (see
# asyncio.to_thread below) so a large batch no longer blocks other requests, but it can
# still make one request very slow; this caps that.
MAX_PDF_BATCH_ORDERS = 500


def _compute_shopify_tax(order: dict) -> float:
    """Compute tax for a Shopify order using the same precedence as sync logic."""
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


def _period_start_end(month: int, year: int):
    """Return (start_iso, end_iso) for period: month's 22 00:00:00 PKT to next month's 22 00:00:00 PKT (exclusive).
    Returns dates in UTC for database comparison.
    PKT (Pakistan Time) is UTC+5, so 00:00 PKT = 19:00 UTC (previous day).
    Example: December period = Dec 22 00:00 PKT (inclusive) to Jan 22 00:00 PKT (exclusive).
    This ensures all of Jan 21 up to 23:59:59.999999 PKT is included."""
    # Create start date: month's 22 at 00:00:00 PKT
    start_pkt = datetime(year, month, 22, 0, 0, 0, 0, tzinfo=PKT_TIMEZONE)
    
    # Calculate next month and year
    next_month = month % 12 + 1
    next_year = year if month != 12 else year + 1
    
    # Create end date: next month's 22 at 00:00:00 PKT (exclusive boundary)
    # This ensures we include everything up to but not including the next period start
    end_pkt = datetime(next_year, next_month, 22, 0, 0, 0, 0, tzinfo=PKT_TIMEZONE)
    
    # Convert to UTC for database comparison
    start_utc = start_pkt.astimezone(timezone.utc)
    end_utc = end_pkt.astimezone(timezone.utc)
    
    # Return ISO format strings with timezone info (Z suffix for UTC)
    return start_utc.isoformat().replace('+00:00', 'Z'), end_utc.isoformat().replace('+00:00', 'Z')


def _period_start_end_dates(month: int, year: int):
    """Return (start_date, end_date) as YYYY-MM-DD for the period (month 22 to next month 21 inclusive)."""
    start_date = f"{year}-{month:02d}-22"
    if month == 12:
        end_date = f"{year + 1}-01-21"
    else:
        end_date = f"{year}-{month + 1:02d}-21"
    return start_date, end_date


# The orders list is the one place `delivery_status` gets fetched at scale (hundreds-1000+
# rows), and the frontend list view only ever renders `latest_status` from it - the full
# `status_history` array (the bulk of that column's size) is only needed by the per-order
# detail modal, which fetches it fresh on its own. Extracting just latest_status via
# PostgREST's ->> operator cuts payload roughly 10x for this query without changing what
# the frontend receives (see _reshape_delivery_status_latest below).
ORDERS_LIST_SELECT = (
    "id, order_number, courier, tracking_number, folio, order_status, piece_received, "
    "total_amount, advance_amount, delivery_charge, tax_amount, cost_price, "
    "order_receiving_date, line_items, advance_status, replacement_of_order_no, "
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
    month: int = Query(..., ge=1, le=12, description="Period month (1-12). Period is 22nd to next 21st."),
    year: int = Query(..., ge=2000, le=2100, description="Period year."),
    org_id: str = Depends(get_org_id),
):
    """Orders for a single month period (22nd to next 21st)."""
    try:
        t_start = time.perf_counter()
        supabase = get_supabase()

        start_iso, end_iso = _period_start_end(month, year)
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
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

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
    file: UploadFile = File(...),
    assignment_number: Optional[str] = Form(None),
    org_id: str = Depends(get_org_id),
):
    """
    Upload a PostEx CSV file. Matches rows by ORDER_REF_NUMBER to orders and updates
    delivery_charge (from SHIPPING_CHARGES), tax_amount (GST + WH_INCOME_TAX + WH_SALES_TAX),
    courier (set to PostEx), tracking_number (from TRACKING_NUMBER; parses 14-digit numbers
    including exponential notation e.g. 2.63E+13), and optionally folio (from assignment_number).
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
        all_orders = fetch_all(
            lambda: org_table(supabase, org_id, "shopify_orders")
            .select("id, order_number, total_amount, advance_amount, order_status, order_receiving_date")
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
        amount_mismatches = []  # { order_number, receivable, csv_net_amount, total_amount, advance_amount, delivery_charge, tax_amount }
        orders_to_upsert = []
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
                "updated_at": current_time,
            }
            if r.get("tracking_number"):
                update_data["tracking_number"] = r["tracking_number"]
            if assignment_number is not None and assignment_number.strip():
                update_data["folio"] = assignment_number.strip()
            orders_to_upsert.append(update_data)
            updated_order_ids.append(order["id"])
            updated_count += 1

            # Receivable must match grid formula: returned -> -delivery_charge; else -> total - advance - delivery - tax
            total_amount = float(order.get("total_amount") or 0)
            advance_amount = float(order.get("advance_amount") or 0)
            delivery_charge = float(r["delivery_charge"])
            tax_amount = float(r["tax_amount"])
            order_status = (order.get("order_status") or "").strip().lower()
            if order_status == "returned":
                receivable = money(-delivery_charge)
            else:
                receivable = money(total_amount - advance_amount - delivery_charge - tax_amount)
            csv_net = r.get("csv_net_amount")
            if csv_net is not None:
                csv_net_rounded = money(csv_net)
                if receivable != csv_net_rounded:
                    amount_mismatches.append({
                        "order_number": order_num,
                        "receivable": receivable,
                        "csv_net_amount": csv_net_rounded,
                        "total_amount": total_amount,
                        "advance_amount": advance_amount,
                        "delivery_charge": delivery_charge,
                        "tax_amount": tax_amount,
                        "order_status": order_status or None,
                    })

        if orders_to_upsert:
            batch_size = 1000
            for i in range(0, len(orders_to_upsert), batch_size):
                org_table(supabase, org_id, "shopify_orders").upsert(orders_to_upsert[i:i + batch_size], on_conflict="id").execute()

        # Build response message with debugging info
        message = f"Updated delivery charges, tax, courier (PostEx), and tracking for {updated_count} order(s)."
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
            "amount_mismatches": amount_mismatches,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error processing CSV")
        raise HTTPException(status_code=500, detail="Error processing CSV")


class FixVoidedTotalsResult(BaseModel):
    updated_count: int
    checked_count: int
    voided_in_shopify_count: int
    shopify_fetch_failed_count: int
    skipped_not_voided_count: int
    eligible_candidates_count: int
    fetch_batch_size: int
    only_returned_status: bool
    updated_order_numbers: List[str]


@router.post("/fix-voided-totals", response_model=FixVoidedTotalsResult)
async def fix_voided_order_totals(
    only_returned_status: bool = Query(
        False,
        description="If true, only update rows whose DB order_status is 'returned' (legacy behavior). "
        "If false (default), update any order in the date range whose Shopify financial_status is voided.",
    ),
    org_id: str = Depends(get_org_id),
):
    """
    One-time maintenance endpoint.
    Recalculate total_amount for Shopify-voided orders on/after 22 Jan 2025 using:
    - Prefer fulfilled line items + shipping_lines (avoids double-counting replaced items); else Shopify total_price.

    By default processes every local order in range whose Shopify order is voided (not only DB status returned).
    """
    try:
        supabase = get_supabase()
        org_creds = get_org_integration_settings(org_id)
        logger.info(f"[fix-voided-totals] started | only_returned_status={only_returned_status}")

        # Start from 22 Jan 2025 (inclusive). Uses order_receiving_date if present, else created_at.
        start_iso = "2026-01-22T00:00:00"
        fetch_batch_size = 50

        candidate_select = "id, order_number, total_amount, advance_amount, order_status, order_receiving_date, created_at"

        orders: List[Dict[str, Any]] = fetch_all(
            lambda: org_table(supabase, org_id, "shopify_orders")
            .select(candidate_select)
            .gte("order_receiving_date", start_iso)
            .order("order_number")
        )
        logger.info("[fix-voided-totals] fetched by order_receiving_date count=%d", len(orders))

        if not orders:
            logger.info("[fix-voided-totals] no candidate orders found in date range")
            return {
                "updated_count": 0,
                "checked_count": 0,
                "voided_in_shopify_count": 0,
                "shopify_fetch_failed_count": 0,
                "skipped_not_voided_count": 0,
                "eligible_candidates_count": 0,
                "fetch_batch_size": fetch_batch_size,
                "only_returned_status": only_returned_status,
                "updated_order_numbers": [],
            }

        logger.info(f"[fix-voided-totals] total candidates={len(orders)}")
        updated_count = 0
        checked_count = 0
        voided_in_shopify_count = 0
        shopify_fetch_failed_count = 0
        skipped_not_voided_count = 0
        eligible_candidates_count = 0
        updated_order_numbers: List[str] = []

        # Pre-filter local rows once, then fetch Shopify orders concurrently in batches.
        candidate_rows: List[Tuple[str, Dict[str, Any]]] = []
        for db_order in orders:
            order_number = str(db_order.get("order_number") or "").strip()
            if not order_number:
                logger.info(f"[fix-voided-totals] skip row id={db_order.get('id')} reason=missing_order_number")
                continue

            if (db_order.get("order_status") or "").strip().lower() == "cancelled":
                logger.info(f"[fix-voided-totals] skip order={order_number} reason=cancelled")
                continue

            if only_returned_status:
                status = (db_order.get("order_status") or "").strip().lower()
                if status != "returned":
                    logger.info(f"[fix-voided-totals] skip order={order_number} reason=status_not_returned status={status}")
                    continue

            candidate_rows.append((order_number, db_order))

        eligible_candidates_count = len(candidate_rows)
        logger.info(
            f"[fix-voided-totals] eligible local candidates={eligible_candidates_count} "
            f"batch_size={fetch_batch_size}"
        )

        for i in range(0, len(candidate_rows), fetch_batch_size):
            chunk = candidate_rows[i:i + fetch_batch_size]
            checked_count += len(chunk)
            chunk_start = i + 1
            chunk_end = i + len(chunk)
            logger.info(f"[fix-voided-totals] processing chunk {chunk_start}-{chunk_end}")

            fetch_tasks = [
                _fetch_shopify_order_by_order_number(order_number, org_creds)
                for order_number, _ in chunk
            ]
            fetch_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

            for (order_number, db_order), sp_order_result in zip(chunk, fetch_results):
                if isinstance(sp_order_result, Exception):
                    shopify_fetch_failed_count += 1
                    logger.info(
                        f"[fix-voided-totals] skip order={order_number} "
                        f"reason=shopify_fetch_exception err={sp_order_result}"
                    )
                    continue

                sp_order = sp_order_result
                if not sp_order:
                    shopify_fetch_failed_count += 1
                    logger.info(f"[fix-voided-totals] skip order={order_number} reason=shopify_fetch_failed")
                    continue

                financial_status_peek = (sp_order.get("financial_status") or "").strip().lower()
                if financial_status_peek != "voided":
                    skipped_not_voided_count += 1
                    logger.info(
                        f"[fix-voided-totals] skip order={order_number} "
                        f"reason=not_voided financial_status={financial_status_peek}"
                    )
                    continue

                voided_in_shopify_count += 1

                # Recalculate total_amount using voided rule (fulfillments + shipping, else total_price).
                shopify_tax = _compute_shopify_tax(sp_order) or 0.0
                voided_from_fulfillments = _order_total_from_fulfillments(sp_order)
                if voided_from_fulfillments is not None:
                    new_total = voided_from_fulfillments + shopify_tax
                    logger.info(
                        f"[fix-voided-totals] order={order_number} calc=fulfillments_plus_shipping "
                        f"base={voided_from_fulfillments:.2f} tax={shopify_tax:.2f} new_total={new_total:.2f}"
                    )
                else:
                    total_line_items_price = 0.0
                    try:
                        total_line_items_price = float(sp_order.get("total_line_items_price") or 0)
                    except (TypeError, ValueError):
                        total_line_items_price = 0.0
                    total_price_val = sp_order.get("total_price")
                    if total_price_val is not None and str(total_price_val).strip() != "":
                        new_total = float(total_price_val)
                        logger.info(
                            f"[fix-voided-totals] order={order_number} calc=fallback_total_price "
                            f"new_total={new_total:.2f}"
                        )
                    else:
                        new_total = total_line_items_price + shopify_tax
                        logger.info(
                            f"[fix-voided-totals] order={order_number} calc=fallback_line_items_plus_tax "
                            f"line_items={total_line_items_price:.2f} tax={shopify_tax:.2f} new_total={new_total:.2f}"
                        )

                # Preserve advance_amount from DB; only fix total_amount
                new_total = money(new_total)
                existing_total = money(db_order.get("total_amount"))
                if existing_total == new_total:
                    logger.info(
                        f"[fix-voided-totals] skip order={order_number} reason=no_change "
                        f"existing_total={existing_total:.2f} new_total={new_total:.2f}"
                    )
                    continue

                org_table(supabase, org_id, "shopify_orders").update(
                    {
                        "total_amount": new_total,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
                ).eq("id", db_order["id"]).execute()
                updated_count += 1
                updated_order_numbers.append(str(order_number))
                logger.info(
                    f"[fix-voided-totals] updated order={order_number} "
                    f"existing_total={existing_total:.2f} new_total={new_total:.2f}"
                )

        logger.info(
            f"[fix-voided-totals] completed | checked={checked_count} updated={updated_count} "
            f"voided_in_shopify={voided_in_shopify_count} fetch_failed={shopify_fetch_failed_count} "
            f"not_voided={skipped_not_voided_count} eligible_candidates={eligible_candidates_count}"
        )
        return {
            "updated_count": updated_count,
            "checked_count": checked_count,
            "voided_in_shopify_count": voided_in_shopify_count,
            "shopify_fetch_failed_count": shopify_fetch_failed_count,
            "skipped_not_voided_count": skipped_not_voided_count,
            "eligible_candidates_count": eligible_candidates_count,
            "fetch_batch_size": fetch_batch_size,
            "only_returned_status": only_returned_status,
            "updated_order_numbers": updated_order_numbers,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


class RecalculateTotalsBody(BaseModel):
    order_numbers: List[int]


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
        org_creds = get_org_integration_settings(org_id)
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
        for v in (org_table(supabase, org_id, "shopify_variants").select("id, shopify_variant_id").execute().data or []):
            if v.get("shopify_variant_id") is not None and v.get("id"):
                variant_id_by_shopify[int(v["shopify_variant_id"])] = v["id"]

        # existing orders map by order_number
        existing_orders_map: Dict[int, Dict[str, Any]] = {}
        existing_rows = (
            org_table(supabase, org_id, "shopify_orders")
            .select(
                "id, order_number, order_status, piece_received, delivery_status, "
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
                name = (item.get("title") or item.get("name") or "").strip()
                rows.append({
                    "variant_id": variant_id_by_shopify.get(int(sp_variant_id)) if sp_variant_id is not None else None,
                    "product_id": resolved_product_id,
                    "name": name,
                    "variant_title": (item.get("variant_title") or "").strip() or "-",
                    "qty": qty,
                    "unit_price": unit_price,
                    "cost_price": _resolve_line_item_cost(name, resolved_product_id, costs_by_id, products_cost_map),
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
            if has_price_reduction_discount_code:
                total_amount = max(0.0, total_amount - total_discounts)
                advance_amount = total_amount if financial_status == "paid" else 0.0
            else:
                advance_amount = total_amount if financial_status == "paid" else total_discounts

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

            delivery_charge = 180.0 if str(courier or "").strip().upper() == "SCS" else 0.0
            tax_amount = 0.0

            payload: Dict[str, Any] = {
                "order_number": target_order_number,
                "courier": courier,
                "tracking_number": tracking_number,
                "order_status": order_status,
                "piece_received": (existing_order.get("piece_received") if existing_order else "Pending") or "Pending",
                "delivery_status": existing_order.get("delivery_status") if existing_order else None,
                "total_amount": total_amount,
                "advance_amount": advance_amount,
                "delivery_charge": float(existing_order.get("delivery_charge") or 0) if existing_order else delivery_charge,
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


class RecalculateTotalsResult(BaseModel):
    updated_count: int
    checked_count: int
    shopify_fetch_failed_count: int
    updated_order_numbers: List[int]
    not_found_in_db: List[int]


@router.post("/recalculate-totals", response_model=RecalculateTotalsResult)
async def recalculate_order_totals(body: RecalculateTotalsBody, org_id: str = Depends(get_org_id)):
    """
    Recalculate total_amount for specified orders from Shopify.
    Uses fulfilled line items + shipping_lines (preferred) or fallback to Shopify total_price.
    Does NOT check for voided status - recalculates for any order.
    """
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    
    try:
        supabase = get_supabase()
        org_creds = get_org_integration_settings(org_id)
        order_numbers_input = list(dict.fromkeys(body.order_numbers))

        logger.info(f"[recalculate-totals] started | order_numbers={order_numbers_input}")

        # Fetch the orders from DB
        db_orders_map: Dict[int, Dict[str, Any]] = {}
        for order_num in order_numbers_input:
            resp = (
                org_table(supabase, org_id, "shopify_orders")
                .select("id, order_number, total_amount, advance_amount, order_status")
                .eq("order_number", order_num)
                .limit(1)
                .execute()
            )
            if resp.data:
                db_orders_map[order_num] = resp.data[0]
        
        not_found_in_db = [n for n in order_numbers_input if n not in db_orders_map]
        if not_found_in_db:
            logger.info(f"[recalculate-totals] orders not found in DB: {not_found_in_db}")
        
        updated_count = 0
        checked_count = 0
        shopify_fetch_failed_count = 0
        updated_order_numbers: List[int] = []
        fetch_batch_size = 50
        
        # Process orders in batches
        candidate_rows = list(db_orders_map.items())
        
        for i in range(0, len(candidate_rows), fetch_batch_size):
            chunk = candidate_rows[i:i + fetch_batch_size]
            checked_count += len(chunk)
            
            fetch_tasks = [
                _fetch_shopify_order_by_order_number(order_number, org_creds)
                for order_number, _ in chunk
            ]
            fetch_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)
            
            for (order_number, db_order), sp_order_result in zip(chunk, fetch_results):
                if isinstance(sp_order_result, Exception):
                    shopify_fetch_failed_count += 1
                    logger.info(f"[recalculate-totals] skip order={order_number} reason=shopify_fetch_exception err={sp_order_result}")
                    continue
                
                sp_order = sp_order_result
                if not sp_order:
                    shopify_fetch_failed_count += 1
                    logger.info(f"[recalculate-totals] skip order={order_number} reason=shopify_fetch_failed")
                    continue
                
                # Calculate new total using the same logic as fix-voided-totals
                shopify_tax = _compute_shopify_tax(sp_order) or 0.0
                voided_from_fulfillments = _order_total_from_fulfillments(sp_order)
                
                if voided_from_fulfillments is not None:
                    new_total = voided_from_fulfillments + shopify_tax
                    logger.info(f"[recalculate-totals] order={order_number} calc=fulfillments_plus_shipping base={voided_from_fulfillments:.2f} tax={shopify_tax:.2f} new_total={new_total:.2f}")
                else:
                    total_line_items_price = 0.0
                    try:
                        total_line_items_price = float(sp_order.get("total_line_items_price") or 0)
                    except (ValueError, TypeError):
                        total_line_items_price = 0.0
                    total_price_val = sp_order.get("total_price")
                    if total_price_val is not None and str(total_price_val).strip() != "":
                        new_total = float(total_price_val)
                        logger.info(f"[recalculate-totals] order={order_number} calc=fallback_total_price new_total={new_total:.2f}")
                    else:
                        new_total = total_line_items_price + shopify_tax
                        logger.info(f"[recalculate-totals] order={order_number} calc=fallback_line_items_plus_tax line_items={total_line_items_price:.2f} tax={shopify_tax:.2f} new_total={new_total:.2f}")

                # Keep recalculation behavior aligned with sync logic: only configured
                # discount codes reduce selling price instead of being treated as advance.
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
                if has_price_reduction_discount_code:
                    discounted_total = max(0.0, new_total - total_discounts)
                    logger.info(
                        f"[recalculate-totals] order={order_number} apply_price_reduction_discount "
                        f"pre_discount_total={new_total:.2f} discounts={total_discounts:.2f} new_total={discounted_total:.2f}"
                    )
                    new_total = discounted_total
                
                # Update the order
                new_total = money(new_total)
                existing_total = money(db_order.get("total_amount"))
                if existing_total == new_total:
                    logger.info(f"[recalculate-totals] skip order={order_number} reason=no_change existing_total={existing_total:.2f} new_total={new_total:.2f}")
                    continue
                
                org_table(supabase, org_id, "shopify_orders").update(
                    {
                        "total_amount": new_total,
                        "updated_at": datetime.now(timezone.utc).isoformat(),
                    }
                ).eq("id", db_order["id"]).execute()
                updated_count += 1
                updated_order_numbers.append(order_number)
                logger.info(f"[recalculate-totals] updated order={order_number} existing_total={existing_total:.2f} new_total={new_total:.2f}")
        
        logger.info(f"[recalculate-totals] completed | checked={checked_count} updated={updated_count} fetch_failed={shopify_fetch_failed_count}")
        
        return {
            "updated_count": updated_count,
            "checked_count": checked_count,
            "shopify_fetch_failed_count": shopify_fetch_failed_count,
            "updated_order_numbers": updated_order_numbers,
            "not_found_in_db": not_found_in_db,
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


def _classify_status(status_text: str) -> Optional[str]:
    """Classify a status text into one of the relevant order statuses."""
    if not status_text:
        return None
    status_lower = status_text.lower()
    # Check for return-related statuses (Return to KARACHI, Returned at Merchant Warehouse, etc.)
    if (
        "return" in status_lower
        or "refused by consignee" in status_lower
        or "shipper advice" in status_lower
    ):
        return "returned"
    # Handle both PostEx ("Delivered to Customer") and Courier Next ("Delivered ...") variants.
    if "delivered to customer" in status_lower or ("delivered" in status_lower and "undelivered" not in status_lower):
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

    history = delivery_status_data.get("status_history") or []
    
    # Sort by datetime ascending (oldest first, newest last)
    sorted_history = sorted(
        history,
        key=lambda x: x.get("datetime", "") or ""
    )
    
    # Find the last relevant status by iterating from newest to oldest
    for entry in reversed(sorted_history):
        status_text = (entry.get("status") or "").strip()
        classified = _classify_status(status_text)
        if classified:
            return classified
    
    # Fallback: check latest_status field if no relevant status found in history
    latest = (delivery_status_data.get("latest_status") or "").strip()
    if latest:
        classified = _classify_status(latest)
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
        updated = response.data[0]
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


def _parse_couriersnext_response(data: list, tracking_number: str) -> dict:
    status_history_raw = [item for item in data if isinstance(item, dict)]
    status_history_parsed = [
        {
            "status": item.get("status", "") or "",
            "status_code": item.get("title", "") or "",
            "datetime": item.get("created", "") or "",
        }
        for item in status_history_raw
    ]
    # Sort by provider timestamp ascending (oldest first, newest last).
    status_history_sorted = sorted(status_history_parsed, key=lambda x: x.get("datetime", "") or "")
    latest_status = status_history_sorted[-1].get("status", "") if status_history_sorted else ""
    first_row = status_history_raw[0] if status_history_raw else {}
    resolved_tracking = (first_row.get("tracking_no") if isinstance(first_row, dict) else None) or tracking_number
    return {
        "courier": "Couriers Next",
        "tracking_number": resolved_tracking,
        "customer_name": "",
        "order_pickup_date": "",
        "status_history": status_history_sorted,
        "latest_status": latest_status,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


async def _fetch_couriersnext_status(client: httpx.AsyncClient, tracking_number: str) -> dict:
    api_url = "https://portal.couriersnext.com/API/TrackOrder.php"
    response = await client.post(
        api_url,
        json={"tracking_no": tracking_number},
        headers={"Content-Type": "application/json"},
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise HTTPException(status_code=500, detail="Invalid response from Couriers Next tracking API")
    return _parse_couriersnext_response(data, tracking_number)


# Undocumented cap on track-bulk-order; tested up to 120 tracking numbers in one call with
# no error, but chunking keeps each request well under whatever the real limit turns out to be.
POSTEX_BULK_BATCH_SIZE = 100

# Cap on concurrent requests for Couriers Next fetches and DB save writes below - keeps us
# from opening hundreds of simultaneous connections to either service at once.
_BULK_CONCURRENCY = 20

# Cap on ids per `.in_()` query - keeps the request URL well under server/proxy length
# limits. Order ids are UUIDs (36 chars each), so this is kept lower than the 200-value
# chunk size used elsewhere for short order numbers.
IN_QUERY_ID_CHUNK_SIZE = 100


async def _fetch_couriersnext_bulk(tracking_numbers: List[Tuple[str, str]]) -> Dict[str, dict]:
    """Fetch delivery status for many Couriers Next tracking numbers concurrently (no bulk
    API exists for this courier, so this is just many single calls run in parallel)."""
    results: Dict[str, dict] = {}
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def run(client: httpx.AsyncClient, tracking_number: str):
        async with sem:
            try:
                results[tracking_number] = await _fetch_couriersnext_status(client, tracking_number)
            except Exception as e:
                results[tracking_number] = {"error": str(e)}

    async with httpx.AsyncClient(timeout=30.0) as client:
        await asyncio.gather(*(run(client, tn) for _, tn in tracking_numbers))
    return results


def _update_order_sync(org_id: str, order_id: str, update_payload: dict) -> None:
    """Runs on its own Supabase client (not the shared singleton) - sharing one client's
    HTTP/2 connection across concurrent threads crashes with a stream-read error."""
    client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
    org_table(client, org_id, "shopify_orders").update(update_payload).eq("id", order_id).execute()


async def _save_delivery_status_updates(org_id: str, results: Dict[str, dict], orders_by_id: Dict[str, dict]) -> None:
    """Persist delivery_status (and derived order_status/piece_received) for many orders
    concurrently. Partial per-row updates only - never a full-row write - so a stale
    in-memory snapshot here can't clobber an unrelated field someone else edited meanwhile."""
    now = datetime.now(timezone.utc).isoformat()
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)

    async def run(order_id: str, delivery_status_data: dict):
        order = orders_by_id[order_id]
        update_payload = {"delivery_status": delivery_status_data, "updated_at": now}
        derived_status = _derive_order_status_from_latest(delivery_status_data)
        if derived_status:
            update_payload["order_status"] = derived_status
            if derived_status == "delivered":
                current_piece = (order.get("piece_received") or "").strip().lower()
                if current_piece == "pending":
                    update_payload["piece_received"] = "Done"
        async with sem:
            try:
                await asyncio.to_thread(_update_order_sync, org_id, order_id, update_payload)
            except Exception:
                logger.exception(f"[delivery-status-bulk] Failed to save order_id={order_id}")

    to_save = [oid for oid, data in results.items() if "error" not in data]
    await asyncio.gather(*(run(oid, results[oid]) for oid in to_save))


async def _fetch_postex_bulk(tracking_numbers: List[str], postex_token: str) -> Dict[str, dict]:
    """Fetch delivery status for many PostEx tracking numbers in as few requests as possible.
    Returns a dict keyed by tracking number; numbers PostEx has no record of are simply absent."""
    if not tracking_numbers:
        return {}
    if not postex_token:
        raise HTTPException(status_code=400, detail="PostEx credentials are not configured for this organization. Set them in Settings > Integrations.")

    url = "https://api.postex.pk/services/integration/api/order/v1/track-bulk-order"
    results: Dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=60.0) as client:
        for i in range(0, len(tracking_numbers), POSTEX_BULK_BATCH_SIZE):
            batch = tracking_numbers[i:i + POSTEX_BULK_BATCH_SIZE]
            # Doc says GET; body-less GET is what actually works, tracking numbers as repeated
            # query params (not the POST+JSON-body shape the doc's example implies).
            response = await client.get(
                url,
                headers={"token": postex_token},
                params=[("TrackingNumbers", tn) for tn in batch],
            )
            response.raise_for_status()
            data = response.json()
            if data.get("statusCode") != "200":
                continue
            for item in data.get("dist") or []:
                tr = item.get("trackingResponse") or {}
                tn = tr.get("trackingNumber")
                if tn:
                    results[tn] = _parse_postex_dist(tr, tn)
    return results


@router.get("/{order_id}/delivery-status")
async def get_delivery_status(order_id: str, save: bool = Query(False, description="If true, store fetched status in order.delivery_status"), org_id: str = Depends(get_org_id)):
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

        if _delivery_status_is_fresh(existing_delivery):
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

        # Persist fetched data and update order_status when save=true
        if save:
            update_payload = {
                "delivery_status": delivery_status_data,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
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
            logger.info(f"[delivery-status] Update payload: {update_payload.keys()}")

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
    """Fetch delivery status for many orders at once. PostEx orders are fetched in as few
    requests as possible via track-bulk-order; Couriers Next has no bulk API so those are
    fetched one at a time, same as the single-order endpoint."""
    if not order_ids:
        raise HTTPException(status_code=400, detail="No orders selected")
    try:
        supabase = get_supabase()
        org_creds = get_org_integration_settings(org_id)
        orders_by_id = {}
        for i in range(0, len(order_ids), IN_QUERY_ID_CHUNK_SIZE):
            chunk = order_ids[i:i + IN_QUERY_ID_CHUNK_SIZE]
            chunk_response = org_table(supabase, org_id, "shopify_orders").select("*").in_("id", chunk).execute()
            orders_by_id.update({o["id"]: o for o in chunk_response.data or []})

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
            postex_by_tracking = await _fetch_postex_bulk([tn for _, tn in postex_orders], org_creds.postex_merchant_token)
            for order_id, tracking_number in postex_orders:
                data = postex_by_tracking.get(tracking_number)
                results[order_id] = data if data else {"error": "No PostEx record found for this tracking number"}

        if couriersnext_orders:
            couriersnext_by_tracking = await _fetch_couriersnext_bulk(couriersnext_orders)
            for order_id, tracking_number in couriersnext_orders:
                results[order_id] = couriersnext_by_tracking[tracking_number]

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

@router.delete("/{order_id}")
async def delete_order(order_id: str, org_id: str = Depends(get_org_id)):
    """Delete an order"""
    try:
        supabase = get_supabase()
        response = org_table(supabase, org_id, "shopify_orders").delete().eq("id", order_id).execute()
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
        org_creds = get_org_integration_settings(org_id)
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
        aggregated, sizes = _aggregate_packaging_items(orders)
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
        aggregated, sizes = _aggregate_packaging_items(orders)
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
        return [{"month": p["month"], "year": p["year"]} for p in periods]
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
        start_iso, end_iso = _period_start_end(month, year)
        start_date, end_date = _period_start_end_dates(month, year)

        supabase = get_supabase()

        totals_resp = supabase.rpc("get_month_summary_totals", {
            "p_period_start": start_iso,
            "p_period_end": end_iso,
            "p_entry_start": start_date,
            "p_entry_end": end_date,
            "p_org_id": org_id,
        }).execute()
        totals = (totals_resp.data or [{}])[0]

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

        # Products sold by collection (5 collections + Others for products without a collection)
        KNOWN_COLLECTIONS = ["Cami Sets", "Linen PJs", "Pajama T-Shirt", "Silk Collection", "Trousers"]
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

        products_agg = {c: {"count": 0, "sum": 0.0} for c in KNOWN_COLLECTIONS + ["Others"]}
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
        products_sold_by_collection = [
            {"collection": c, "count": products_agg[c]["count"], "sum": round(products_agg[c]["sum"], 2)}
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
            "net_sales": round(float(totals.get("net_sales") or 0), 2),
            "net_profit": round(float(totals.get("net_profit") or 0), 2),
            "dc_charges_delivered": round(float(totals.get("dc_charges_delivered") or 0), 2),
            "dc_charges_returned": round(float(totals.get("dc_charges_returned") or 0), 2),
            "dc_charges_total": round(float(totals.get("dc_charges_total") or 0), 2),
            "products_sold_by_collection": products_sold_by_collection,
            "carrier_health": carrier_health,
            "shopify_expense": round(float(totals.get("shopify_expense") or 0), 2),
            "ad_expense": round(float(totals.get("ad_expense") or 0), 2),
            "other_expense": round(float(totals.get("other_expense") or 0), 2),
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("orders endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


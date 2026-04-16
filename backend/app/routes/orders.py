from fastapi import APIRouter, HTTPException, UploadFile, File, Query, Form, Body
from fastapi.responses import Response
from typing import List, Dict, Any, Optional, Tuple
from pydantic import BaseModel
from app.models import Order, OrderCreate, OrderUpdate
from app.database import get_supabase
from app.config import settings
from datetime import datetime, timedelta, timezone
import asyncio
import httpx
import re
import csv
import io
from io import BytesIO
import os
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs
import json
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak, Image, Flowable
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_RIGHT, TA_LEFT
from reportlab.lib.utils import ImageReader

router = APIRouter(prefix="/orders", tags=["orders"])

# Pakistan Time (PKT) is UTC+5
PKT_TIMEZONE = timezone(timedelta(hours=5))

# Discounts applied with these codes reduce the order total and are not treated as advance.
PRICE_REDUCTION_DISCOUNT_CODES = {
    "INFLUOFF",
    "REPLACEMENT100OFF",
    "GET10OFF",
    "GET5OFF",
}


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


def _order_total_from_fulfillments(sp_order: dict) -> Optional[float]:
    """
    Compute order total from fulfillments: fulfilled merchandise (price * quantity per
    fulfillment line) + shipping_lines (excluding is_removed).

    Returns None when there are no fulfillments or no positive merchandise from fulfillment lines
    (caller should use the standard Shopify total fallbacks).
    """
    fulfillments = sp_order.get("fulfillments") or []
    if not fulfillments:
        return None

    merchandise = 0.0
    for f in fulfillments:
        for li in f.get("line_items") or []:
            qty = li.get("quantity")
            if qty is None:
                qty = 1
            try:
                qty = int(qty)
            except (TypeError, ValueError):
                qty = 0
            try:
                price = float(li.get("price") or 0)
            except (TypeError, ValueError):
                price = 0.0
            merchandise += price * qty

    if merchandise <= 0:
        return None

    shipping_lines = sp_order.get("shipping_lines") or []
    shipping_total = 0.0
    for sl in shipping_lines:
        if sl.get("is_removed"):
            continue
        disc = sl.get("discounted_price")
        if disc is not None and str(disc).strip() != "":
            try:
                shipping_total += float(disc)
                continue
            except (TypeError, ValueError):
                pass
        dps = sl.get("discounted_price_set") or sl.get("price_set")
        if isinstance(dps, dict):
            sm = dps.get("shop_money") or {}
            amt = sm.get("amount")
            if amt is not None and str(amt).strip() != "":
                try:
                    shipping_total += float(amt)
                except (TypeError, ValueError):
                    pass

    # Only fall back to order-level shipping when shipping_lines are missing.
    # If shipping_lines are present but all are removed, shipping is intentionally waived.
    if shipping_total <= 0 and not shipping_lines and sp_order.get("total_shipping_price_set"):
        shop_money = (sp_order["total_shipping_price_set"] or {}).get("shop_money") or {}
        amt = shop_money.get("amount")
        if amt is not None and str(amt).strip() != "":
            try:
                shipping_total = float(amt)
            except (TypeError, ValueError):
                pass

    return merchandise + shipping_total


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


@router.get("/", response_model=List[dict])
async def get_all_orders(
    month: int = Query(None, ge=1, le=12, description="Filter by period month (1-12). Period is 22nd to next 21st."),
    year: int = Query(None, ge=2000, le=2100, description="Filter by period year.")
):
    """Get all orders, optionally filtered by month period (month's 22 to next month's 21)."""
    try:
        supabase = get_supabase()
        page_size = 1000
        
        if month is not None and year is not None:
            start_iso, end_iso = _period_start_end(month, year)
            
            # Fetch all orders with order_receiving_date in range (paginated)
            r1_data = []
            offset = 0
            while True:
                response = (
                    supabase.table("orders")
                    .select("*")
                    .gte("order_receiving_date", start_iso)
                    .lt("order_receiving_date", end_iso)
                    .order("order_number", desc=True)
                    .range(offset, offset + page_size - 1)
                    .execute()
                )
                r1_data.extend(response.data)
                if len(response.data) < page_size:
                    break
                offset += page_size
            
            # Fetch all orders with null order_receiving_date but created_at in range (paginated)
            r2_data = []
            offset = 0
            while True:
                response = (
                    supabase.table("orders")
                    .select("*")
                    .is_("order_receiving_date", "null")
                    .gte("created_at", start_iso)
                    .lt("created_at", end_iso)
                    .order("order_number", desc=True)
                    .range(offset, offset + page_size - 1)
                    .execute()
                )
                r2_data.extend(response.data)
                if len(response.data) < page_size:
                    break
                offset += page_size
            
            # Merge results, avoiding duplicates
            seen_ids = {o["id"] for o in r1_data}
            merged = list(r1_data)
            for o in r2_data:
                if o["id"] not in seen_ids:
                    merged.append(o)
                    seen_ids.add(o["id"])
            merged.sort(key=lambda x: (x.get("order_number") or ""), reverse=True)
            return merged
        
        # Fetch all orders without filter (paginated)
        all_orders = []
        offset = 0
        while True:
            response = (
                supabase.table("orders")
                .select("*")
                .order("order_number", desc=True)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            all_orders.extend(response.data)
            if len(response.data) < page_size:
                break
            offset += page_size
        return all_orders
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sync-shopify")
async def sync_shopify_orders():
    try:
        store_url = settings.shopify_store_url
        access_token = settings.shopify_access_token
        
        if not store_url or not access_token:
            raise HTTPException(
                status_code=400, 
                detail="Shopify credentials not configured. Please set SHOPIFY_STORE_URL (or SHOPIFY_API_KEY) and SHOPIFY_ADMIN_API_TOKEN environment variables."
            )
            
        store_url = store_url.strip().rstrip('/')
        if store_url.startswith('http://'):
            store_url = store_url[7:]
        elif store_url.startswith('https://'):
            store_url = store_url[8:]
        
        base_url = f"https://{store_url}/admin/api/{settings.SHOPIFY_API_VERSION}/orders.json"
        headers = {
            "X-Shopify-Access-Token": access_token,
            "Content-Type": "application/json"
        }
        
        all_orders = []
        page_info = None
        page_count = 0
        # Only sync orders from the last 30 days
        created_since = (datetime.utcnow() - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%S")

        async with httpx.AsyncClient(timeout=60.0) as client:
            while True:
                if page_info:
                    api_url = f"{base_url}?page_info={page_info}"
                else:
                    api_url = f"{base_url}?status=any&limit=250&created_at_min={created_since}"
                
                response = await client.get(api_url, headers=headers)
                if response.status_code == 404:
                    error_detail = f"Shopify API endpoint not found. Please verify:\n"
                    error_detail += f"1. Store URL is correct: {store_url}\n"
                    error_detail += f"2. API version is valid: {settings.SHOPIFY_API_VERSION}\n"
                    error_detail += f"3. Access token has correct permissions\n"
                    error_detail += f"4. Full URL attempted: {api_url}\n"
                    error_detail += f"Response: {response.text}"
                    raise HTTPException(status_code=404, detail=error_detail)
                response.raise_for_status()
                shopify_data = response.json()
                
                if "orders" not in shopify_data:
                    raise HTTPException(status_code=500, detail="Invalid response from Shopify API")
                
                page_orders = shopify_data["orders"]
                if not page_orders:
                    break
                
                all_orders.extend(page_orders)
                page_count += 1
                
                link_header = response.headers.get("Link", "")
                next_page_info = None
                
                if link_header:
                    next_link_match = re.search(r'<([^>]+)>;\s*rel=["\']next["\']', link_header, re.IGNORECASE)
                    if next_link_match:
                        url = next_link_match.group(1)
                        parsed_url = urlparse(url)
                        if parsed_url.query:
                            query_params = parse_qs(parsed_url.query, keep_blank_values=True)
                            if 'page_info' in query_params:
                                next_page_info = query_params['page_info'][0]
                            else:
                                page_info_match = re.search(r'[?&]page_info=([^&]+)', url)
                                if page_info_match:
                                    next_page_info = unquote(page_info_match.group(1))
                        else:
                            page_info_match = re.search(r'page_info=([^&>]+)', url)
                            if page_info_match:
                                next_page_info = unquote(page_info_match.group(1))
                    
                    if next_page_info:
                        page_info = next_page_info
                        continue
                    else:
                        break
                else:
                    break
                
                if len(page_orders) < 250:
                    break
        
        supabase = get_supabase()
        
        # Fetch all products with their cost prices for cost calculation
        products_response = supabase.table("products").select("name, cost_price").execute()
        products_cost_map = {}
        for p in products_response.data:
            if p.get("name") and p.get("cost_price") is not None:
                # Store by lowercase name for case-insensitive matching
                products_cost_map[p["name"].lower().strip()] = float(p["cost_price"])
        
        existing_orders_map = {}
        existing_orders_all = []
        offset = 0
        limit = 1000
        existing_orders_select = (
            "id, order_number, order_status, delivery_charge, tax_amount, "
            "delivery_status, piece_received, courier, tracking_number, "
            "cost_price, items, total_amount, advance_amount, order_receiving_date, "
            "replacement_of_order_no"
        )
        while True:
            existing_orders_response = (
                supabase.table("orders")
                .select(existing_orders_select)
                .range(offset, offset + limit - 1)
                .execute()
            )
            if not existing_orders_response.data:
                break
            existing_orders_all.extend(existing_orders_response.data)
            if len(existing_orders_response.data) < limit:
                break
            offset += limit
        
        for o in existing_orders_all:
            order_num = o.get("order_number")
            if order_num is not None:
                existing_orders_map[str(order_num)] = o
        
        def extract_courier(order):
            """Extract courier from the latest non-cancelled fulfillment, or latest fulfillment if all are cancelled."""
            if "fulfillments" not in order or len(order["fulfillments"]) == 0:
                return "Unassigned"
            
            fulfillments = order["fulfillments"]
            
            # Filter out cancelled fulfillments first, but keep them as fallback
            active_fulfillments = [f for f in fulfillments if f.get("status") != "cancelled"]
            fulfillments_to_check = active_fulfillments if active_fulfillments else fulfillments
            
            if not fulfillments_to_check:
                return "Unassigned"
            
            # Find the latest fulfillment by updated_at (or created_at if updated_at is missing)
            latest_fulfillment = None
            latest_timestamp = None
            
            for fulfillment in fulfillments_to_check:
                # Prefer updated_at as it reflects the latest change
                timestamp_str = fulfillment.get("updated_at") or fulfillment.get("created_at")
                if not timestamp_str:
                    continue
                
                timestamp = _parse_iso(timestamp_str)
                if timestamp and (latest_timestamp is None or timestamp > latest_timestamp):
                    latest_timestamp = timestamp
                    latest_fulfillment = fulfillment
            
            # If we couldn't find by timestamp, use the last one in the list
            if not latest_fulfillment:
                latest_fulfillment = fulfillments_to_check[-1]
            
            tracking_company = latest_fulfillment.get("tracking_company")
            if tracking_company:
                tracking_company = str(tracking_company).strip()
                if tracking_company:
                    return tracking_company
            return "Unassigned"
        
        def extract_tracking_number(order):
            """Extract tracking number from the latest non-cancelled fulfillment, or latest fulfillment if all are cancelled."""
            if "fulfillments" not in order or len(order["fulfillments"]) == 0:
                return None
            
            fulfillments = order["fulfillments"]
            
            # Filter out cancelled fulfillments first, but keep them as fallback
            active_fulfillments = [f for f in fulfillments if f.get("status") != "cancelled"]
            fulfillments_to_check = active_fulfillments if active_fulfillments else fulfillments
            
            if not fulfillments_to_check:
                return None
            
            # Find the latest fulfillment by updated_at (or created_at if updated_at is missing)
            latest_fulfillment = None
            latest_timestamp = None
            
            for fulfillment in fulfillments_to_check:
                # Prefer updated_at as it reflects the latest change
                timestamp_str = fulfillment.get("updated_at") or fulfillment.get("created_at")
                if not timestamp_str:
                    continue
                
                timestamp = _parse_iso(timestamp_str)
                if timestamp and (latest_timestamp is None or timestamp > latest_timestamp):
                    latest_timestamp = timestamp
                    latest_fulfillment = fulfillment
            
            # If we couldn't find by timestamp, use the last one in the list
            if not latest_fulfillment:
                latest_fulfillment = fulfillments_to_check[-1]
            
            tracking_number = latest_fulfillment.get("tracking_number")
            if tracking_number:
                tracking_number = str(tracking_number).strip()
                if tracking_number:
                    return tracking_number
            return None
        
        def _parse_iso(s):
            if not s:
                return None
            if isinstance(s, datetime):
                return s
            s = str(s).strip().replace("Z", "+00:00")
            try:
                return datetime.fromisoformat(s)
            except (ValueError, TypeError):
                return None

        def extract_order_status(order):
            cancelled_at_raw = order.get("cancelled_at")
            fulfillment_dt = None
            for f in order.get("fulfillments") or []:
                ct = f.get("created_at")
                if ct:
                    parsed = _parse_iso(ct)
                    if parsed and (fulfillment_dt is None or parsed > fulfillment_dt):
                        fulfillment_dt = parsed
            if cancelled_at_raw and fulfillment_dt is not None:
                cancelled_at = _parse_iso(cancelled_at_raw)
                if cancelled_at and cancelled_at > fulfillment_dt:
                    return "returned"
            if cancelled_at_raw is not None:
                return "cancelled"
            fulfillment_status = order.get("fulfillment_status")
            if fulfillment_status == "fulfilled":
                return "fulfilled"
            return "unfulfilled"
        
        def extract_delivery_status(order):
            fulfillment_status = order.get("fulfillment_status")
            if fulfillment_status == "fulfilled":
                return "delivered"
            elif fulfillment_status == "partial":
                return "partially_delivered"
            elif fulfillment_status is None:
                return "not_delivered"
            else:
                return fulfillment_status or "not_delivered"
        
        def extract_advance_amount(order):
            if "note_attributes" in order:
                for attr in order["note_attributes"]:
                    if attr.get("name") in ["advance", "Advance", "advance_amount"]:
                        try:
                            return float(attr.get("value", 0))
                        except:
                            return None
            return None
        
        def extract_tax_amount(order):
            # Prefer current_* (reflects edits/refunds; avoids discrepancies when order is updated)
            if "current_total_tax_set" in order and order["current_total_tax_set"]:
                shop_money = order["current_total_tax_set"].get("shop_money", {})
                if shop_money:
                    return float(shop_money.get("amount", "0.00"))
            try:
                return float(order.get("current_total_tax") or 0)
            except (TypeError, ValueError):
                pass
            if "total_tax_set" in order and order["total_tax_set"]:
                shop_money = order["total_tax_set"].get("shop_money", {})
                if shop_money:
                    return float(shop_money.get("amount", "0.00"))
            return float(order.get("total_tax", "0.00"))
        
        def extract_cost_price(order):
            if "note_attributes" in order:
                for attr in order["note_attributes"]:
                    if attr.get("name") in ["cost_price", "Cost Price", "cost"]:
                        try:
                            return float(attr.get("value", 0))
                        except:
                            return None
            return None
        
        def calculate_cost_from_items(items, products_cost_map):
            """Calculate total cost price by looking up each item in the products table"""
            if not items:
                return 0.0
            
            total_cost = 0.0
            for item_name in items:
                item_lower = item_name.lower().strip()
                
                # Try exact match first
                if item_lower in products_cost_map:
                    total_cost += products_cost_map[item_lower]
                    continue
                
                # Try matching without variant suffix (e.g., "Product Name - S" -> "Product Name")
                # Items from Shopify are like "Product Name - Variant"
                if " - " in item_name:
                    product_name = item_name.rsplit(" - ", 1)[0].lower().strip()
                    if product_name in products_cost_map:
                        total_cost += products_cost_map[product_name]
                        continue
                
                # Try partial match - find products whose name is contained in item name
                for product_name, cost in products_cost_map.items():
                    if product_name in item_lower or item_lower in product_name:
                        total_cost += cost
                        break
            
            return total_cost
        
        def extract_items(order):
            """Build order items list from line_items, excluding removed items (current_quantity 0)."""
            if "line_items" not in order or not order["line_items"]:
                return []
            item_names = []
            for item in order["line_items"]:
                qty = item.get("current_quantity")
                if qty is None:
                    qty = item.get("quantity") or 0
                try:
                    qty = int(qty)
                except (TypeError, ValueError):
                    qty = 0
                if qty <= 0:
                    continue
                name = item.get("name", "")
                if name:
                    # Append name once per quantity so list reflects actual items in the order
                    for _ in range(qty):
                        item_names.append(name)
            return item_names

        def subtotal_line_items_excluding_removed(order):
            """Sum line item totals excluding removed items. Uses current_quantity (Shopify's quantity after removals) when present, else quantity. Removed lines have current_quantity=0."""
            if "line_items" not in order or not order["line_items"]:
                return None
            total = 0.0
            for item in order["line_items"]:
                # current_quantity is the quantity after edits/removals; when a line is removed it is 0
                qty = item.get("current_quantity")
                if qty is None:
                    qty = item.get("quantity") or 0
                try:
                    qty = int(qty)
                except (TypeError, ValueError):
                    qty = 0
                if qty <= 0:
                    continue
                try:
                    price = float(item.get("price") or 0)
                    total += price * qty
                except (TypeError, ValueError):
                    pass
            return total if total > 0 else None
        
        def normalize_value(val):
            if val is None:
                return None
            if isinstance(val, (int, float)):
                return round(float(val), 2)
            return str(val).strip() if val else None
        
        def has_changed(shopify_data, existing_data, skip_assigned_courier_fields=False):
            """
            skip_assigned_courier_fields: when True, do not compare courier, tracking_number,
            total_amount, delivery_charge, tax_amount, cost_price, items (used when courier is assigned).
            """
            fields_to_compare = ["courier", "tracking_number", "order_status", "total_amount", "advance_amount", "delivery_charge", "tax_amount", "cost_price", "items"]
            if skip_assigned_courier_fields:
                fields_to_compare = ["order_status", "piece_received", "advance_amount"]
            for field in fields_to_compare:
                shopify_val = normalize_value(shopify_data.get(field))
                existing_val = normalize_value(existing_data.get(field))
                if field in ["total_amount", "advance_amount", "delivery_charge", "tax_amount", "cost_price"]:
                    shopify_num = float(shopify_val) if shopify_val is not None else 0.0
                    existing_num = float(existing_val) if existing_val is not None else 0.0
                    if abs(shopify_num - existing_num) > 0.01:
                        return True
                elif field == "items":
                    shopify_list = shopify_val if isinstance(shopify_val, list) else []
                    existing_list = existing_val if isinstance(existing_val, list) else []
                    if set(shopify_list) != set(existing_list):
                        return True
                elif field == "courier":
                    shopify_str = (shopify_val or "").strip() or "Unassigned"
                    existing_str = (existing_val or "").strip() or "Unassigned"
                    if shopify_str.lower() != existing_str.lower():
                        return True
                elif field == "tracking_number":
                    shopify_str = (shopify_val or "").strip() if shopify_val else None
                    existing_str = (existing_val or "").strip() if existing_val else None
                    if shopify_str != existing_str:
                        return True
                else:
                    if shopify_val != existing_val:
                        return True
            return False
        
        orders_to_insert = []
        orders_to_update = []
        orders_to_skip = []
        original_orders_to_reset_piece_received = set()
        current_time = datetime.utcnow().isoformat()

        for sp_order in all_orders:
            order_number = sp_order.get("order_number")
            if not order_number:
                continue
            
            order_number = str(int(order_number))
            
            courier = extract_courier(sp_order)
            tracking_number = extract_tracking_number(sp_order)
            order_status = extract_order_status(sp_order)
            
            # Calculate total amount: use only non-removed line items (exclude quantity 0 / removed products)
            total_line_items_price = subtotal_line_items_excluding_removed(sp_order)
            if total_line_items_price is None:
                total_line_items_price = float(sp_order.get("total_line_items_price") or 0)
            shopify_tax = extract_tax_amount(sp_order) or 0.0  # Used only for total_amount calc; we never store tax from Shopify

            # Shopify shipping: we never store it as total_amount; delivery_charge is set in-app. If delivery was removed manually in Shopify, subtract it so total_amount excludes it.
            shipping_price = 0.0
            if "total_shipping_price_set" in sp_order and sp_order["total_shipping_price_set"]:
                shop_money = sp_order["total_shipping_price_set"].get("shop_money", {})
                if shop_money:
                    shipping_price = float(shop_money.get("amount", "0.00"))
            elif "total_shipping_price" in sp_order:
                shipping_price = float(sp_order.get("total_shipping_price") or 0)

            # Treat only configured discount codes as true price reductions.
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

            # Total amount:
            # Prefer fulfillment-derived merchandise + shipping for all orders.
            # If unavailable, fall back to Shopify totals.
            financial_status_peek = (sp_order.get("financial_status") or "").strip().lower()
            current_total = sp_order.get("current_total_price")
            total_price_val = sp_order.get("total_price")
            fulfillment_based_total = _order_total_from_fulfillments(sp_order)
            if fulfillment_based_total is not None:
                total_amount = fulfillment_based_total + shopify_tax
            elif current_total is not None and str(current_total).strip() != "":
                total_amount = float(current_total)
            elif total_price_val is not None and str(total_price_val).strip() != "":
                total_amount = float(total_price_val) - shipping_price
            else:
                total_amount = total_line_items_price + shopify_tax

            if has_price_reduction_discount_code:
                financial_status = financial_status_peek
                advance_amount = total_amount if financial_status == "paid" else 0.0
            else:
                total_discounts = float(sp_order.get("current_total_discounts") or sp_order.get("total_discounts") or 0)
                financial_status = financial_status_peek
                if financial_status == "paid":
                    advance_amount = total_amount
                else:
                    advance_amount = total_discounts

            # For voided orders, keep existing total charges so we don't reset to Shopify's zeroed values
            if financial_status == "voided" and order_number in existing_orders_map:
                existing_order = existing_orders_map[order_number]
                existing_total = float(existing_order.get("total_amount") or 0)
                existing_advance = float(existing_order.get("advance_amount") or 0)
                # Preserve existing if it is already set; otherwise use Shopify-derived total_price based amount
                if existing_total > 0.01:
                    total_amount = existing_total
                if existing_advance > 0.01:
                    advance_amount = existing_advance

            # delivery_charge and tax_amount are never taken from Shopify; set manually or via CSV
            delivery_charge = 0.0
            tax_amount = 0.0
            cost_price = extract_cost_price(sp_order) or 0.0
            
            # Set fixed delivery charge for SCS courier
            if courier.upper() == "SCS":
                delivery_charge = 180.0
            items = extract_items(sp_order)
            
            # If cost_price is 0, calculate it from items using products table
            if cost_price == 0.0 and items:
                cost_price = calculate_cost_from_items(items, products_cost_map)
            
            order_received_date = sp_order.get("created_at")
            if order_received_date:
                try:
                    order_received_date = datetime.fromisoformat(order_received_date.replace('Z', '+00:00')).isoformat()
                except:
                    try:
                        order_received_date = datetime.strptime(order_received_date, "%Y-%m-%dT%H:%M:%S%z").isoformat()
                    except:
                        order_received_date = current_time
            else:
                order_received_date = current_time
            
            replacement_of = None
            replacement_of_from_tag = False
            is_replacement_order = False
            if re.match(r"^\d+-R$", str(order_number or ""), re.IGNORECASE):
                replacement_of = re.match(r"^(\d+)-R$", str(order_number), re.IGNORECASE).group(1)
                is_replacement_order = True
            else:
                tags_raw = sp_order.get("tags")
                tags_str = (tags_raw if isinstance(tags_raw, str) else (str(tags_raw) if tags_raw is not None else "")).strip() or ""
                for tag in tags_str.split(","):
                    tag = tag.strip()
                    if re.match(r"^\d+-R$", tag, re.IGNORECASE):
                        replacement_of = re.match(r"^(\d+)-R$", tag, re.IGNORECASE).group(1)
                        replacement_of_from_tag = True
                        is_replacement_order = True
                        break

            # Replacement orders (XXXX-R) always have 0 cost price
            order_cost_price = 0.0 if is_replacement_order else cost_price

            order_data = {
                "order_number": order_number,
                "courier": courier,
                "tracking_number": tracking_number,
                "order_status": order_status,
                "piece_received": "Pending",
                "total_amount": total_amount,
                "advance_amount": advance_amount,
                "delivery_charge": delivery_charge,
                "tax_amount": tax_amount,
                "cost_price": order_cost_price,
                "order_receiving_date": order_received_date,
                "items": items,
                "replacement_of_order_no": replacement_of,
                "updated_at": current_time
            }
            if replacement_of_from_tag and replacement_of:
                original_orders_to_reset_piece_received.add(replacement_of)

            if order_number in existing_orders_map:
                existing_order = existing_orders_map[order_number]
                existing_status = (existing_order.get("order_status") or "").strip().lower()
                if existing_status in ("delivered", "returned"):
                    # Once an order has left "unfulfilled" (e.g. delivered/returned), do not overwrite totals/items/cost.
                    # Allow only replacement_of_order_no to be set if it was missing.
                    if replacement_of is not None and existing_order.get("replacement_of_order_no") != replacement_of:
                        # Only set replacement_of_order_no (e.g. first time we see tag 5404-R); do not overwrite advance/total
                        update_payload = {
                            **existing_order,
                            "replacement_of_order_no": replacement_of,
                            "updated_at": current_time,
                        }
                        orders_to_update.append(update_payload)
                    else:
                        orders_to_skip.append(order_number)
                    continue
                shopify_order_status = (order_data.get("order_status") or "").strip().lower()
                if shopify_order_status == "cancelled":
                    order_data["order_status"] = shopify_order_status
                elif shopify_order_status == "fulfilled" and existing_status == "unfulfilled":
                    order_data["order_status"] = shopify_order_status
                else:
                    order_data["order_status"] = existing_order.get("order_status")
                # Advance is always from Shopify: paid = total_amount, not paid = total_discounts
                order_data["advance_amount"] = advance_amount
                # Preserve tax_amount (never from Shopify; set manually or via CSV)
                order_data["tax_amount"] = existing_order.get("tax_amount", 0)
                # Preserve last fetched delivery status (from courier tracking)
                order_data["delivery_status"] = existing_order.get("delivery_status")
                # Preserve piece_received (set by delivery status or manually; default Pending)
                order_data["piece_received"] = existing_order.get("piece_received") or "Pending"

                existing_courier = (existing_order.get("courier") or "").strip()
                existing_tracking = (existing_order.get("tracking_number") or "").strip() if existing_order.get("tracking_number") else None
                courier_is_assigned = bool(existing_courier and existing_courier.lower() != "unassigned")
                freeze_amounts_items_cost = existing_status != "unfulfilled"

                # Compare and update courier and tracking_number from Shopify if they differ
                shopify_courier = (courier or "").strip()
                shopify_tracking = (tracking_number or "").strip() if tracking_number else None
                
                # Normalize for comparison (handle "Unassigned" vs empty)
                existing_courier_normalized = existing_courier.lower() if existing_courier else "unassigned"
                shopify_courier_normalized = shopify_courier.lower() if shopify_courier else "unassigned"
                
                # Update courier and tracking_number from Shopify if they differ
                courier_changed = existing_courier_normalized != shopify_courier_normalized
                tracking_changed = existing_tracking != shopify_tracking
                
                if courier_changed or tracking_changed:
                    # Update courier and tracking_number from Shopify
                    order_data["courier"] = courier
                    order_data["tracking_number"] = tracking_number
                else:
                    # Keep existing values if they match
                    order_data["courier"] = existing_order.get("courier")
                    order_data["tracking_number"] = existing_order.get("tracking_number")
                
                # Set delivery_charge: 180 for SCS courier only if not already set to a non-zero value
                # Preserve any manually set delivery_charge (never from Shopify; set manually or via CSV)
                final_courier = (order_data.get("courier") or "").strip().upper()
                existing_delivery_charge = float(existing_order.get("delivery_charge") or 0)
                if final_courier == "SCS" and existing_delivery_charge == 0:
                    # Only set to 180 if courier is SCS and delivery_charge hasn't been set yet
                    order_data["delivery_charge"] = 180.0
                else:
                    # Preserve existing delivery_charge (including any non-zero values)
                    order_data["delivery_charge"] = existing_delivery_charge

                # Preserve existing order_receiving_date - never overwrite from Shopify for existing orders
                order_data["order_receiving_date"] = existing_order.get("order_receiving_date")

                # Update total_amount/items/cost_price only while status is unfulfilled.
                # After it changes from unfulfilled, freeze these fields.
                if freeze_amounts_items_cost:
                    order_data["total_amount"] = existing_order.get("total_amount")
                    order_data["advance_amount"] = existing_order.get("advance_amount")
                    # Replacement orders (XXXX-R) always have 0 cost price
                    order_data["cost_price"] = 0.0 if is_replacement_order else existing_order.get("cost_price")
                    order_data["items"] = existing_order.get("items")
                    skip_fields = True
                else:
                    order_data["total_amount"] = total_amount
                    order_data["advance_amount"] = advance_amount
                    # Replacement orders (XXXX-R) always have 0 cost price
                    order_data["cost_price"] = 0.0 if is_replacement_order else cost_price
                    order_data["items"] = items
                    # When courier is assigned, we already avoid overwriting some fields via has_changed's skip mode.
                    skip_fields = courier_is_assigned

                # Always update if courier or tracking_number changed, otherwise check other fields
                if courier_changed or tracking_changed or has_changed(order_data, existing_order, skip_assigned_courier_fields=skip_fields):
                    order_data["id"] = existing_order["id"]
                    orders_to_update.append(order_data)
                else:
                    orders_to_skip.append(order_number)
            else:
                # First-time create: sync all fields from Shopify
                order_data["created_at"] = current_time
                orders_to_insert.append(order_data)
        
        created_count = 0
        if orders_to_insert:
            batch_size = 1000
            for i in range(0, len(orders_to_insert), batch_size):
                batch = orders_to_insert[i:i + batch_size]
                supabase.table("orders").upsert(batch, on_conflict="order_number").execute()
                created_count += len(batch)
        
        updated_count = 0
        if orders_to_update:
            batch_size = 1000
            for i in range(0, len(orders_to_update), batch_size):
                batch = orders_to_update[i:i + batch_size]
                supabase.table("orders").upsert(batch, on_conflict="order_number").execute()
                updated_count += len(batch)

        for original_num in original_orders_to_reset_piece_received:
            orig = (
                supabase.table("orders")
                .select("id, piece_received")
                .eq("order_number", original_num)
                .limit(1)
                .execute()
            )
            if orig.data:
                row = orig.data[0]
                piece_received = (row.get("piece_received") or "").strip().lower()
                if piece_received == "done":
                    supabase.table("orders").update({
                        "piece_received": "Pending",
                        "updated_at": current_time,
                    }).eq("id", row["id"]).execute()
        
        synced_count = created_count + updated_count
        skipped_count = len(orders_to_skip)

        return {
            "message": "Orders synced successfully",
            "synced": synced_count,
            "created": created_count,
            "updated": updated_count,
            "skipped": skipped_count,
            "pages_fetched": page_count,
            "total_orders_from_shopify": len(all_orders),
            "orders_per_page": 250 if len(all_orders) > 0 else 0
        }
        
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        error_text = e.response.text
        try:
            error_json = e.response.json()
            error_text = str(error_json)
        except:
            pass
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Shopify API error: {error_text}\nURL: {api_url if 'api_url' in locals() else 'N/A'}"
        )
    except httpx.RequestError as e:
        raise HTTPException(status_code=500, detail=f"Failed to connect to Shopify: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error syncing orders: {str(e)}")


def _parse_float(val: Any, default: float = 0.0) -> float:
    """Parse a CSV cell to float; return default if invalid. Strips commas and trailing %."""
    if val is None or (isinstance(val, str) and val.strip() == ""):
        return default
    try:
        s = str(val).strip().replace(",", "").rstrip("%").strip()
        return float(s) if s else default
    except (ValueError, TypeError):
        return default


@router.post("/upload-postex-csv")
async def upload_postex_csv(
    file: UploadFile = File(...),
    assignment_number: Optional[str] = Form(None),
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
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            text = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        if not reader.fieldnames:
            raise HTTPException(status_code=400, detail="CSV has no header row.")
        # Map possible column names to canonical keys
        # Use original fieldnames (not stripped) because DictReader uses original fieldnames as keys
        col_map = {}
        for i, name in enumerate(reader.fieldnames):
            key_upper = name.upper().strip()  # Compare against stripped uppercase
            key_norm = key_upper.replace(" ", "_")  # "WH INCOME TAX (2%)" -> "WH_INCOME_TAX_(2%)"
            # Check each pattern independently (not elif) to handle multiple columns
            # Store the ORIGINAL fieldname (with spaces if any) for use with row.get()
            if "SHIPPING_CHARGES" in key_upper and "shipping_charges" not in col_map:
                col_map["shipping_charges"] = name  # Use original name
            if "GST" in key_upper and "TAX" not in key_upper and "gst" not in col_map:
                col_map["gst"] = name  # Use original name
            # WH_INCOME_TAX (2%) or WH INCOME TAX (2%) or INCOME_TAX
            if ("wh_income_tax" not in col_map and (
                "WH_INCOME_TAX" in key_norm or "INCOME_TAX" in key_norm
                or ("WH" in key_upper and "INCOME" in key_upper and "TAX" in key_upper and "SALES" not in key_upper)
            )):
                col_map["wh_income_tax"] = name
            # WH_SALES_TAX (2%) or WH SALES TAX (2%) or SALES_TAX
            if ("wh_sales_tax" not in col_map and (
                "WH_SALES_TAX" in key_norm or "SALES_TAX" in key_norm
                or ("WH" in key_upper and "SALES" in key_upper and "TAX" in key_upper)
            )):
                col_map["wh_sales_tax"] = name
            if ("ORDER_REF_NUMBER" in key_upper or "ORDER_NUMBER" in key_upper or "ORDER_ID" in key_upper) and "order_ref_number" not in col_map:
                col_map["order_ref_number"] = name  # Use original name
            if ("TRACKING_NUMBER" in key_upper or "TRACKING" in key_upper) and "tracking_number" not in col_map:
                col_map["tracking_number"] = name
            if "NET_AMOUNT" in key_upper and "net_amount" not in col_map:
                col_map["net_amount"] = name
        if "order_ref_number" not in col_map:
            raise HTTPException(status_code=400, detail="CSV must contain an ORDER_REF_NUMBER, ORDER_NUMBER, or ORDER_ID column.")
        if "shipping_charges" not in col_map:
            raise HTTPException(status_code=400, detail="CSV must contain SHIPPING_CHARGES column.")
        tracking_col = col_map.get("tracking_number")
        
        def normalize_order_number(order_ref):
            """Extract order number from formats like #4807 or 4446-R.
            Returns string: '4807' for #4807, '4446-R' for 4446-R."""
            if order_ref is None:
                return None
            if isinstance(order_ref, (int, float)):
                return str(int(order_ref))
            order_str = str(order_ref).strip()
            if not order_str:
                return None
            # Check for replacement order pattern: digits followed by -R (case insensitive)
            replacement_match = re.match(r"#?(\d+)-R\b", order_str, re.IGNORECASE)
            if replacement_match:
                return f"{replacement_match.group(1)}-R"
            # Regular order: #XXXX or just digits
            match = re.search(r"\d+", order_str)
            if not match:
                return None
            return str(int(match.group(0)))

        def parse_tracking_number_14(val):
            """Parse 14-digit tracking number; CSV may show it as exponential (e.g. 2.63E+13)."""
            if val is None:
                return None
            s = str(val).strip()
            if not s:
                return None
            try:
                # Handle exponential notation (e.g. 2.63E+13 -> 26300000000000)
                if "e" in s.lower():
                    n = int(float(s))
                else:
                    n = int(s)
                # Return as 14-digit string (zero-pad if needed)
                return str(n).zfill(14) if 0 <= n < 10**14 else str(n)
            except (ValueError, TypeError):
                return None

        rows = []
        csv_order_numbers = []
        for row in reader:
            # Get values using the actual fieldnames from col_map
            order_ref_raw = row.get(col_map["order_ref_number"], "")
            order_number = normalize_order_number(order_ref_raw)
            if not order_number:
                continue
            shipping = _parse_float(row.get(col_map["shipping_charges"], ""), 0)
            gst = _parse_float(row.get(col_map.get("gst", ""), ""), 0)
            income_tax = _parse_float(row.get(col_map.get("wh_income_tax", ""), ""), 0)
            sales_tax = _parse_float(row.get(col_map.get("wh_sales_tax", ""), ""), 0)
            shipping_total = shipping + gst
            tax_total = income_tax + sales_tax
            tracking_raw = row.get(tracking_col, "") if tracking_col else ""
            tracking_str = parse_tracking_number_14(tracking_raw)
            net_amount_raw = row.get(col_map.get("net_amount", ""), "") if col_map.get("net_amount") else None
            net_amount_val = _parse_float(net_amount_raw, None) if net_amount_raw is not None and str(net_amount_raw).strip() != "" else None
            rows.append({
                "order_number": order_number,
                "delivery_charge": shipping_total,
                "tax_amount": tax_total,
                "tracking_number": tracking_str,
                "csv_net_amount": net_amount_val,
            })
            csv_order_numbers.append(order_number)
        if not rows:
            return {"updated": 0, "message": "No valid rows with ORDER_REF_NUMBER in CSV."}
        supabase = get_supabase()
        # Fetch all orders (we need to match by order_number)
        all_orders = []
        limit = 1000
        offset = 0
        while True:
            resp = supabase.table("orders").select("id, order_number, total_amount, advance_amount, order_status").range(offset, offset + limit - 1).execute()
            if not resp.data:
                break
            all_orders.extend(resp.data)
            if len(resp.data) < limit:
                break
            offset += limit
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
        updated_order_ids = []
        amount_mismatches = []  # { order_number, receivable, csv_net_amount, total_amount, advance_amount, delivery_charge, tax_amount }

        for r in rows:
            order_num = r["order_number"]
            order = order_number_to_order.get(order_num)
            if not order:
                unmatched_order_numbers.append(order_num)
                continue
            matched_order_numbers.append(order_num)
            update_data = {
                "delivery_charge": r["delivery_charge"],
                "tax_amount": r["tax_amount"],
                "courier": "PostEx",
                "updated_at": datetime.utcnow().isoformat(),
            }
            if r.get("tracking_number"):
                update_data["tracking_number"] = r["tracking_number"]
            if assignment_number is not None and assignment_number.strip():
                update_data["folio"] = assignment_number.strip()
            supabase.table("orders").update(update_data).eq("id", order["id"]).execute()
            updated_order_ids.append(order["id"])
            updated_count += 1

            # Receivable must match grid formula: returned -> -delivery_charge; else -> total - advance - delivery - tax
            total_amount = float(order.get("total_amount") or 0)
            advance_amount = float(order.get("advance_amount") or 0)
            delivery_charge = float(r["delivery_charge"])
            tax_amount = float(r["tax_amount"])
            order_status = (order.get("order_status") or "").strip().lower()
            if order_status == "returned":
                receivable = -delivery_charge
            else:
                receivable = total_amount - advance_amount - delivery_charge - tax_amount
            csv_net = r.get("csv_net_amount")
            if csv_net is not None:
                if round(receivable, 2) != round(float(csv_net), 2):
                    amount_mismatches.append({
                        "order_number": order_num,
                        "receivable": round(receivable, 2),
                        "csv_net_amount": round(float(csv_net), 2),
                        "total_amount": total_amount,
                        "advance_amount": advance_amount,
                        "delivery_charge": delivery_charge,
                        "tax_amount": tax_amount,
                        "order_status": order_status or None,
                    })

        # Build response message with debugging info
        message = f"Updated delivery charges, tax, courier (PostEx), and tracking for {updated_count} order(s)."
        if unmatched_order_numbers:
            message += f" {len(unmatched_order_numbers)} order number(s) from CSV did not match any orders."
            if len(unmatched_order_numbers) <= 10:
                message += f" Unmatched: {', '.join(map(str, unmatched_order_numbers[:10]))}"

        return {
            "updated": updated_count,
            "message": message,
            "updated_order_ids": updated_order_ids,
            "matched_order_numbers": matched_order_numbers,
            "csv_rows_processed": len(rows),
            "csv_order_numbers_count": len(csv_order_numbers),
            "db_order_numbers_count": len(set(db_order_numbers)),
            "matched_count": len(matched_order_numbers),
            "unmatched_count": len(unmatched_order_numbers),
            "amount_mismatches": amount_mismatches,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing CSV: {str(e)}")


class ReplacementOrderCreate(BaseModel):
    original_order_number: str
    total_amount: float
    advance_amount: float = 0.0
    cost_price: float = 0.0
    courier: str = "Unassigned"
    tracking_number: Optional[str] = None


@router.post("/create-replacement", response_model=dict)
async def create_replacement_order(body: ReplacementOrderCreate):
    """Create a replacement order (XXXX-R) based on an existing order's receiving date."""
    try:
        supabase = get_supabase()
        original_num = str(body.original_order_number).strip()
        if not original_num:
            raise HTTPException(status_code=400, detail="Original order number is required")

        replacement_order_number = f"{original_num}-R"

        existing_check = (
            supabase.table("orders")
            .select("id")
            .eq("order_number", replacement_order_number)
            .execute()
        )
        if existing_check.data:
            raise HTTPException(status_code=400, detail=f"Replacement order {replacement_order_number} already exists")

        original_order = (
            supabase.table("orders")
            .select("id, order_receiving_date, piece_received")
            .eq("order_number", original_num)
            .limit(1)
            .execute()
        )
        order_receiving_date = None
        if original_order.data:
            order_receiving_date = original_order.data[0].get("order_receiving_date")

        now = datetime.utcnow().isoformat()
        courier = (body.courier or "Unassigned").strip()
        delivery_charge = 180.0 if courier.upper() == "SCS" else 0.0

        order_data = {
            "order_number": replacement_order_number,
            "courier": courier,
            "tracking_number": (body.tracking_number or "").strip() or None,
            "order_status": "fulfilled",
            "piece_received": "Pending",
            "total_amount": body.total_amount,
            "advance_amount": body.advance_amount,
            "delivery_charge": delivery_charge,
            "tax_amount": 0.0,
            "cost_price": 0.0,  # Replacement orders always have 0 cost price
            "order_receiving_date": order_receiving_date or now,
            "items": None,
            "replacement_of_order_no": original_num,
            "created_at": now,
            "updated_at": now,
        }

        response = supabase.table("orders").insert(order_data).execute()

        # If original order has piece_received "Done", set it to "Pending". Leave "Pending" or "Received" unchanged.
        if original_order.data:
            orig_row = original_order.data[0]
            piece_received = (orig_row.get("piece_received") or "").strip().lower()
            if piece_received == "done":
                supabase.table("orders").update({
                    "piece_received": "Pending",
                    "updated_at": now,
                }).eq("id", orig_row["id"]).execute()

        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/fix-voided-totals", response_model=dict)
async def fix_voided_order_totals(
    only_returned_status: bool = Query(
        False,
        description="If true, only update rows whose DB order_status is 'returned' (legacy behavior). "
        "If false (default), update any order in the date range whose Shopify financial_status is voided.",
    ),
):
    """
    One-time maintenance endpoint.
    Recalculate total_amount for Shopify-voided orders on/after 22 Jan 2025 using:
    - Prefer fulfilled line items + shipping_lines (avoids double-counting replaced items); else Shopify total_price.

    By default processes every local order in range whose Shopify order is voided (not only DB status returned).
    """
    try:
        supabase = get_supabase()
        print(f"[fix-voided-totals] started | only_returned_status={only_returned_status}")

        # Start from 22 Jan 2025 (inclusive). Uses order_receiving_date if present, else created_at.
        start_iso = "2026-01-22T00:00:00"
        fetch_batch_size = 50

        # Fetch ALL candidate orders from DB (Supabase defaults to limit 1000, so we paginate).
        page_size = 1000
        orders: List[Dict[str, Any]] = []

        # 1) Orders with order_receiving_date on/after start_iso
        offset = 0
        while True:
            resp = (
                supabase.table("orders")
                .select("id, order_number, total_amount, advance_amount, order_status, order_receiving_date, created_at")
                .gte("order_receiving_date", start_iso)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            batch = resp.data or []
            if not batch:
                break
            orders.extend(batch)
            print(f"[fix-voided-totals] fetched by order_receiving_date batch size={len(batch)} offset={offset}")
            if len(batch) < page_size:
                break
            offset += page_size

        # 2) Orders where order_receiving_date is null but created_at on/after start_iso
        offset = 0
        seen_ids = {o["id"] for o in orders}
        while True:
            resp_created = (
                supabase.table("orders")
                .select("id, order_number, total_amount, advance_amount, order_status, order_receiving_date, created_at")
                .is_("order_receiving_date", "null")
                .gte("created_at", start_iso)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            batch = resp_created.data or []
            if not batch:
                break
            print(f"[fix-voided-totals] fetched by created_at batch size={len(batch)} offset={offset}")
            for o in batch:
                if o["id"] not in seen_ids:
                    orders.append(o)
                    seen_ids.add(o["id"])
            if len(batch) < page_size:
                break
            offset += page_size

        if not orders:
            print("[fix-voided-totals] no candidate orders found in date range")
            return {
                "updated_count": 0,
                "checked_count": 0,
                "voided_in_shopify_count": 0,
                "shopify_fetch_failed_count": 0,
                "skipped_not_voided_count": 0,
                "only_returned_status": only_returned_status,
            }

        print(f"[fix-voided-totals] total candidates={len(orders)}")
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
                print(f"[fix-voided-totals] skip row id={db_order.get('id')} reason=missing_order_number")
                continue

            if only_returned_status:
                status = (db_order.get("order_status") or "").strip().lower()
                if status != "returned":
                    print(f"[fix-voided-totals] skip order={order_number} reason=status_not_returned status={status}")
                    continue

            candidate_rows.append((order_number, db_order))

        eligible_candidates_count = len(candidate_rows)
        print(
            f"[fix-voided-totals] eligible local candidates={eligible_candidates_count} "
            f"batch_size={fetch_batch_size}"
        )

        for i in range(0, len(candidate_rows), fetch_batch_size):
            chunk = candidate_rows[i:i + fetch_batch_size]
            checked_count += len(chunk)
            chunk_start = i + 1
            chunk_end = i + len(chunk)
            print(f"[fix-voided-totals] processing chunk {chunk_start}-{chunk_end}")

            fetch_tasks = [
                _fetch_shopify_order_by_order_number(order_number)
                for order_number, _ in chunk
            ]
            fetch_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

            for (order_number, db_order), sp_order_result in zip(chunk, fetch_results):
                if isinstance(sp_order_result, Exception):
                    shopify_fetch_failed_count += 1
                    print(
                        f"[fix-voided-totals] skip order={order_number} "
                        f"reason=shopify_fetch_exception err={sp_order_result}"
                    )
                    continue

                sp_order = sp_order_result
                if not sp_order:
                    shopify_fetch_failed_count += 1
                    print(f"[fix-voided-totals] skip order={order_number} reason=shopify_fetch_failed")
                    continue

                financial_status_peek = (sp_order.get("financial_status") or "").strip().lower()
                if financial_status_peek != "voided":
                    skipped_not_voided_count += 1
                    print(
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
                    print(
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
                        print(
                            f"[fix-voided-totals] order={order_number} calc=fallback_total_price "
                            f"new_total={new_total:.2f}"
                        )
                    else:
                        new_total = total_line_items_price + shopify_tax
                        print(
                            f"[fix-voided-totals] order={order_number} calc=fallback_line_items_plus_tax "
                            f"line_items={total_line_items_price:.2f} tax={shopify_tax:.2f} new_total={new_total:.2f}"
                        )

                # Preserve advance_amount from DB; only fix total_amount
                existing_total = float(db_order.get("total_amount") or 0.0)
                if abs(existing_total - new_total) < 0.01:
                    print(
                        f"[fix-voided-totals] skip order={order_number} reason=no_change "
                        f"existing_total={existing_total:.2f} new_total={new_total:.2f}"
                    )
                    continue

                supabase.table("orders").update(
                    {
                        "total_amount": new_total,
                        "updated_at": datetime.utcnow().isoformat(),
                    }
                ).eq("id", db_order["id"]).execute()
                updated_count += 1
                updated_order_numbers.append(str(order_number))
                print(
                    f"[fix-voided-totals] updated order={order_number} "
                    f"existing_total={existing_total:.2f} new_total={new_total:.2f}"
                )

        print(
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class RecalculateTotalsBody(BaseModel):
    order_numbers: List[str]


@router.post("/recalculate-totals", response_model=dict)
async def recalculate_order_totals(body: RecalculateTotalsBody):
    """
    Recalculate total_amount for specified orders from Shopify.
    Uses fulfilled line items + shipping_lines (preferred) or fallback to Shopify total_price.
    Does NOT check for voided status - recalculates for any order.
    """
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    
    try:
        supabase = get_supabase()
        order_numbers_input = [str(n).strip() for n in body.order_numbers if str(n).strip()]
        
        if not order_numbers_input:
            raise HTTPException(status_code=400, detail="No valid order numbers provided")
        
        print(f"[recalculate-totals] started | order_numbers={order_numbers_input}")
        
        # Fetch the orders from DB
        db_orders_map: Dict[str, Dict[str, Any]] = {}
        for order_num in order_numbers_input:
            resp = (
                supabase.table("orders")
                .select("id, order_number, total_amount, advance_amount, order_status")
                .eq("order_number", order_num)
                .limit(1)
                .execute()
            )
            if resp.data:
                db_orders_map[order_num] = resp.data[0]
        
        not_found_in_db = [n for n in order_numbers_input if n not in db_orders_map]
        if not_found_in_db:
            print(f"[recalculate-totals] orders not found in DB: {not_found_in_db}")
        
        updated_count = 0
        checked_count = 0
        shopify_fetch_failed_count = 0
        updated_order_numbers: List[str] = []
        fetch_batch_size = 50
        
        # Process orders in batches
        candidate_rows = list(db_orders_map.items())
        
        for i in range(0, len(candidate_rows), fetch_batch_size):
            chunk = candidate_rows[i:i + fetch_batch_size]
            checked_count += len(chunk)
            
            fetch_tasks = [
                _fetch_shopify_order_by_order_number(order_number)
                for order_number, _ in chunk
            ]
            fetch_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)
            
            for (order_number, db_order), sp_order_result in zip(chunk, fetch_results):
                if isinstance(sp_order_result, Exception):
                    shopify_fetch_failed_count += 1
                    print(f"[recalculate-totals] skip order={order_number} reason=shopify_fetch_exception err={sp_order_result}")
                    continue
                
                sp_order = sp_order_result
                if not sp_order:
                    shopify_fetch_failed_count += 1
                    print(f"[recalculate-totals] skip order={order_number} reason=shopify_fetch_failed")
                    continue
                
                # Calculate new total using the same logic as fix-voided-totals
                shopify_tax = _compute_shopify_tax(sp_order) or 0.0
                voided_from_fulfillments = _order_total_from_fulfillments(sp_order)
                
                if voided_from_fulfillments is not None:
                    new_total = voided_from_fulfillments + shopify_tax
                    print(f"[recalculate-totals] order={order_number} calc=fulfillments_plus_shipping base={voided_from_fulfillments:.2f} tax={shopify_tax:.2f} new_total={new_total:.2f}")
                else:
                    total_line_items_price = 0.0
                    try:
                        total_line_items_price = float(sp_order.get("total_line_items_price") or 0)
                    except (ValueError, TypeError):
                        total_line_items_price = 0.0
                    total_price_val = sp_order.get("total_price")
                    if total_price_val is not None and str(total_price_val).strip() != "":
                        new_total = float(total_price_val)
                        print(f"[recalculate-totals] order={order_number} calc=fallback_total_price new_total={new_total:.2f}")
                    else:
                        new_total = total_line_items_price + shopify_tax
                        print(f"[recalculate-totals] order={order_number} calc=fallback_line_items_plus_tax line_items={total_line_items_price:.2f} tax={shopify_tax:.2f} new_total={new_total:.2f}")
                
                # Update the order
                existing_total = float(db_order.get("total_amount") or 0.0)
                if abs(existing_total - new_total) < 0.01:
                    print(f"[recalculate-totals] skip order={order_number} reason=no_change existing_total={existing_total:.2f} new_total={new_total:.2f}")
                    continue
                
                supabase.table("orders").update(
                    {
                        "total_amount": new_total,
                        "updated_at": datetime.utcnow().isoformat(),
                    }
                ).eq("id", db_order["id"]).execute()
                updated_count += 1
                updated_order_numbers.append(str(order_number))
                print(f"[recalculate-totals] updated order={order_number} existing_total={existing_total:.2f} new_total={new_total:.2f}")
        
        print(f"[recalculate-totals] completed | checked={checked_count} updated={updated_count} fetch_failed={shopify_fetch_failed_count}")
        
        return {
            "updated_count": updated_count,
            "checked_count": checked_count,
            "shopify_fetch_failed_count": shopify_fetch_failed_count,
            "updated_order_numbers": updated_order_numbers,
            "not_found_in_db": not_found_in_db,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/by-number/{order_number}")
async def get_order_by_number(order_number: str):
    """Get a single order by order_number (e.g. 4-digit number). Used when order is not in current grid (e.g. different period)."""
    try:
        num = order_number.strip()
        if not num:
            raise HTTPException(status_code=400, detail="order_number required")
        supabase = get_supabase()
        # Match as string; DB may store as string or int
        response = supabase.table("orders").select("*").eq("order_number", num).limit(1).execute()
        if not response.data or len(response.data) == 0:
            raise HTTPException(status_code=404, detail="Order not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class LoadSheetLogCreate(BaseModel):
    assignment_number: str
    rider_name: str
    order_numbers: List[str]
    delivery_charge: Optional[float] = None  # delivery charges to store in log and apply to all orders


# Load Sheet Logs (must be before /{order_id} so "load-sheet-logs" is not matched as order_id)
@router.post("/load-sheet-logs", response_model=dict)
async def create_load_sheet_log(body: LoadSheetLogCreate):
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
        row = {
            "assignment_number": body.assignment_number.strip(),
            "rider_name": body.rider_name.strip(),
            "order_numbers": body.order_numbers,
        }
        if dc is not None:
            row["delivery_charge"] = float(dc)
        response = supabase.table("load_sheet_logs").insert(row).execute()
        if not response.data or len(response.data) == 0:
            raise HTTPException(status_code=500, detail="Failed to create load sheet log")
        # Update all orders in this load sheet: set folio to assignment number, and optionally delivery_charge
        if body.order_numbers:
            update_data = {
                "folio": body.assignment_number.strip(),
                "updated_at": datetime.utcnow().isoformat(),
            }
            if dc is not None:
                update_data["delivery_charge"] = float(dc)
            supabase.table("orders").update(update_data).in_("order_number", body.order_numbers).execute()
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/load-sheet-logs", response_model=List[dict])
async def list_load_sheet_logs():
    """List all load sheet logs, newest first."""
    try:
        supabase = get_supabase()
        response = (
            supabase.table("load_sheet_logs")
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
        if "does not exist" in err_msg.lower() or "load_sheet_logs" in err_msg or "relation" in err_msg.lower():
            raise HTTPException(
                status_code=503,
                detail="Load sheet logs table is not set up. Add the load_sheet_logs table (see supabase_schema.sql) and run the migration."
            )
        raise HTTPException(status_code=500, detail=err_msg)


@router.get("/load-sheet-logs/{log_id}/pdf")
async def get_load_sheet_log_pdf(log_id: str):
    """Regenerate and download the PDF for a load sheet log."""
    try:
        supabase = get_supabase()
        log_response = (
            supabase.table("load_sheet_logs")
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
            orders_response = supabase.table("orders").select("*").in_("order_number", order_numbers).execute()
        elif order_ids:
            orders_response = supabase.table("orders").select("*").in_("id", order_ids).execute()
        else:
            raise HTTPException(status_code=400, detail="No orders in this load sheet log")
        orders = orders_response.data or []
        if not orders:
            raise HTTPException(status_code=404, detail="Orders not found")
        assignment_number = (log_row.get("assignment_number") or "").strip() or None
        rider_name = (log_row.get("rider_name") or "").strip() or None
        pdf_buffer = _generate_pdf_load_sheet(orders, None, assignment_number=assignment_number, rider_name=rider_name)
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=load_sheet.pdf"},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/load-sheet-logs/{log_id}")
async def delete_load_sheet_log(log_id: str):
    """Delete a load sheet log by ID. Clears folio on all orders that were in this load sheet."""
    try:
        supabase = get_supabase()
        # Fetch the log to get order_numbers before deleting
        log_response = supabase.table("load_sheet_logs").select("order_numbers").eq("id", log_id).execute()
        if not log_response.data or len(log_response.data) == 0:
            raise HTTPException(status_code=404, detail="Load sheet log not found")
        order_numbers = log_response.data[0].get("order_numbers") or []
        # Clear folio on all orders that were in this load sheet
        if order_numbers:
            supabase.table("orders").update({
                "folio": None,
                "updated_at": datetime.utcnow().isoformat(),
            }).in_("order_number", order_numbers).execute()
        # Delete the load sheet log
        response = (
            supabase.table("load_sheet_logs")
            .delete()
            .eq("id", log_id)
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Load sheet log not found")
        return {"message": "Load sheet log deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/returned-delivery-charges-sum")
async def get_returned_delivery_charges_sum():
    """Sum of delivery_charge for all orders with order_status 'returned'."""
    try:
        supabase = get_supabase()
        response = (
            supabase.table("orders")
            .select("delivery_charge")
            .ilike("order_status", "returned")
            .execute()
        )
        total = sum(float(row.get("delivery_charge") or 0) for row in (response.data or []))
        return {"sum": total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{order_id}")
async def get_order(order_id: str):
    """Get a single order by ID"""
    try:
        supabase = get_supabase()
        response = supabase.table("orders").select("*").eq("id", order_id).single().execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Order not found")
        return response.data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    if "return" in status_lower:
        return "returned"
    if "delivered to customer" in status_lower:
        return "delivered"
    if "attempt made: rfd" in status_lower:
        return "RFD"
    if "attempt made: ica" in status_lower:
        return "ICA"
    if "attempt made: cna" in status_lower:
        return "CNA"
    return None


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

@router.post("/", response_model=dict)
async def create_order(order: OrderCreate):
    """Create a new order"""
    try:
        supabase = get_supabase()
        order_data = order.model_dump()
        order_data["piece_received"] = "Pending"
        now = datetime.utcnow().isoformat()
        order_data["created_at"] = now
        order_data["updated_at"] = now
        if not order_data.get("order_receiving_date"):
            order_data["order_receiving_date"] = now
        response = supabase.table("orders").insert(order_data).execute()
        return response.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
    now_iso = datetime.utcnow().isoformat()
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
    order_numbers: List[str]
    order_status: str  # "delivered", "returned", or "cancelled"


@router.post("/bulk-update-status")
async def bulk_update_order_status(body: BulkUpdateStatusBody):
    """Update order_status and delivery_status.latest_status for multiple orders by order_number."""
    if body.order_status not in ("delivered", "returned", "cancelled"):
        raise HTTPException(status_code=400, detail="order_status must be 'delivered', 'returned', or 'cancelled'")
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    try:
        supabase = get_supabase()
        # Fetch orders so we can merge delivery_status and optionally set piece_received per order
        response = (
            supabase.table("orders")
            .select("id, order_number, delivery_status, piece_received")
            .in_("order_number", body.order_numbers)
            .execute()
        )
        orders = response.data or []
        updated_at = datetime.utcnow().isoformat()
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
            supabase.table("orders").update(update_payload).eq("id", order_id).execute()
            onum = order.get("order_number")
            if onum is not None:
                updated_order_numbers.append(str(onum))
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class BulkUpdatePieceReceivedBody(BaseModel):
    order_numbers: List[str]


class BulkUpdateDeliveryChargeBody(BaseModel):
    order_numbers: List[str]
    delivery_charge: float


@router.post("/bulk-update-delivery-charges")
async def bulk_update_delivery_charges(body: BulkUpdateDeliveryChargeBody):
    """Set delivery_charge for multiple orders by order_number."""
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    if body.delivery_charge < 0:
        raise HTTPException(status_code=400, detail="delivery_charge must be 0 or greater")
    try:
        supabase = get_supabase()
        update_data = {
            "delivery_charge": float(body.delivery_charge),
            "updated_at": datetime.utcnow().isoformat(),
        }
        response = (
            supabase.table("orders")
            .update(update_data)
            .in_("order_number", body.order_numbers)
            .execute()
        )
        updated_rows = response.data or []
        updated_order_numbers = [str(o["order_number"]) for o in updated_rows if o.get("order_number") is not None]
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-update-piece-received")
async def bulk_update_piece_received(body: BulkUpdatePieceReceivedBody):
    """Set piece_received to 'Received' for multiple orders by order_number."""
    if not body.order_numbers:
        raise HTTPException(status_code=400, detail="order_numbers cannot be empty")
    try:
        supabase = get_supabase()
        update_data = {
            "piece_received": "Received",
            "updated_at": datetime.utcnow().isoformat(),
        }
        response = (
            supabase.table("orders")
            .update(update_data)
            .in_("order_number", body.order_numbers)
            .execute()
        )
        updated_rows = response.data or []
        updated_order_numbers = [str(o["order_number"]) for o in updated_rows if o.get("order_number") is not None]
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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{order_id}")
async def update_order(order_id: str, order: OrderUpdate):
    """Update an existing order"""
    try:
        supabase = get_supabase()
        # Include only fields that were sent (so we can set optional fields like folio to null)
        update_data = {k: v for k, v in order.model_dump(exclude_unset=True).items()}
        update_data["updated_at"] = datetime.utcnow().isoformat()
        response = supabase.table("orders").update(update_data).eq("id", order_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Order not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{order_id}/delivery-status")
async def get_delivery_status(order_id: str, save: bool = Query(False, description="If true, store fetched status in order.delivery_status")):
    """Fetch delivery status from courier API. Optionally store in order.delivery_status when save=true."""
    try:
        supabase = get_supabase()
        # Use limit(1) instead of single() so "not found" returns 404, not 500
        order_response = supabase.table("orders").select("*").eq("id", order_id).limit(1).execute()
        
        if not order_response.data or len(order_response.data) == 0:
            raise HTTPException(status_code=404, detail="Order not found")
        
        order = order_response.data[0]
        courier = order.get("courier", "").strip()
        tracking_number = order.get("tracking_number", "").strip()
        
        if not tracking_number:
            raise HTTPException(status_code=400, detail="Tracking number not available")
        
        if courier.upper() == "UNASSIGNED":
            raise HTTPException(status_code=400, detail="Courier not assigned")
        
        delivery_status_data = None
        existing_delivery = order.get("delivery_status")

        if courier.upper() == "POSTEX":
            # Always fetch fresh data from PostEx to ensure we have the latest status
            # (Previously we skipped fetch for "final" statuses, but this caused stale data issues)
            async with httpx.AsyncClient(timeout=30.0) as client:
                api_url = f"https://api.postex.pk/services/courier/api/guest/get-order/{tracking_number}"
                response = await client.get(api_url)
                response.raise_for_status()
                data = response.json()
                if data.get("statusCode") == "200" and "dist" in data:
                    dist = data["dist"]
                    status_history_raw = dist.get("transactionStatusHistory", [])
                    
                    # Build status history list with parsed datetime for sorting
                    status_history_parsed = []
                    for item in status_history_raw:
                        entry = {
                            "status": item.get("transactionStatusMessage", ""),
                            "status_code": item.get("transactionStatusMessageCode", ""),
                            "datetime": item.get("modifiedDatetime", "")
                        }
                        status_history_parsed.append(entry)
                    
                    # Sort by datetime ascending (oldest first, newest last)
                    # PostEx returns history in reverse chronological order (newest first)
                    def parse_datetime_for_sort(entry):
                        dt_str = entry.get("datetime", "")
                        if not dt_str:
                            return ""
                        try:
                            # PostEx datetime format: "2024-01-15T10:30:00" or similar ISO format
                            return dt_str
                        except Exception:
                            return ""
                    
                    status_history_sorted = sorted(status_history_parsed, key=parse_datetime_for_sort)
                    
                    # Latest status is the one with the most recent datetime
                    latest_status = ""
                    if status_history_sorted:
                        latest_status = status_history_sorted[-1].get("status", "")
                    
                    delivery_status_data = {
                        "courier": "PostEx",
                        "tracking_number": dist.get("trackingNumber", tracking_number),
                        "customer_name": dist.get("customerName", ""),
                        "order_pickup_date": dist.get("orderPickupDate", ""),
                        "status_history": status_history_sorted,
                        "latest_status": latest_status,
                        "fetched_at": datetime.utcnow().isoformat()
                    }
        else:
            raise HTTPException(status_code=400, detail="Only PostEx is supported for delivery status tracking")
        
        if not delivery_status_data:
            raise HTTPException(status_code=500, detail="Failed to fetch delivery status")

        # Persist fetched data and update order_status when save=true
        if save:
            update_payload = {
                "delivery_status": delivery_status_data,
                "updated_at": datetime.utcnow().isoformat()
            }
            # Derive order_status from the LAST courier status instead of using a fixed priority.
            derived_status = _derive_order_status_from_latest(delivery_status_data)
            print(f"[delivery-status] order_id={order_id} latest_status={delivery_status_data.get('latest_status')!r} derived_status={derived_status!r}")
            if derived_status:
                update_payload["order_status"] = derived_status
                print(f"[delivery-status] Updating order_status to {derived_status}")
                if derived_status == "delivered":
                    # Set piece_received to Done only when still Pending (first time delivered). Do not overwrite if user already changed it.
                    current_piece = (order.get("piece_received") or "").strip().lower()
                    if current_piece == "pending":
                        update_payload["piece_received"] = "Done"
            else:
                print(f"[delivery-status] No derived_status, order_status not updated")
            supabase.table("orders").update(update_payload).eq("id", order_id).execute()
            print(f"[delivery-status] Update payload: {update_payload.keys()}")

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
        raise HTTPException(status_code=500, detail=f"Error fetching delivery status: {str(e)}")

@router.delete("/{order_id}")
async def delete_order(order_id: str):
    """Delete an order"""
    try:
        supabase = get_supabase()
        response = supabase.table("orders").delete().eq("id", order_id).execute()
        return {"message": "Order deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _generate_pdf_load_sheet(
    orders: List[dict],
    template_path: Optional[Path] = None,
    assignment_number: Optional[str] = None,
    rider_name: Optional[str] = None,
) -> BytesIO:
    """
    Generate a PDF load sheet from orders data.
    
    Args:
        orders: List of order dictionaries
        template_path: Optional path to a PDF template (for future use with PyPDF2/pdfrw)
        assignment_number: Optional assignment number to show on the PDF
        rider_name: Optional rider name to show on the PDF
    
    Returns:
        BytesIO buffer containing the PDF
    """
    
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, 
                           rightMargin=20*mm, leftMargin=20*mm,
                           topMargin=20*mm, bottomMargin=20*mm)
    
    # Container for the 'Flowable' objects
    elements = []
    styles = getSampleStyleSheet()
    
    # Custom styles - Black and white theme
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=18,
        textColor=colors.black,
        spaceAfter=30,
        alignment=TA_CENTER
    )
    
    heading_style = ParagraphStyle(
        'CustomHeading',
        parent=styles['Heading2'],
        fontSize=12,
        textColor=colors.black,
        spaceAfter=12,
        spaceBefore=12
    )
    
    normal_style = ParagraphStyle(
        'CustomNormal',
        parent=styles['Normal'],
        fontSize=10,
        textColor=colors.black
    )
    
    # Add logo image above the title
    # Path: __file__ is backend/app/routes/orders.py, so we need to go up one level to backend/app/
    logo_path = Path(__file__).parent.parent / "logo_load_sheet.png"
    logo_absolute_path = logo_path.absolute()
    
    if logo_path.exists():
        try:
            # Load image using PIL/Pillow first to verify it can be loaded
            from PIL import Image as PILImage
            pil_img = PILImage.open(str(logo_absolute_path))
            
            # Calculate height maintaining aspect ratio (max width 80mm)
            img_width_px, img_height_px = pil_img.size
            max_width_mm = 80
            width_mm = min(max_width_mm, (img_width_px / 96) * 25.4)  # Convert pixels to mm (assuming 96 DPI)
            aspect_ratio = img_height_px / img_width_px
            height_mm = width_mm * aspect_ratio
            
            # Create reportlab Image
            logo = Image(str(logo_absolute_path), width=width_mm*mm, height=height_mm*mm)
            
            # Center the image using a table
            logo_table = Table([[logo]], colWidths=[doc.width])
            logo_table.setStyle(TableStyle([
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ]))
            elements.append(logo_table)
            elements.append(Spacer(1, 5*mm))
        except Exception as e:
            # If image loading fails, continue without logo
            import traceback
            print(f"Warning: Could not load logo image: {e}")
            traceback.print_exc()
    else:
        print(f"Warning: Logo file not found at {logo_absolute_path}")
    
    # Title
    elements.append(Paragraph("Load Sheet", title_style))
    elements.append(Spacer(1, 10*mm))
    
    # Date, Assignment #, Rider (each on its own line)
    now = datetime.now()
    current_date = now.strftime("%d/%m/%Y")
    elements.append(Paragraph(f"<b>Date:</b> {current_date}", normal_style))
    if assignment_number:
        elements.append(Paragraph(f"<b>Assignment #:</b> {assignment_number}", normal_style))
    if rider_name:
        elements.append(Paragraph(f"<b>Rider:</b> {rider_name}", normal_style))
    elements.append(Spacer(1, 5*mm))
    
    # Sort orders by order_number
    orders.sort(key=lambda x: x.get("order_number", ""))
    
    # Prepare table data
    table_data = [
        ['Order Number', 'Tracking Number', 'COD', 'Delivery Charge', 'Net Amount']
    ]
    
    net_amount_sum = 0
    
    for order in orders:
        order_number = order.get("order_number", "")
        tracking_number = order.get("tracking_number", "") or ""
        total_amount = float(order.get("total_amount", 0) or 0)
        advance_amount = float(order.get("advance_amount", 0) or 0)
        delivery_charge = float(order.get("delivery_charge", 0) or 0)
        tax_amount = float(order.get("tax_amount", 0) or 0)
        
        # Calculate COD (total_amount - advance_amount)
        cod = total_amount - advance_amount
        
        # Calculate Net Amount (receivable = total_amount - advance_amount - delivery_charge - tax_amount)
        net_amount = total_amount - advance_amount - delivery_charge - tax_amount
        net_amount_sum += net_amount
        
        # Format currency values
        table_data.append([
            order_number,
            tracking_number,
            f"{cod:.2f}",
            f"{delivery_charge:.2f}",
            f"{net_amount:.2f}"
        ])
    
    # Add final balance row - use Paragraph objects for proper formatting
    # Create styles with appropriate alignment
    final_balance_label_style = ParagraphStyle(
        'FinalBalanceLabel',
        parent=normal_style,
        alignment=TA_LEFT
    )
    final_balance_amount_style = ParagraphStyle(
        'FinalBalanceAmount',
        parent=normal_style,
        alignment=TA_RIGHT
    )
    table_data.append([
        '',
        '',
        '',
        Paragraph('<b>Final Balance</b>', final_balance_label_style),
        Paragraph(f'<b>{net_amount_sum:.2f}</b>', final_balance_amount_style)
    ])
    
    # Create table
    table = Table(table_data, colWidths=[40*mm, 50*mm, 30*mm, 35*mm, 35*mm])
    
    # Style the table - Black and white style
    table.setStyle(TableStyle([
        # Header row - black background with white text
        ('BACKGROUND', (0, 0), (-1, 0), colors.black),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 11),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
        ('TOPPADDING', (0, 0), (-1, 0), 12),
        
        # Data rows - white background with black text, alternating rows
        ('BACKGROUND', (0, 1), (-1, -2), colors.white),
        ('TEXTCOLOR', (0, 1), (-1, -2), colors.black),
        ('FONTNAME', (0, 1), (-1, -2), 'Helvetica'),
        ('FONTSIZE', (0, 1), (-1, -2), 10),
        ('GRID', (0, 0), (-1, -1), 1, colors.black),
        ('ROWBACKGROUNDS', (0, 1), (-1, -2), [colors.white, colors.HexColor('#F5F5F5')]),
        
        # Final balance row - light gray background with black text
        ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#E0E0E0')),
        ('TEXTCOLOR', (0, -1), (-1, -1), colors.black),
        ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, -1), (-1, -1), 11),
        ('TOPPADDING', (0, -1), (-1, -1), 12),
        ('BOTTOMPADDING', (0, -1), (-1, -1), 12),
        
        # Alignment for numeric columns
        ('ALIGN', (2, 1), (-1, -1), 'RIGHT'),
    ]))
    
    elements.append(table)
    
    # Build PDF
    doc.build(elements)
    buffer.seek(0)
    return buffer


def _shopify_latest_fulfillment_for_invoice(order: dict) -> Optional[dict]:
    """Latest non-cancelled fulfillment by updated_at/created_at (same idea as sync)."""
    fulfillments = order.get("fulfillments") or []
    if not fulfillments:
        return None
    active = [f for f in fulfillments if f.get("status") != "cancelled"]
    to_check = active if active else fulfillments
    if not to_check:
        return None
    latest = None
    latest_ts = None
    for f in to_check:
        ts_str = f.get("updated_at") or f.get("created_at")
        if not ts_str:
            continue
        try:
            ts = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        if latest_ts is None or ts > latest_ts:
            latest_ts = ts
            latest = f
    return latest if latest else to_check[-1]


def _tracking_from_shopify_order(order: dict) -> Optional[str]:
    f = _shopify_latest_fulfillment_for_invoice(order)
    if not f:
        return None
    tn = f.get("tracking_number")
    if tn and str(tn).strip():
        return str(tn).strip()
    return None


def _format_shopify_address(addr: Optional[dict]) -> str:
    if not addr:
        return ""
    parts = []
    for key in ("address1", "address2", "city", "province", "zip", "country"):
        v = addr.get(key)
        if v is not None and str(v).strip():
            parts.append(str(v).strip())
    return ", ".join(parts)


def _consignee_from_shopify_order(order: dict) -> Tuple[str, str, str]:
    addr = order.get("shipping_address") or order.get("billing_address") or {}
    name = (addr.get("name") or "").strip()
    if not name:
        fn = (addr.get("first_name") or "").strip()
        ln = (addr.get("last_name") or "").strip()
        name = f"{fn} {ln}".strip() or "-"
    phone = (addr.get("phone") or "").strip()
    if not phone:
        phone = (order.get("phone") or "").strip()
    if not phone:
        cust = order.get("customer") or {}
        phone = (cust.get("phone") or "").strip()
    if not phone:
        phone = (order.get("contact_email") or order.get("email") or "").strip()
    address = _format_shopify_address(addr)
    return name, phone or "-", address or "-"


def _line_items_from_shopify_order(order: dict) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for line in order.get("line_items") or []:
        qty = line.get("current_quantity")
        if qty is None:
            qty = line.get("quantity") or 0
        try:
            qty = int(qty)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            continue
        title = (line.get("title") or "").strip() or "-"
        variant = (line.get("variant_title") or "").strip()
        if not variant:
            variant = "-"
        try:
            price = float(line.get("price") or 0)
        except (TypeError, ValueError):
            price = 0.0
        rows.append({"product": title, "size": variant, "quantity": qty, "unit_price": price})
    return rows


def _line_items_from_db_items(db_order: dict) -> List[Dict[str, Any]]:
    items = db_order.get("items") or []
    rows: List[Dict[str, Any]] = []
    for line in items:
        if not isinstance(line, str):
            continue
        line = line.strip()
        if not line:
            continue
        if " - " in line:
            title, variant = line.rsplit(" - ", 1)
            rows.append(
                {"product": title.strip(), "size": variant.strip(), "quantity": 1, "unit_price": None}
            )
        else:
            rows.append({"product": line, "size": "-", "quantity": 1, "unit_price": None})
    return rows


def _invoice_remarks_from_shopify(order: dict) -> str:
    note = (order.get("note") or "").strip()
    if note:
        return note
    tags = order.get("tags")
    tags_str = (tags if isinstance(tags, str) else (str(tags) if tags is not None else "")).strip()
    if tags_str and "confirmed" in tags_str.lower():
        return "THIS ORDER IS 100% CONFIRMED"
    return "THIS ORDER IS 100% CONFIRMED"


def _invoice_pieces_from_shopify(order: dict) -> int:
    total = 0
    for li in order.get("line_items") or []:
        q = li.get("current_quantity")
        if q is None:
            q = li.get("quantity") or 0
        try:
            q = int(q)
        except (TypeError, ValueError):
            q = 0
        if q > 0:
            total += q
    return total if total > 0 else 1


def _build_invoice_order_context(db_order: dict, sp_order: Optional[dict]) -> dict:
    """
    Merge DB row with optional Shopify order payload (same shape as debug_order.json).
    Adds invoice_* keys used only for PDF generation.
    """
    ctx = dict(db_order)
    default_origin = "Karachi"

    if sp_order:
        c_name, c_phone, c_addr = _consignee_from_shopify_order(sp_order)
        ctx["shipping_name"] = c_name
        ctx["shipping_phone"] = c_phone
        ctx["shipping_address"] = c_addr
        ref = (sp_order.get("name") or "").strip()
        ctx["invoice_order_ref"] = ref if ref else f"#{db_order.get('order_number')}"
        tn = _tracking_from_shopify_order(sp_order)
        if tn:
            ctx["tracking_number"] = tn
        try:
            cur = sp_order.get("current_total_price")
            if cur is not None and str(cur).strip() != "":
                ctx["total_amount"] = float(cur)
            else:
                ctx["total_amount"] = float(sp_order.get("total_price") or db_order.get("total_amount") or 0)
        except (TypeError, ValueError):
            ctx["total_amount"] = float(db_order.get("total_amount") or 0)
        cur = sp_order.get("currency") or sp_order.get("presentment_currency") or "PKR"
        ctx["invoice_currency"] = str(cur).strip() or "PKR"
        created = sp_order.get("created_at") or sp_order.get("processed_at")
        if created:
            ctx["order_receiving_date"] = created
        ctx["invoice_pieces"] = _invoice_pieces_from_shopify(sp_order)
        addr = sp_order.get("shipping_address") or {}
        dest_city = (addr.get("city") or "").strip()
        ctx["invoice_destination"] = dest_city or "-"
        ctx["invoice_origin"] = default_origin
        ctx["invoice_return_city"] = default_origin
        ctx["invoice_remarks"] = _invoice_remarks_from_shopify(sp_order)
        ctx["invoice_line_items"] = _line_items_from_shopify_order(sp_order)
    else:
        ctx["invoice_order_ref"] = f"#{db_order.get('order_number')}"
        ctx["invoice_currency"] = "PKR"
        ilen = len(db_order.get("items") or [])
        ctx["invoice_pieces"] = ilen if ilen > 0 else 1
        ctx["invoice_destination"] = (db_order.get("destination") or "").strip() or "-"
        ctx["invoice_origin"] = (db_order.get("origin") or "").strip() or default_origin
        ctx["invoice_return_city"] = (db_order.get("return_city") or "").strip() or default_origin
        ctx["invoice_remarks"] = (db_order.get("remarks") or "").strip() or "THIS ORDER IS 100% CONFIRMED"
        ctx["invoice_line_items"] = _line_items_from_db_items(db_order)

    if not ctx.get("invoice_line_items"):
        ctx["invoice_line_items"] = _line_items_from_db_items(db_order)

    return ctx


def _shopify_order_matches_db_order(db_order_number: str, o: dict) -> bool:
    """True if Shopify order row corresponds to our DB order_number (e.g. 6563 or 5404-R)."""
    want = str(db_order_number).strip().lstrip("#")
    if not want:
        return False
    name = (o.get("name") or "").strip().lstrip("#")
    if name == want:
        return True
    onum = o.get("order_number")
    if onum is None:
        return False
    try:
        onum_str = str(int(onum))
    except (TypeError, ValueError):
        return False
    if onum_str == want:
        return True
    if want.upper().endswith("-R") and onum_str == want.split("-")[0].strip():
        return True
    return False


async def _fetch_shopify_order_by_order_number(order_number: str) -> Optional[dict]:
    """Fetch a single order from Shopify Admin REST API by order number (e.g. 6563 or 5404-R)."""
    store_url = settings.shopify_store_url
    token = settings.shopify_access_token
    if not store_url or not token:
        return None
    store_url = store_url.strip().rstrip("/")
    if store_url.startswith("http://"):
        store_url = store_url[7:]
    elif store_url.startswith("https://"):
        store_url = store_url[8:]
    num = str(order_number).strip().lstrip("#")
    if not num:
        return None
    base = f"https://{store_url}/admin/api/{settings.SHOPIFY_API_VERSION}/orders.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
    name_params = [num, f"#{num}"]
    async with httpx.AsyncClient(timeout=45.0) as client:
        for name_param in name_params:
            try:
                r = await client.get(
                    base,
                    headers=headers,
                    params={"status": "any", "name": name_param, "limit": 10},
                )
                if r.status_code != 200:
                    continue
                data = r.json()
                for o in data.get("orders") or []:
                    if _shopify_order_matches_db_order(order_number, o):
                        return o
            except Exception:
                continue
    return None


def _load_invoice_shipper_defaults() -> Dict[str, str]:
    """Load fixed shipper information from invoice.json if present."""
    invoice_json_path = Path(__file__).parent / "invoice.json"
    try:
        if invoice_json_path.exists():
            with open(invoice_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                shipper = (data.get("shipper_information") or {})
                return {
                    "name": shipper.get("name") or "Lushwear",
                    "contact": shipper.get("contact") or "03390153893",
                    "pickup_address": shipper.get("pickup_address") or "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
                    "return_address": shipper.get("return_address") or "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
                }
    except Exception:
        pass
    return {
        "name": "Lushwear",
        "contact": "03390153893",
        "pickup_address": "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
        "return_address": "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
    }


class _ScaleTableToSlot(Flowable):
    """Uniform scale so a table fits within max_width x max_height (keeps 3 invoices per page)."""

    def __init__(self, child: Table, max_width: float, max_height: float):
        Flowable.__init__(self)
        self.child = child
        self.max_width = max_width
        self.max_height = max_height
        self._scale = 1.0

    def wrap(self, availWidth, availHeight):
        aw = min(availWidth, self.max_width)
        ah = min(availHeight, self.max_height)
        w, h = self.child.wrap(aw, ah)
        if not w or not h:
            return 0, 0
        self._scale = min(1.0, aw / float(w), ah / float(h))
        return w * self._scale, h * self._scale

    def draw(self):
        self.canv.saveState()
        self.canv.scale(self._scale, self._scale)
        self.child.drawOn(self.canv, 0, 0)
        self.canv.restoreState()


def _generate_pdf_invoice(orders: List[dict]) -> BytesIO:
    """Generate a PDF with one invoice table per order. Shipper info is fixed; consignee/shipment/order from each order."""
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=15*mm, leftMargin=15*mm,
        topMargin=15*mm, bottomMargin=15*mm
    )
    elements = []
    styles = getSampleStyleSheet()
    header_style = ParagraphStyle(
        "InvoiceHeader", parent=styles["Normal"], fontSize=10, textColor=colors.black, fontName="Helvetica-Bold"
    )
    normal_style = ParagraphStyle(
        "InvoiceNormal", parent=styles["Normal"], fontSize=9, textColor=colors.black
    )
    bold_style = ParagraphStyle(
        "InvoiceBold", parent=styles["Normal"], fontSize=9, textColor=colors.black, fontName="Helvetica-Bold"
    )
    shipper = _load_invoice_shipper_defaults()
    inter_table_gap = 12 * mm
    tables_per_page = 3
    slot_height = (doc.height - (tables_per_page - 1) * inter_table_gap) / tables_per_page
    logo_height = 6 * mm
    logo_gap = 1.5 * mm
    table_slot_height = max(20 * mm, slot_height - logo_height - logo_gap)
    invoice_logo_path = Path(__file__).parent.parent / "logo_invoice.png"
    logo_width = None
    if invoice_logo_path.exists():
        try:
            iw, ih = ImageReader(str(invoice_logo_path)).getSize()
            if iw and ih:
                logo_width = logo_height * (float(iw) / float(ih))
        except Exception:
            logo_width = None

    def _cell_text(s: str) -> Paragraph:
        return Paragraph((s or "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), normal_style)

    def _cell_header(s: str) -> Paragraph:
        return Paragraph((s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), header_style)


    def _cell_bold(s: str) -> Paragraph:
        return Paragraph((s or "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), bold_style)

    for idx, order in enumerate(orders):
        if idx > 0 and idx % 3 == 0:
            elements.append(PageBreak())
        consignee_name = order.get("shipping_name") or order.get("consignee_name") or "-"
        consignee_contact = order.get("shipping_phone") or order.get("consignee_contact") or "-"
        consignee_address = order.get("shipping_address") or order.get("delivery_address") or "-"
        order_ref = order.get("invoice_order_ref") or f"#{order.get('order_number') or ''}"
        tracking = (order.get("tracking_number") or "-").strip() or "-"
        amount = float(order.get("total_amount") or 0)
        currency = (order.get("invoice_currency") or "PKR").strip()
        order_date_raw = order.get("order_receiving_date") or order.get("created_at")
        if order_date_raw:
            try:
                if isinstance(order_date_raw, str) and "T" in order_date_raw:
                    order_date = order_date_raw.split("T")[0][:10]
                else:
                    order_date = str(order_date_raw).strip()[:10]
            except Exception:
                order_date = str(order_date_raw)[:10] if order_date_raw else "-"
        else:
            order_date = "-"
        order_type = "Replacement" if order.get("replacement_of_order_no") else "Normal"
        pieces_val = order.get("invoice_pieces")
        if pieces_val is None:
            items_list = order.get("items") or []
            pieces_val = len(items_list) if items_list else 1
        pieces = str(pieces_val)
        origin = order.get("invoice_origin") or order.get("origin") or "-"
        destination = order.get("invoice_destination") or order.get("destination") or "-"
        return_city = order.get("invoice_return_city") or order.get("return_city") or "Karachi"
        remarks = "THIS ORDER IS 100% CONFIRMED"


        line_items = order.get("invoice_line_items") or []
        if line_items:
            details_parts = []
            for li in line_items:
                q = int(li.get("quantity") or 0)
                product = li.get("product") or "-"
                size = li.get("size") or ""
                part = f"{q} x {product}"
                if size:
                    part += f" - {size}"
                details_parts.append(part)
            order_details_str = ", ".join(details_parts)
        else:
            items_list = order.get("items") or []
            if items_list:
                details_parts = []
                for it in items_list:
                    q = int(it.get("quantity") or 1)
                    product = it.get("product_name") or it.get("name") or "-"
                    size = it.get("size") or ""
                    part = f"{q} x {product}"
                    if size:
                        part += f" - {size}"
                    details_parts.append(part)
                order_details_str = ", ".join(details_parts)
            else:
                order_details_str = "-"

        table_data = [
            [_cell_header("Consignee Information"), "", _cell_header("Shipment Information"), "", _cell_header("Order Information"), ""],
            [_cell_text("Name:"), _cell_bold(consignee_name), _cell_text("Pieces"), _cell_bold(pieces), _cell_text("Amount:"), _cell_bold(f"{amount:.2f}")],
            [_cell_text("Contact:"), _cell_bold(consignee_contact), _cell_text("Order Ref:"), _cell_bold(order_ref), _cell_text("Date:"), _cell_bold(order_date)],
            [_cell_text("Delivery Address:"), _cell_bold(consignee_address), _cell_text("Tracking No:"), _cell_bold(tracking), _cell_text("Order Type:"), _cell_bold(order_type)],
            [_cell_header("Shipper Information"), "", _cell_text("Origin"), _cell_bold(origin), _cell_text("Currency:"), _cell_bold(currency)],
            [_cell_text("Name:"), _cell_bold(shipper["name"]), _cell_text("Destination"), _cell_bold(destination), _cell_text("Remarks"), _cell_bold(remarks)],
            [_cell_text("Contact:"), _cell_bold(shipper["contact"]), _cell_text("Return City:"), _cell_bold(return_city), _cell_text(""), _cell_text("")],
            [_cell_text("Pickup Address:"), _cell_bold(shipper["pickup_address"]), _cell_text(""), _cell_text(""), _cell_header("Order Details:"), _cell_bold(order_details_str)],
            [_cell_text("Return Address:"), _cell_bold(shipper["return_address"]), _cell_text(""), _cell_text(""), _cell_text(""), _cell_text("")],
        ]
        col_widths = [20*mm, 60*mm, 20*mm, 20*mm, 20*mm, 40*mm]
        tbl = Table(table_data, colWidths=col_widths)
        tbl.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 2),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ("SPAN", (0, 0), (1, 0)),
            ("SPAN", (2, 0), (3, 0)),
            ("SPAN", (4, 0), (5, 0)),
            ("SPAN", (0, 4), (1, 4)),
            ("SPAN", (1, 7), (3, 7)),
            ("SPAN", (1, 8), (3, 8)),
            ("SPAN", (4, 5), (4, 6)),
            ("SPAN", (5, 5), (5, 6)),
            ("SPAN", (4, 7), (4, 8)),
            ("SPAN", (5, 7), (5, 8)),
            ("BACKGROUND", (0, 0), (1, 0), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (2, 0), (3, 0), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (4, 0), (5, 0), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (0, 4), (1, 4), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (4, 7), (4, 8), colors.HexColor("#E8E8E8")),
        ]))
        if logo_width:
            elements.append(Image(str(invoice_logo_path), width=logo_width, height=logo_height, hAlign="LEFT"))
            elements.append(Spacer(1, logo_gap))
        elements.append(_ScaleTableToSlot(tbl, doc.width, table_slot_height))
        if idx != len(orders) - 1 and idx % tables_per_page != tables_per_page - 1:
            elements.append(Spacer(1, inter_table_gap))
    if not elements:
        elements.append(Paragraph("No orders.", normal_style))
    doc.build(elements)
    buffer.seek(0)
    return buffer


@router.post("/generate-invoice")
async def generate_invoice(order_ids: List[str] = Body(..., embed=False)):
    """Generate a PDF invoice with one table per selected order."""
    try:
        if not order_ids:
            raise HTTPException(status_code=400, detail="No orders selected")
        supabase = get_supabase()
        orders_response = supabase.table("orders").select("*").in_("id", order_ids).execute()
        orders = orders_response.data or []
        if not orders:
            raise HTTPException(status_code=404, detail="No orders found")
        merged: List[dict] = []
        for o in orders:
            num = str(o.get("order_number") or "").strip()
            sp_order = None
            if num:
                try:
                    sp_order = await _fetch_shopify_order_by_order_number(num)
                except Exception:
                    sp_order = None
            merged.append(_build_invoice_order_context(o, sp_order))
        pdf_buffer = _generate_pdf_invoice(merged)
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=invoice.pdf"}
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating invoice: {str(e)}")


@router.post("/generate-load-sheet")
async def generate_load_sheet(order_ids: List[str]):
    """Generate a PDF load sheet from template for selected orders"""
    try:
        if not order_ids:
            raise HTTPException(status_code=400, detail="No orders selected")
        
        # Get orders from database
        supabase = get_supabase()
        orders_response = supabase.table("orders").select("*").in_("id", order_ids).execute()
        orders = orders_response.data
        
        if not orders:
            raise HTTPException(status_code=404, detail="No orders found")
        
        # Check if template exists (optional - for future use)
        template_path = None
        
        # Generate PDF
        pdf_buffer = _generate_pdf_load_sheet(orders, template_path)
        
        # Return PDF file as download
        return Response(
            content=pdf_buffer.getvalue(),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=load_sheet.pdf"}
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error generating PDF load sheet: {str(e)}")


@router.get("/month-summary/list")
async def get_month_summary_list():
    """Get list of all available months with order data"""
    try:
        supabase = get_supabase()
        page_size = 1000
        
        # Get all orders to determine which months have data (paginated)
        orders = []
        offset = 0
        while True:
            response = (
                supabase.table("orders")
                .select("order_receiving_date, created_at")
                .range(offset, offset + page_size - 1)
                .execute()
            )
            orders.extend(response.data)
            if len(response.data) < page_size:
                break
            offset += page_size
        
        # Extract unique months from orders
        months_set = set()
        for order in orders:
            # Use order_receiving_date if available, otherwise created_at
            date_str = order.get("order_receiving_date") or order.get("created_at")
            if date_str:
                try:
                    # Parse ISO date string
                    dt = datetime.fromisoformat(date_str.replace('Z', '+00:00'))
                    # Convert to PKT for period calculation
                    if dt.tzinfo:
                        dt_pkt = dt.astimezone(PKT_TIMEZONE)
                    else:
                        dt_pkt = dt.replace(tzinfo=timezone.utc).astimezone(PKT_TIMEZONE)
                    
                    # Determine which period this order belongs to
                    # Period is month's 22 to next month's 21
                    day = dt_pkt.day
                    month = dt_pkt.month
                    year = dt_pkt.year
                    
                    # If day < 22, it belongs to previous month's period
                    if day < 22:
                        if month == 1:
                            period_month = 12
                            period_year = year - 1
                        else:
                            period_month = month - 1
                            period_year = year
                    else:
                        period_month = month
                        period_year = year
                    
                    months_set.add((period_month, period_year))
                except Exception:
                    continue
        
        # Convert to list and sort (newest first)
        months_list = sorted(months_set, key=lambda x: (x[1], x[0]), reverse=True)
        
        return [{"month": m, "year": y} for m, y in months_list]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/month-summary/{month}/{year}")
async def get_month_summary_detail(month: int, year: int):
    """Get detailed summary for a specific month period"""
    try:
        if month < 1 or month > 12:
            raise HTTPException(status_code=400, detail="Invalid month")
        if year < 2000 or year > 2100:
            raise HTTPException(status_code=400, detail="Invalid year")
        
        # Get period start and end dates
        start_iso, end_iso = _period_start_end(month, year)
        
        supabase = get_supabase()
        page_size = 1000
        
        # Get orders for this period (paginated to handle >1000 orders)
        # Orders with order_receiving_date in range
        r1_data = []
        offset = 0
        while True:
            response = (
                supabase.table("orders")
                .select("*")
                .gte("order_receiving_date", start_iso)
                .lt("order_receiving_date", end_iso)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            r1_data.extend(response.data)
            if len(response.data) < page_size:
                break
            offset += page_size
        
        # Orders with null order_receiving_date but created_at in range
        r2_data = []
        offset = 0
        while True:
            response = (
                supabase.table("orders")
                .select("*")
                .is_("order_receiving_date", "null")
                .gte("created_at", start_iso)
                .lt("created_at", end_iso)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            r2_data.extend(response.data)
            if len(response.data) < page_size:
                break
            offset += page_size
        
        # Merge results, avoiding duplicates
        seen_ids = {o["id"] for o in r1_data}
        merged = list(r1_data)
        for o in r2_data:
            if o["id"] not in seen_ids:
                merged.append(o)
                seen_ids.add(o["id"])
        
        orders = merged
        
        # Exclude cancelled orders from totals and gross sale
        non_cancelled = [o for o in orders if (o.get("order_status") or "").strip().lower() != "cancelled"]
        
        # Calculate statistics (cancelled not counted in total orders or gross sale)
        total_orders = len(non_cancelled)
        total_gross_sale = sum(float(o.get("total_amount", 0) or 0) for o in non_cancelled)
        
        # Count orders by status (from non_cancelled)
        delivered_count = sum(1 for o in non_cancelled if o.get("order_status", "").lower() == "delivered")
        returned_count = sum(1 for o in non_cancelled if o.get("order_status", "").lower() == "returned")
        # Pending = order_status fulfilled/CNA/RFD/ICA
        enroute_count = sum(1 for o in non_cancelled if o.get("order_status", "").lower() in ("fulfilled", "cna", "rfd", "ica"))
        unfulfilled_count = sum(1 for o in non_cancelled if o.get("order_status", "").lower() == "unfulfilled")
        
        # Calculate return amount (sum of total_amount for returned orders)
        return_orders = [o for o in non_cancelled if o.get("order_status", "").lower() == "returned"]
        total_return_amount = sum(float(o.get("total_amount", 0) or 0) for o in return_orders)
        
        # Net sales = gross sales - return sales
        net_sales = total_gross_sale - total_return_amount

        # Net profit only for orders that have delivery_charge set (sum of their net sales minus cost)
        orders_with_delivery_set = [o for o in non_cancelled if o.get("delivery_charge") is not None]
        gross_with_delivery = sum(float(o.get("total_amount", 0) or 0) for o in orders_with_delivery_set)
        return_amount_with_delivery = sum(
            float(o.get("total_amount", 0) or 0) for o in orders_with_delivery_set
            if o.get("order_status", "").lower() == "returned"
        )
        cost_with_delivery = sum(float(o.get("cost_price", 0) or 0) for o in orders_with_delivery_set)
        net_profit = (gross_with_delivery - return_amount_with_delivery) - cost_with_delivery

        # DC charges: sum delivery_charge for all delivered and all returned orders (include even if delivery_charge is null/0)
        dc_charges_delivered = sum(
            float(o.get("delivery_charge") or 0) for o in non_cancelled
            if (o.get("order_status") or "").strip().lower() == "delivered"
        )
        dc_charges_returned = sum(
            float(o.get("delivery_charge") or 0) for o in non_cancelled
            if (o.get("order_status") or "").strip().lower() == "returned"
        )
        dc_charges_total = dc_charges_delivered + dc_charges_returned

        # Products sold by collection (5 collections + Others for products without a collection)
        KNOWN_COLLECTIONS = ["Cami Sets", "Linen PJs", "Pajama T-Shirt", "Silk Collection", "Trousers"]
        products_resp = supabase.table("products").select("name, collection, price").execute()
        products_list = []  # (name_lower, collection_display, price)
        products_map = {}   # name_lower -> (collection_display, price)
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
            for item_name in (order.get("items") or []):
                coll, price = resolve_item_to_collection_and_price(item_name)
                products_agg[coll]["count"] += 1
                products_agg[coll]["sum"] += price
        products_sold_by_collection = [
            {"collection": c, "count": products_agg[c]["count"], "sum": round(products_agg[c]["sum"], 2)}
            for c in KNOWN_COLLECTIONS + ["Others"]
        ]

        # Ledger totals for this period (from cashbook entries)
        start_date, end_date = _period_start_end_dates(month, year)
        shopify_expense = 0.0
        ad_expense = 0.0
        other_expense = 0.0
        ledgers_resp = supabase.table("ledgers").select("id, name, section").execute()
        for ledger in ledgers_resp.data or []:
            name = (ledger.get("name") or "").lower()
            section = (ledger.get("section") or "").lower()
            is_expense_section = "expense" in section
            if "shopify" in name:
                entries_resp = (
                    supabase.table("cashbook_entries")
                    .select("entry_type, amount")
                    .eq("folio", ledger["id"])
                    .gte("entry_date", start_date)
                    .lte("entry_date", end_date)
                    .execute()
                )
                for e in entries_resp.data or []:
                    if (e.get("entry_type") or "").strip().lower() == "outflow":
                        shopify_expense += float(e.get("amount") or 0)
            elif "ad" in name:
                entries_resp = (
                    supabase.table("cashbook_entries")
                    .select("entry_type, amount")
                    .eq("folio", ledger["id"])
                    .gte("entry_date", start_date)
                    .lte("entry_date", end_date)
                    .execute()
                )
                for e in entries_resp.data or []:
                    if (e.get("entry_type") or "").strip().lower() == "outflow":
                        ad_expense += float(e.get("amount") or 0)
            elif is_expense_section:
                # Other expenses: Expense section ledgers excluding shopify and ad
                entries_resp = (
                    supabase.table("cashbook_entries")
                    .select("entry_type, amount")
                    .eq("folio", ledger["id"])
                    .gte("entry_date", start_date)
                    .lte("entry_date", end_date)
                    .execute()
                )
                for e in entries_resp.data or []:
                    if (e.get("entry_type") or "").strip().lower() == "outflow":
                        other_expense += float(e.get("amount") or 0)

        return {
            "month": month,
            "year": year,
            "total_orders": total_orders,
            "total_gross_sale": round(total_gross_sale, 2),
            "total_return_amount": round(total_return_amount, 2),
            "return_orders_count": len(return_orders),
            "delivered_orders_count": delivered_count,
            "enroute_orders_count": enroute_count,
            "unfulfilled_orders_count": unfulfilled_count,
            "net_sales": round(net_sales, 2),
            "net_profit": round(net_profit, 2),
            "dc_charges_delivered": round(dc_charges_delivered, 2),
            "dc_charges_returned": round(dc_charges_returned, 2),
            "dc_charges_total": round(dc_charges_total, 2),
            "products_sold_by_collection": products_sold_by_collection,
            "shopify_expense": round(shopify_expense, 2),
            "ad_expense": round(ad_expense, 2),
            "other_expense": round(other_expense, 2),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


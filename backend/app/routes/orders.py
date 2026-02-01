from fastapi import APIRouter, HTTPException, UploadFile, File, Query
from typing import List, Dict, Any
from app.models import Order, OrderCreate, OrderUpdate
from app.database import get_supabase
from app.config import settings
from datetime import datetime
import httpx
import re
import csv
import io
from urllib.parse import unquote, urlparse, parse_qs
from bs4 import BeautifulSoup

router = APIRouter(prefix="/orders", tags=["orders"])

@router.get("/", response_model=List[dict])
async def get_all_orders():
    """Get all orders"""
    try:
        supabase = get_supabase()
        response = supabase.table("orders").select("*").order("order_number", desc=True).execute()
        return response.data
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
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            while True:
                if page_info:
                    api_url = f"{base_url}?page_info={page_info}"
                else:
                    api_url = f"{base_url}?status=any&limit=250"
                
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
        while True:
            existing_orders_response = supabase.table("orders").select("*").range(offset, offset + limit - 1).execute()
            if not existing_orders_response.data:
                break
            existing_orders_all.extend(existing_orders_response.data)
            if len(existing_orders_response.data) < limit:
                break
            offset += limit
        
        for o in existing_orders_all:
            order_num = o.get("order_number")
            if order_num is not None:
                try:
                    existing_orders_map[int(order_num)] = o
                except (ValueError, TypeError):
                    continue
        
        def extract_courier(order):
            if "fulfillments" in order and len(order["fulfillments"]) > 0:
                tracking_company = order["fulfillments"][0].get("tracking_company")
                if tracking_company:
                    tracking_company = str(tracking_company).strip()
                    if tracking_company:
                        return tracking_company
            return "Unassigned"
        
        def extract_tracking_number(order):
            if "fulfillments" in order and len(order["fulfillments"]) > 0:
                tracking_number = order["fulfillments"][0].get("tracking_number")
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
            return "pending"
        
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
            if "line_items" not in order or not order["line_items"]:
                return []
            item_names = []
            for item in order["line_items"]:
                name = item.get("name", "")
                if name:
                    item_names.append(name)
            return item_names
        
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
                fields_to_compare = ["order_status", "piece_with", "advance_amount"]
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
        current_time = datetime.utcnow().isoformat()
        
        for sp_order in all_orders:
            order_number = sp_order.get("order_number")
            if not order_number:
                continue
            
            order_number = int(order_number)
            
            courier = extract_courier(sp_order)
            tracking_number = extract_tracking_number(sp_order)
            order_status = extract_order_status(sp_order)
            # Use current_total_price (reflects edits/refunds; avoids double-counting when e.g. shipping is updated)
            total_amount = float(sp_order.get("current_total_price") or sp_order.get("total_price") or 0)
            advance_amount = extract_advance_amount(sp_order) or 0.0
            # Delivery charge is not filled from Shopify; add manually in the app
            delivery_charge = 0.0
            tax_amount = extract_tax_amount(sp_order) or 0.0
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
            
            order_data = {
                "order_number": order_number,
                "courier": courier,
                "tracking_number": tracking_number,
                "order_status": order_status,
                "piece_with": _piece_with_from_status(order_status),
                "total_amount": total_amount,
                "advance_amount": advance_amount,
                "delivery_charge": delivery_charge,
                "tax_amount": tax_amount,
                "cost_price": cost_price,
                "order_receiving_date": order_received_date,
                "items": items,
                "updated_at": current_time
            }
            
            if order_number in existing_orders_map:
                existing_order = existing_orders_map[order_number]
                # Preserve advance_amount if it has been set to a non-zero value
                try:
                    existing_adv = float(existing_order.get("advance_amount") or 0)
                except (TypeError, ValueError):
                    existing_adv = 0
                if existing_adv != 0:
                    order_data["advance_amount"] = existing_order.get("advance_amount")
                # Preserve delivery_charge (filled manually, not from Shopify)
                order_data["delivery_charge"] = existing_order.get("delivery_charge", 0)
                # Preserve last fetched delivery status (from courier tracking)
                order_data["delivery_status"] = existing_order.get("delivery_status")

                existing_courier = (existing_order.get("courier") or "").strip()
                courier_is_assigned = bool(existing_courier and existing_courier.lower() != "unassigned")

                if courier_is_assigned:
                    # Keep existing values; do not overwrite from Shopify
                    order_data["courier"] = existing_order.get("courier")
                    order_data["tracking_number"] = existing_order.get("tracking_number")
                    order_data["total_amount"] = existing_order.get("total_amount")
                    order_data["delivery_charge"] = existing_order.get("delivery_charge")
                    order_data["tax_amount"] = existing_order.get("tax_amount")
                    order_data["cost_price"] = existing_order.get("cost_price")
                    order_data["items"] = existing_order.get("items")
                    skip_fields = True
                else:
                    skip_fields = False

                if has_changed(order_data, existing_order, skip_assigned_courier_fields=skip_fields):
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
    """Parse a CSV cell to float; return default if invalid."""
    if val is None or (isinstance(val, str) and val.strip() == ""):
        return default
    try:
        return float(str(val).strip().replace(",", ""))
    except (ValueError, TypeError):
        return default


@router.post("/upload-postex-csv")
async def upload_postex_csv(file: UploadFile = File(...)):
    """
    Upload a PostEx CSV file. Matches rows by TRACKING_NUMBER to orders and updates
    delivery_charge (from SHIPPING_CHARGES) and tax_amount (GST + WH_INCOME_TAX + WH_SALES_TAX).
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
        # Normalize header names (strip spaces)
        fieldnames = [f.strip() for f in reader.fieldnames]
        # Map possible column names to canonical keys
        col_map = {}
        for i, name in enumerate(fieldnames):
            key = name.strip()
            if "SHIPPING_CHARGES" in key.upper():
                col_map["shipping_charges"] = key
            elif "GST" in key.upper() and "TAX" not in key.upper():
                col_map["gst"] = key
            elif "WH_INCOME_TAX" in key.upper() or "INCOME_TAX" in key.upper():
                col_map["wh_income_tax"] = key
            elif "WH_SALES_TAX" in key.upper() or "SALES_TAX" in key.upper():
                col_map["wh_sales_tax"] = key
            elif "TRACKING_NUMBER" in key.upper():
                col_map["tracking_number"] = key
        if "tracking_number" not in col_map:
            raise HTTPException(status_code=400, detail="CSV must contain a TRACKING_NUMBER column.")
        if "shipping_charges" not in col_map:
            raise HTTPException(status_code=400, detail="CSV must contain SHIPPING_CHARGES column.")
        rows = []
        for row in reader:
            # Rebuild dict with stripped keys for lookup
            raw = {f.strip(): row.get(f, "") for f in reader.fieldnames}
            tracking = (raw.get(col_map["tracking_number"]) or "").strip()
            if not tracking:
                continue
            shipping = _parse_float(raw.get(col_map["shipping_charges"], 0))
            gst = _parse_float(raw.get(col_map.get("gst", ""), 0))
            income_tax = _parse_float(raw.get(col_map.get("wh_income_tax", ""), 0))
            sales_tax = _parse_float(raw.get(col_map.get("wh_sales_tax", ""), 0))
            tax_total = gst + income_tax + sales_tax
            rows.append({"tracking_number": tracking, "delivery_charge": shipping, "tax_amount": tax_total})
        if not rows:
            return {"updated": 0, "message": "No valid rows with TRACKING_NUMBER in CSV."}
        supabase = get_supabase()
        # Fetch all orders (we need to match by tracking_number)
        all_orders = []
        limit = 1000
        offset = 0
        while True:
            resp = supabase.table("orders").select("id, tracking_number").range(offset, offset + limit - 1).execute()
            if not resp.data:
                break
            all_orders.extend(resp.data)
            if len(resp.data) < limit:
                break
            offset += limit
        tracking_to_order = {}
        for o in all_orders:
            tn = (o.get("tracking_number") or "").strip()
            if tn:
                tracking_to_order[tn] = o
        updated_count = 0
        for r in rows:
            order = tracking_to_order.get(r["tracking_number"])
            if not order:
                continue
            update_data = {
                "delivery_charge": r["delivery_charge"],
                "tax_amount": r["tax_amount"],
                "updated_at": datetime.utcnow().isoformat(),
            }
            supabase.table("orders").update(update_data).eq("id", order["id"]).execute()
            updated_count += 1
        return {"updated": updated_count, "message": f"Updated delivery charges and tax for {updated_count} order(s)."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing CSV: {str(e)}")


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

def _piece_with_from_status(status: str) -> str:
    """Derive piece_with from order_status: fulfilled -> Customer, returned -> Rider, else Warehouse."""
    if status == "fulfilled":
        return "Customer"
    if status == "returned":
        return "Rider"
    return "Warehouse"


@router.post("/", response_model=dict)
async def create_order(order: OrderCreate):
    """Create a new order"""
    try:
        supabase = get_supabase()
        order_data = order.model_dump()
        order_data["piece_with"] = _piece_with_from_status(order_data.get("order_status", "") or "")
        order_data["created_at"] = datetime.utcnow().isoformat()
        order_data["updated_at"] = datetime.utcnow().isoformat()
        response = supabase.table("orders").insert(order_data).execute()
        return response.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/{order_id}")
async def update_order(order_id: str, order: OrderUpdate):
    """Update an existing order"""
    try:
        supabase = get_supabase()
        update_data = {k: v for k, v in order.model_dump().items() if v is not None}
        if "order_status" in update_data:
            update_data["piece_with"] = _piece_with_from_status(update_data["order_status"])
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
        
        if courier.upper() == "POSTEX":
            async with httpx.AsyncClient(timeout=30.0) as client:
                api_url = f"https://api.postex.pk/services/courier/api/guest/get-order/{tracking_number}"
                response = await client.get(api_url)
                response.raise_for_status()
                data = response.json()
                
                if data.get("statusCode") == "200" and "dist" in data:
                    dist = data["dist"]
                    status_history = dist.get("transactionStatusHistory", [])
                    
                    delivery_status_data = {
                        "courier": "PostEx",
                        "tracking_number": dist.get("trackingNumber", tracking_number),
                        "customer_name": dist.get("customerName", ""),
                        "order_pickup_date": dist.get("orderPickupDate", ""),
                        "status_history": [
                            {
                                "status": item.get("transactionStatusMessage", ""),
                                "status_code": item.get("transactionStatusMessageCode", ""),
                                "datetime": item.get("modifiedDatetime", "")
                            }
                            for item in status_history
                        ],
                        "latest_status": status_history[0].get("transactionStatusMessage", "") if status_history else "",
                        "fetched_at": datetime.utcnow().isoformat()
                    }
        
        elif courier.upper() == "SCS":
            async with httpx.AsyncClient(timeout=30.0) as client:
                api_url = f"https://portal.scscourier.com/track?code={tracking_number}"
                response = await client.get(api_url)
                response.raise_for_status()
                html_content = response.text

                try:
                    soup = BeautifulSoup(html_content, 'html.parser')

                    recipient_name = ""
                    recipient_contact = ""
                    tracking_id = tracking_number

                    def _safe_text(elem, default=""):
                        if elem is None or not hasattr(elem, "get_text"):
                            return default
                        try:
                            return elem.get_text(strip=True)
                        except Exception:
                            return default

                    detail_items = soup.find_all("div", class_="detail-item")
                    for item in detail_items:
                        strong = item.find("strong")
                        span = item.find("span")
                        if strong and span:
                            label = _safe_text(strong)
                            value = _safe_text(span)
                            if "Receipient Name" in label or "Recipient Name" in label:
                                recipient_name = value
                            elif "Receipient Contact" in label or "Recipient Contact" in label:
                                recipient_contact = value
                            elif "Tracking ID" in label:
                                tracking_id = value

                    status_history = []
                    timeline_items = soup.find_all("div", class_="timeline-item")
                    for item in timeline_items:
                        date_elem = item.find("div", class_="timeline-date")
                        status_elem = item.find("div", class_="status-text")
                        if date_elem and status_elem:
                            classes = getattr(item, "get", lambda k, d=None: d)("class", None) or []
                            if not isinstance(classes, list):
                                classes = [classes] if classes else []
                            is_active = "active" in classes
                            status_history.append({
                                "status": _safe_text(status_elem),
                                "datetime": _safe_text(date_elem),
                                "is_active": is_active
                            })

                    delivery_status_data = {
                        "courier": "SCS",
                        "tracking_number": tracking_id,
                        "recipient_name": recipient_name,
                        "recipient_contact": recipient_contact,
                        "status_history": status_history,
                        "latest_status": status_history[0].get("status", "") if status_history else "",
                        "fetched_at": datetime.utcnow().isoformat()
                    }
                except HTTPException:
                    raise
                except Exception as e:
                    raise HTTPException(
                        status_code=500,
                        detail=f"SCS delivery status error: {type(e).__name__}: {str(e)}"
                    )
        else:
            raise HTTPException(status_code=400, detail=f"Courier '{courier}' not supported for delivery status tracking")
        
        if not delivery_status_data:
            raise HTTPException(status_code=500, detail="Failed to fetch delivery status")

        if save:
            supabase.table("orders").update({
                "delivery_status": delivery_status_data,
                "updated_at": datetime.utcnow().isoformat()
            }).eq("id", order_id).execute()

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


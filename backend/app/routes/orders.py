from fastapi import APIRouter, HTTPException
from typing import List
from app.models import Order, OrderCreate, OrderUpdate
from app.database import get_supabase
from datetime import datetime
import re
from urllib.parse import unquote, urlparse, parse_qs

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
    """Fetch orders from Shopify API and update/insert them in Supabase"""
    try:
        from app.config import settings
        import httpx
        
        # Get Shopify configuration
        store_url = settings.shopify_store_url
        access_token = settings.shopify_access_token
        
        if not store_url or not access_token:
            raise HTTPException(status_code=400, detail="Shopify credentials not configured")
            
        # Clean store URL
        store_url = store_url.strip().rstrip('/')
        if store_url.startswith('http://'):
            store_url = store_url[7:]
        elif store_url.startswith('https://'):
            store_url = store_url[8:]
            
        # Build Shopify API URL - use limit=250 to get maximum per page
        base_url = f"https://{store_url}/admin/api/{settings.SHOPIFY_API_VERSION}/orders.json"
        
        # Fetch orders from Shopify with pagination
        headers = {
            "X-Shopify-Access-Token": access_token,
            "Content-Type": "application/json"
        }
        
        all_orders = []
        page_info = None
        page_count = 0
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            while True:
                # Build URL with pagination
                if page_info:
                    # Use cursor-based pagination - page_info already contains all query params
                    # Cannot include status or limit when using page_info
                    api_url = f"{base_url}?page_info={page_info}"
                else:
                    # First page - include status and limit
                    api_url = f"{base_url}?status=any&limit=250"
                
                response = await client.get(api_url, headers=headers)
                response.raise_for_status()
                shopify_data = response.json()
                
                if "orders" not in shopify_data:
                    raise HTTPException(status_code=500, detail="Invalid response from Shopify API")
                
                page_orders = shopify_data["orders"]
                if not page_orders:
                    break
                
                all_orders.extend(page_orders)
                page_count += 1
                
                # Check for next page using Link header (Shopify pagination)
                link_header = response.headers.get("Link", "")
                next_page_info = None
                
                if link_header:
                    # Parse Link header to find next page
                    # Format: <url>; rel="next" or <url>; rel="previous", <url>; rel="next"
                    # Look for the "next" relation link
                    next_link_match = re.search(r'<([^>]+)>;\s*rel=["\']next["\']', link_header, re.IGNORECASE)
                    if next_link_match:
                        url = next_link_match.group(1)
                        # Extract page_info from URL - try both parsed and direct regex
                        parsed_url = urlparse(url)
                        if parsed_url.query:
                            query_params = parse_qs(parsed_url.query, keep_blank_values=True)
                            if 'page_info' in query_params:
                                next_page_info = query_params['page_info'][0]
                            else:
                                # Fallback: direct regex extraction
                                page_info_match = re.search(r'[?&]page_info=([^&]+)', url)
                                if page_info_match:
                                    next_page_info = unquote(page_info_match.group(1))
                        else:
                            # No query string, try direct extraction from URL
                            page_info_match = re.search(r'page_info=([^&>]+)', url)
                            if page_info_match:
                                next_page_info = unquote(page_info_match.group(1))
                    
                    if next_page_info:
                        page_info = next_page_info
                        # Continue to next iteration
                        continue
                    else:
                        # No next page found in Link header - we're done
                        break
                else:
                    # No Link header means no more pages
                    break
                
                # If we got here and have less than 250 orders, we're on the last page
                if len(page_orders) < 250:
                    break
        
        shopify_orders = all_orders
        supabase = get_supabase()
        
        synced_count = 0
        created_count = 0
        updated_count = 0
        
        for sp_order in shopify_orders:
            order_number = sp_order.get("order_number")
            if not order_number:
                continue
                
            # Parse amounts
            total_price = float(sp_order.get("total_price", 0))
            
            # Extract shipping/delivery info
            shipping_lines = sp_order.get("shipping_lines", [])
            delivery_charge_val = 0
            if shipping_lines:
                delivery_charge_val = sum(float(line.get("price", 0)) for line in shipping_lines)
            
            # Map Status (simplify for now)
            financial_status = sp_order.get("financial_status", "pending")
            fulfillment_status = sp_order.get("fulfillment_status", "unfulfilled")
            
            status = "PENDING"
            if financial_status == "paid":
                status = "PAID"
            elif financial_status == "refunded":
                status = "RETURNED"
            
            if fulfillment_status == "fulfilled":
                status = "DELIVERED" # Override if fulfilled, simplistically
            
            # For courier, we might check shipping lines title, or custom fields. 
            # Fallback to 'Standard' or extract from note_attributes if available.
            courier = "Standard"
            if shipping_lines:
                courier = shipping_lines[0].get("title", "Standard")
                
            # Prepare Order Data
            order_data = {
                "order_number": order_number,
                "courier": courier,
                "total_amount": total_price,
                "status": status,
                "delivery_charge": delivery_charge_val,
                "folio": sp_order.get("name", ""), # Using name (e.g. #1001) as folio or ref
                "updated_at": datetime.utcnow().isoformat()
            }
            
            # Check if exists
            existing_response = supabase.table("orders").select("*").eq("order_number", order_number).execute()
            existing_order = existing_response.data[0] if existing_response.data and len(existing_response.data) > 0 else None
            
            if existing_order:
                # Check if update is needed by comparing fields
                should_update = False
                
                # Helper to compare values safely (handling float/Decimal differences)
                def values_differ(val1, val2):
                    if val1 is None and val2 is None: return False
                    if val1 is None or val2 is None: return True
                    try:
                        return float(val1) != float(val2)
                    except:
                        return str(val1) != str(val2)

                if (values_differ(existing_order.get("total_amount"), order_data["total_amount"]) or
                    existing_order.get("status") != order_data["status"] or
                    values_differ(existing_order.get("delivery_charge"), order_data["delivery_charge"]) or
                    existing_order.get("folio") != order_data["folio"] or
                    existing_order.get("courier") != order_data["courier"]):
                    should_update = True
                
                if should_update:
                    supabase.table("orders").update(order_data).eq("order_number", order_number).execute()
                    updated_count += 1
            else:
                # Insert
                order_data["created_at"] = datetime.utcnow().isoformat()
                supabase.table("orders").insert(order_data).execute()
                created_count += 1
                
            synced_count += 1
            
        return {
            "message": "Orders synced successfully",
            "synced": synced_count,
            "created": created_count,
            "updated": updated_count,
            "pages_fetched": page_count,
            "total_orders_from_shopify": len(shopify_orders),
            "orders_per_page": 250 if len(shopify_orders) > 0 else 0
        }
        
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=f"Shopify API error: {e.response.text}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error syncing orders: {str(e)}")


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

@router.post("/", response_model=dict)
async def create_order(order: OrderCreate):
    """Create a new order"""
    try:
        supabase = get_supabase()
        order_data = order.model_dump()
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
        update_data["updated_at"] = datetime.utcnow().isoformat()
        response = supabase.table("orders").update(update_data).eq("id", order_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Order not found")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{order_id}")
async def delete_order(order_id: str):
    """Delete an order"""
    try:
        supabase = get_supabase()
        response = supabase.table("orders").delete().eq("id", order_id).execute()
        return {"message": "Order deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


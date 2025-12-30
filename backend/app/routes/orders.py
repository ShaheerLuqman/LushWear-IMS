from fastapi import APIRouter, HTTPException
from typing import List
from app.models import Order, OrderCreate, OrderUpdate
from app.database import get_supabase
from datetime import datetime

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
            
        # Build Shopify API URL
        api_url = f"https://{store_url}/admin/api/{settings.SHOPIFY_API_VERSION}/orders.json?status=any"
        
        # Fetch orders from Shopify
        headers = {
            "X-Shopify-Access-Token": access_token,
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(api_url, headers=headers)
            response.raise_for_status()
            shopify_data = response.json()
            
        if "orders" not in shopify_data:
            raise HTTPException(status_code=500, detail="Invalid response from Shopify API")
            
        shopify_orders = shopify_data["orders"]
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
            existing = supabase.table("orders").select("id").eq("order_number", order_number).execute()
            
            if existing.data:
                # Update
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
            "updated": updated_count
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


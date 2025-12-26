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


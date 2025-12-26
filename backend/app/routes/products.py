from fastapi import APIRouter, HTTPException
from typing import List
from app.models import Product, ProductCreate, ProductUpdate, StockMovement
from app.database import get_supabase
from datetime import datetime

router = APIRouter(prefix="/products", tags=["products"])

@router.get("/", response_model=List[dict])
async def get_all_products():
    """Get all products from inventory"""
    try:
        supabase = get_supabase()
        response = supabase.table("products").select("*").order("created_at", desc=True).execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{product_id}")
async def get_product(product_id: str):
    """Get a single product by ID"""
    try:
        supabase = get_supabase()
        response = supabase.table("products").select("*").eq("id", product_id).single().execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Product not found")
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/", response_model=dict)
async def create_product(product: ProductCreate):
    """Create a new product"""
    try:
        supabase = get_supabase()
        product_data = product.model_dump()
        product_data["created_at"] = datetime.utcnow().isoformat()
        product_data["updated_at"] = datetime.utcnow().isoformat()
        response = supabase.table("products").insert(product_data).execute()
        return response.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/{product_id}")
async def update_product(product_id: str, product: ProductUpdate):
    """Update an existing product"""
    try:
        supabase = get_supabase()
        update_data = {k: v for k, v in product.model_dump().items() if v is not None}
        update_data["updated_at"] = datetime.utcnow().isoformat()
        response = supabase.table("products").update(update_data).eq("id", product_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Product not found")
        return response.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{product_id}")
async def delete_product(product_id: str):
    """Delete a product"""
    try:
        supabase = get_supabase()
        response = supabase.table("products").delete().eq("id", product_id).execute()
        return {"message": "Product deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/stock-movement")
async def record_stock_movement(movement: StockMovement):
    """Record a stock movement (in/out)"""
    try:
        supabase = get_supabase()
        
        # Get current product
        product_response = supabase.table("products").select("*").eq("id", movement.product_id).single().execute()
        if not product_response.data:
            raise HTTPException(status_code=404, detail="Product not found")
        
        current_quantity = product_response.data["quantity"]
        
        # Calculate new quantity
        if movement.movement_type == "in":
            new_quantity = current_quantity + movement.quantity_change
        elif movement.movement_type == "out":
            new_quantity = current_quantity - movement.quantity_change
            if new_quantity < 0:
                raise HTTPException(status_code=400, detail="Insufficient stock")
        else:
            raise HTTPException(status_code=400, detail="Invalid movement type")
        
        # Update product quantity
        supabase.table("products").update({
            "quantity": new_quantity,
            "updated_at": datetime.utcnow().isoformat()
        }).eq("id", movement.product_id).execute()
        
        # Record the movement
        movement_data = {
            "product_id": movement.product_id,
            "quantity_change": movement.quantity_change,
            "movement_type": movement.movement_type,
            "notes": movement.notes,
            "created_at": datetime.utcnow().isoformat()
        }
        supabase.table("stock_movements").insert(movement_data).execute()
        
        return {"message": "Stock movement recorded", "new_quantity": new_quantity}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/search/{query}")
async def search_products(query: str):
    """Search products by name or SKU"""
    try:
        supabase = get_supabase()
        response = supabase.table("products").select("*").or_(
            f"name.ilike.%{query}%,sku.ilike.%{query}%"
        ).execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


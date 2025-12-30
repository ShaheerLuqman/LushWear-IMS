from fastapi import APIRouter, HTTPException
from typing import List
from app.models import Product, ProductCreate, ProductUpdate
from app.database import get_supabase
from app.config import settings
from datetime import datetime
import httpx
import re

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

@router.post("/sync-shopify")
async def sync_shopify_products():
    """Fetch products from Shopify API and update/insert them in Supabase"""
    try:
        # Get Shopify configuration
        store_url = settings.shopify_store_url
        access_token = settings.shopify_access_token
        
        # Validate Shopify configuration
        if not store_url or not access_token:
            raise HTTPException(
                status_code=400, 
                detail="Shopify credentials not configured. Please set SHOPIFY_STORE_URL (or SHOPIFY_API_KEY) and SHOPIFY_ADMIN_API_TOKEN environment variables."
            )
        
        # Clean store URL (remove https:// and trailing slash)
        store_url = store_url.strip().rstrip('/')
        if store_url.startswith('http://'):
            store_url = store_url[7:]
        elif store_url.startswith('https://'):
            store_url = store_url[8:]
        
        # Build Shopify API URL
        api_url = f"https://{store_url}/admin/api/{settings.SHOPIFY_API_VERSION}/products.json"
        
        # Fetch products from Shopify
        headers = {
            "X-Shopify-Access-Token": access_token,
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(api_url, headers=headers)
            if response.status_code == 404:
                # Provide more helpful error message
                error_detail = f"Shopify API endpoint not found. Please verify:\n"
                error_detail += f"1. Store URL is correct: {store_url}\n"
                error_detail += f"2. API version is valid: {settings.SHOPIFY_API_VERSION}\n"
                error_detail += f"3. Access token has correct permissions\n"
                error_detail += f"4. Full URL attempted: {api_url}\n"
                error_detail += f"Response: {response.text}"
                raise HTTPException(status_code=404, detail=error_detail)
            response.raise_for_status()
            shopify_data = response.json()
        
        if "products" not in shopify_data:
            raise HTTPException(status_code=500, detail="Invalid response from Shopify API")
        
        shopify_products = shopify_data["products"]
        supabase = get_supabase()
        
        # Get existing products by shopify_product_id and shopify_variant_id for matching
        existing_products_response = supabase.table("products").select("id, shopify_product_id, shopify_variant_id").execute()
        existing_products = {}
        for p in existing_products_response.data:
            if p.get("shopify_product_id") and p.get("shopify_variant_id"):
                key = (p["shopify_product_id"], p["shopify_variant_id"])
                existing_products[key] = p["id"]
        
        synced_count = 0
        created_count = 0
        updated_count = 0
        
        # Helper function to parse Shopify timestamp
        def parse_shopify_timestamp(ts_str):
            if not ts_str:
                return None
            try:
                # Shopify timestamps are in ISO format
                return datetime.fromisoformat(ts_str.replace('Z', '+00:00')).isoformat()
            except:
                return None
        
        # Process each Shopify product
        for shopify_product in shopify_products:
            shopify_product_id = shopify_product.get("id")
            if not shopify_product_id:
                continue
            
            # Get product-level data
            name = shopify_product.get("title", "Untitled Product")
            handle = shopify_product.get("handle")
            vendor = shopify_product.get("vendor")
            product_type = shopify_product.get("product_type")
            status = shopify_product.get("status", "active")
            tags = shopify_product.get("tags")
            if tags:
                tags = tags if isinstance(tags, str) else ", ".join(tags) if isinstance(tags, list) else str(tags)
            
            # Get first image URL
            images = shopify_product.get("images", [])
            image_url = images[0].get("src") if images and len(images) > 0 else None
            
            # Get description (strip HTML)
            description = shopify_product.get("body_html", "") or None
            if description:
                description = re.sub(r'<[^>]+>', '', description).strip()
                if not description:
                    description = None
            
            # Parse Shopify timestamps
            shopify_created_at = parse_shopify_timestamp(shopify_product.get("created_at"))
            shopify_updated_at = parse_shopify_timestamp(shopify_product.get("updated_at"))
            
            # Process variants (create/update a product for each variant)
            variants = shopify_product.get("variants", [])
            if not variants:
                # If no variants, create a single product entry
                variants = [{}]
            
            for variant in variants:
                shopify_variant_id = variant.get("id")
                if not shopify_variant_id:
                    continue
                
                # Get variant-specific data
                variant_title = variant.get("title", "")
                sku = variant.get("sku") or None
                price = float(variant.get("price", 0) or 0)
                compare_at_price = variant.get("compare_at_price")
                if compare_at_price:
                    compare_at_price = float(compare_at_price)
                quantity = int(variant.get("inventory_quantity", 0) or 0)
                barcode = variant.get("barcode") or None
                weight = variant.get("weight")
                if weight:
                    weight = float(weight)
                weight_unit = variant.get("weight_unit", "kg")
                
                # Build product name (include variant title if different from product title)
                product_name = name
                if variant_title and variant_title != "Default Title":
                    product_name = f"{name} - {variant_title}"
                
                # Prepare product data
                product_data = {
                    "name": product_name,
                    "sku": sku,
                    "price": price,
                    "compare_at_price": compare_at_price,
                    "quantity": quantity,
                    "category": product_type,
                    "description": description,
                    "shopify_product_id": shopify_product_id,
                    "shopify_variant_id": shopify_variant_id,
                    "handle": handle,
                    "vendor": vendor,
                    "status": status,
                    "tags": tags,
                    "image_url": image_url,
                    "barcode": barcode,
                    "weight": weight,
                    "weight_unit": weight_unit,
                    "shopify_created_at": shopify_created_at,
                    "shopify_updated_at": shopify_updated_at,
                    "updated_at": datetime.utcnow().isoformat()
                }
                
                # Check if product exists by shopify_product_id + shopify_variant_id
                product_key = (shopify_product_id, shopify_variant_id)
                if product_key in existing_products:
                    # Update existing product
                    product_id = existing_products[product_key]
                    supabase.table("products").update(product_data).eq("id", product_id).execute()
                    updated_count += 1
                else:
                    # Create new product
                    product_data["created_at"] = datetime.utcnow().isoformat()
                    supabase.table("products").insert(product_data).execute()
                    created_count += 1
                
                synced_count += 1
        
        return {
            "message": "Products synced successfully",
            "synced": synced_count,
            "created": created_count,
            "updated": updated_count
        }
        
    except HTTPException:
        # Re-raise HTTPExceptions (including our custom 404)
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
        raise HTTPException(
            status_code=500,
            detail=f"Failed to connect to Shopify: {str(e)}"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error syncing products: {str(e)}")

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


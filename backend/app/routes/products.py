from fastapi import APIRouter, HTTPException
from typing import List
from app.models import Product, ProductCreate, ProductUpdate
from app.database import get_supabase
from app.config import settings
from datetime import datetime
import httpx
import re
from urllib.parse import unquote, urlparse, parse_qs

router = APIRouter(prefix="/products", tags=["products"])

@router.get("/", response_model=List[dict])
async def get_all_products():
    try:
        supabase = get_supabase()
        response = supabase.table("products").select("*").order("created_at", desc=True).execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sync-shopify")
async def sync_shopify_products():
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
        
        base_url = f"https://{store_url}/admin/api/{settings.SHOPIFY_API_VERSION}/products.json"
        headers = {
            "X-Shopify-Access-Token": access_token,
            "Content-Type": "application/json"
        }
        
        all_products = []
        page_info = None
        page_count = 0
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            while True:
                if page_info:
                    api_url = f"{base_url}?page_info={page_info}"
                else:
                    api_url = f"{base_url}?limit=250"
                
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
                
                if "products" not in shopify_data:
                    raise HTTPException(status_code=500, detail="Invalid response from Shopify API")
                
                page_products = shopify_data["products"]
                if not page_products:
                    break
                
                all_products.extend(page_products)
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
                
                if len(page_products) < 250:
                    break
        
        supabase = get_supabase()
        existing_products_response = supabase.table("products").select("*").execute()
        existing_products_map = {}
        for p in existing_products_response.data:
            if p.get("shopify_product_id") and p.get("shopify_variant_id"):
                key = (p["shopify_product_id"], p["shopify_variant_id"])
                existing_products_map[key] = p
        
        def normalize_value(val):
            if val is None:
                return None
            if isinstance(val, (int, float)):
                return round(float(val), 2)
            return str(val).strip() if val else None
        
        def has_changed(shopify_data, existing_data):
            fields_to_compare = ["name", "price", "quantity", "image_url"]
            for field in fields_to_compare:
                shopify_val = normalize_value(shopify_data.get(field))
                existing_val = normalize_value(existing_data.get(field))
                if field in ["price", "quantity"]:
                    shopify_num = float(shopify_val) if shopify_val is not None else 0.0
                    existing_num = float(existing_val) if existing_val is not None else 0.0
                    if abs(shopify_num - existing_num) > 0.01:
                        return True
                else:
                    if shopify_val != existing_val:
                        return True
            return False
        
        products_to_insert = []
        products_to_update = []
        current_time = datetime.utcnow().isoformat()
        
        for shopify_product in all_products:
            shopify_product_id = shopify_product.get("id")
            if not shopify_product_id:
                continue
            
            name = shopify_product.get("title", "Untitled Product")
            if shopify_product.get("status") != "active":
                continue
            
            images = shopify_product.get("images", [])
            image_url = images[0].get("src") if images and len(images) > 0 else None
            variants = shopify_product.get("variants", [])
            if not variants:
                variants = [{}]
            
            for variant in variants:
                shopify_variant_id = variant.get("id")
                if not shopify_variant_id:
                    continue
                
                variant_title = variant.get("title", "")
                price = float(variant.get("price", 0) or 0)
                quantity = int(variant.get("inventory_quantity", 0) or 0)
                product_name = name
                if variant_title and variant_title != "Default Title":
                    product_name = f"{name} - {variant_title}"
                
                product_key = (shopify_product_id, shopify_variant_id)
                product_data = {
                    "name": product_name,
                    "price": price,
                    "cost_price": None,
                    "quantity": quantity,
                    "image_url": image_url,
                    "shopify_product_id": shopify_product_id,
                    "shopify_variant_id": shopify_variant_id,
                    "updated_at": current_time
                }
                
                if product_key in existing_products_map:
                    existing_product = existing_products_map[product_key]
                    if has_changed(product_data, existing_product):
                        product_data["id"] = existing_product["id"]
                        products_to_update.append(product_data)
                else:
                    product_data["created_at"] = current_time
                    products_to_insert.append(product_data)
        
        created_count = 0
        if products_to_insert:
            batch_size = 1000
            for i in range(0, len(products_to_insert), batch_size):
                batch = products_to_insert[i:i + batch_size]
                supabase.table("products").insert(batch).execute()
                created_count += len(batch)
        
        updated_count = 0
        if products_to_update:
            batch_size = 1000
            for i in range(0, len(products_to_update), batch_size):
                batch = products_to_update[i:i + batch_size]
                supabase.table("products").upsert(batch, on_conflict="id").execute()
                updated_count += len(batch)
        
        synced_count = created_count + updated_count
        total_active_variants = 0
        for product in all_products:
            if product.get("status") == "active":
                variants = product.get("variants", [])
                if variants:
                    total_active_variants += sum(1 for v in variants if v.get("id"))
                else:
                    total_active_variants += 1
        
        skipped_count = total_active_variants - synced_count
        
        return {
            "message": "Products synced successfully",
            "synced": synced_count,
            "created": created_count,
            "updated": updated_count,
            "skipped": skipped_count,
            "pages_fetched": page_count,
            "total_products_from_shopify": len(all_products),
            "total_active_variants": total_active_variants,
            "products_per_page": 250 if len(all_products) > 0 else 0
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
        raise HTTPException(status_code=500, detail=f"Error syncing products: {str(e)}")

@router.get("/{product_id}")
async def get_product(product_id: str):
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
    try:
        supabase = get_supabase()
        response = supabase.table("products").delete().eq("id", product_id).execute()
        return {"message": "Product deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/search/{query}")
async def search_products(query: str):
    try:
        supabase = get_supabase()
        response = supabase.table("products").select("*").or_(
            f"name.ilike.%{query}%,sku.ilike.%{query}%"
        ).execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


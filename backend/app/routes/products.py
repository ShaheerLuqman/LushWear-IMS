from fastapi import APIRouter, Depends, HTTPException
from typing import List, Dict, Tuple
from app.models import (
    ProductCreate, ProductUpdate, ProductWithVariants,
    ProductBatchCostPriceUpdate, RecalculateOrderCostsByProductBody,
    Variant, VariantCreate, VariantUpdate,
)
from app.auth import get_org_id
from app.config import settings
from app.database import get_supabase
from app import shopify
from app.db_utils import fetch_all
from app.money import money
from app.org_scope import org_table
from app.org_settings import ensure_valid_shopify_token, get_org_integration_settings
from datetime import datetime, timezone
from supabase import create_client
import asyncio
import logging
import httpx

logger = logging.getLogger("app.products")
router = APIRouter(prefix="/products", tags=["products"])


async def _fetch_products_and_variants(org_id: str) -> Tuple[List[dict], List[dict]]:
    """Fetch the full products and variants tables concurrently, each on its own client
    (sharing one client's connection across concurrent threads crashes) and paginated via
    fetch_all so a catalog past PostgREST's 1000-row-per-request cap isn't silently
    truncated - unlikely today (139 products / 579 variants) but not guarded against."""
    def fetch_products():
        client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
        return fetch_all(lambda: org_table(client, org_id, "shopify_products").select("*"))

    def fetch_variants():
        client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
        return fetch_all(lambda: org_table(client, org_id, "shopify_variants").select("*"))

    return await asyncio.gather(asyncio.to_thread(fetch_products), asyncio.to_thread(fetch_variants))

# Product titles to skip when syncing from Shopify (exact match, case-sensitive)
SHOPIFY_SYNC_PRODUCTS_IGNORE: List[str] = [
    "Brides & Bridesmaids PJs",
    "Free SHIPPING",
]


def _resolve_collection(names: List[str]) -> str | None:
    """A product can sit in multiple Shopify collections; the collection column is a
    single value. Prefer whichever one the month-summary breakdown (shopify.KNOWN_COLLECTIONS)
    recognizes, else fall back to the first collection Shopify returns."""
    if not names:
        return None
    for name in names:
        if name in shopify.KNOWN_COLLECTIONS:
            return name
    return names[0]


def _is_replacement_order(row: dict) -> bool:
    """Same notion as Shopify sync: an order tagged as a replacement for another."""
    return bool(row.get("replacement_of_order_no"))


@router.get("/", response_model=List[ProductWithVariants])
async def get_all_products(org_id: str = Depends(get_org_id)):
    """Get all products with their variants"""
    try:
        supabase = get_supabase()
        # shopify_variants(*) is a PostgREST embed over the shopify_variants -> shopify_products
        # FK - one query does the join server-side instead of fetching both full
        # tables and grouping them into a dict here. Renamed back to `variants`
        # on the way out - that's this endpoint's own response shape, not the
        # embed's table name.
        products = fetch_all(lambda: org_table(supabase, org_id, "shopify_products").select("*, shopify_variants(*)").eq("is_active", True))

        for product in products:
            product_variants = product.pop("shopify_variants", None) or []
            product_variants.sort(key=lambda v: v.get("title", ""))
            product["variants"] = product_variants
            product["total_quantity"] = sum(v.get("quantity", 0) for v in product_variants)

        # Sort case-insensitively
        products.sort(key=lambda x: (x.get("name") or "").lower())
        return products
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/sync-shopify")
async def sync_shopify_products(org_id: str = Depends(get_org_id)):
    """Sync products and variants from Shopify"""
    try:
        org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
        # Shopify fetch and the local DB reads are independent - run them concurrently
        # instead of paying for both durations back to back.
        (all_products, page_count), (existing_products, existing_variants) = await asyncio.gather(
            shopify.fetch_all("products", f"limit={shopify.PAGE_LIMIT}", org_creds),
            _fetch_products_and_variants(org_id),
        )

        supabase = get_supabase()
        current_time = datetime.now(timezone.utc).isoformat()

        existing_products_map = {
            p["shopify_product_id"]: p for p in existing_products if p.get("shopify_product_id")
        }
        existing_variants_map = {
            v["shopify_variant_id"]: v for v in existing_variants if v.get("shopify_variant_id")
        }

        # Only ask Shopify for collection membership on products that'll actually be synced
        # and don't already have one stored - collects.json is a per-product call, so this
        # keeps steady-state syncs from re-fetching collection data for the whole catalog
        # every time.
        missing_collection_ids = [
            p["id"] for p in all_products
            if p.get("id")
            and p.get("status") == "active"
            and p.get("title", "Untitled Product") not in SHOPIFY_SYNC_PRODUCTS_IGNORE
            and not (existing_products_map.get(p["id"], {}).get("collection") or "").strip()
        ]
        product_collections = await shopify.fetch_product_collections(missing_collection_ids, org_creds)
        
        def normalize_value(val):
            if val is None:
                return None
            if isinstance(val, (int, float)):
                return round(float(val), 2)
            return str(val).strip() if val else None
        
        def product_has_changed(shopify_data, existing_data):
            fields_to_compare = ["name", "price", "image_url", "collection"]
            for field in fields_to_compare:
                shopify_val = normalize_value(shopify_data.get(field))
                existing_val = normalize_value(existing_data.get(field))
                if field == "price":
                    shopify_num = float(shopify_val) if shopify_val is not None else 0.0
                    existing_num = float(existing_val) if existing_val is not None else 0.0
                    if abs(shopify_num - existing_num) > 0.01:
                        return True
                else:
                    if shopify_val != existing_val:
                        return True
            return False
        
        def variant_has_changed(shopify_data, existing_data):
            fields_to_compare = ["title", "quantity"]
            for field in fields_to_compare:
                shopify_val = normalize_value(shopify_data.get(field))
                existing_val = normalize_value(existing_data.get(field))
                if field == "quantity":
                    shopify_num = int(shopify_val) if shopify_val is not None else 0
                    existing_num = int(existing_val) if existing_val is not None else 0
                    if shopify_num != existing_num:
                        return True
                else:
                    if shopify_val != existing_val:
                        return True
            return False
        
        products_to_insert = []
        products_to_update = []
        variants_to_insert = []
        variants_to_update = []
        
        # Track which products we'll have (for linking variants)
        # Maps shopify_product_id -> product_id (existing or to be created)
        product_id_map = {}
        # shopify_product_ids seen active in this sync - anything in existing_products_map
        # not in here gets deactivated below, instead of orphaned as an untracked DB row.
        synced_shopify_ids = set()

        for shopify_product in all_products:
            shopify_product_id = shopify_product.get("id")
            if not shopify_product_id:
                continue
            
            # Skip non-active products
            if shopify_product.get("status") != "active":
                continue
            
            name = shopify_product.get("title", "Untitled Product")
            if name in SHOPIFY_SYNC_PRODUCTS_IGNORE:
                continue
            synced_shopify_ids.add(shopify_product_id)

            images = shopify_product.get("images", [])
            image_url = images[0].get("src") if images and len(images) > 0 else None
            variants = shopify_product.get("variants", [])
            
            # Get price from first variant (prices are same across variants)
            price = 0.0
            if variants:
                price = float(variants[0].get("price", 0) or 0)
            
            existing_product = existing_products_map.get(shopify_product_id)
            existing_collection = (existing_product.get("collection") or "").strip() if existing_product else ""
            collection = existing_collection or _resolve_collection(product_collections.get(shopify_product_id, []))

            # Build product data
            product_data = {
                "name": name,
                "price": price,
                "image_url": image_url,
                "collection": collection,
                "shopify_product_id": shopify_product_id,
                "is_active": True,
                "updated_at": current_time
            }

            if existing_product:
                # Product exists, check if needs update. Also update on reactivation
                # (was previously deactivated below) even if nothing else changed.
                product_id_map[shopify_product_id] = existing_product["id"]
                if product_has_changed(product_data, existing_product) or not existing_product.get("is_active", True):
                    product_data["id"] = existing_product["id"]
                    # Preserve cost_price - it's set locally, Shopify has no notion of it
                    product_data["cost_price"] = existing_product.get("cost_price")
                    products_to_update.append(product_data)
            else:
                # New product, will need to insert and get ID
                product_data["created_at"] = current_time
                products_to_insert.append(product_data)
        
        # Insert new products and get their IDs
        created_products_count = 0
        if products_to_insert:
            batch_size = 1000
            for i in range(0, len(products_to_insert), batch_size):
                batch = products_to_insert[i:i + batch_size]
                result = org_table(supabase, org_id, "shopify_products").insert(batch).execute()
                created_products_count += len(batch)
                # Map shopify_product_id to new product id
                for product in result.data:
                    product_id_map[product["shopify_product_id"]] = product["id"]

        # Update existing products
        updated_products_count = 0
        if products_to_update:
            batch_size = 1000
            for i in range(0, len(products_to_update), batch_size):
                batch = products_to_update[i:i + batch_size]
                org_table(supabase, org_id, "shopify_products").upsert(batch, on_conflict="id").execute()
                updated_products_count += len(batch)

        # Deactivate DB products no longer active on Shopify (archived/removed there),
        # instead of leaving them as untracked rows the products list still shows.
        ids_to_deactivate = [
            p["id"] for p in existing_products
            if p.get("shopify_product_id") is not None
            and p.get("shopify_product_id") not in synced_shopify_ids
            and p.get("is_active", True)
        ]
        deactivated_products_count = 0
        if ids_to_deactivate:
            org_table(supabase, org_id, "shopify_products").update(
                {"is_active": False, "updated_at": current_time}
            ).in_("id", ids_to_deactivate).execute()
            deactivated_products_count = len(ids_to_deactivate)

        # Now process variants for all active products
        for shopify_product in all_products:
            shopify_product_id = shopify_product.get("id")
            if not shopify_product_id:
                continue
            
            if shopify_product.get("status") != "active":
                continue
            
            # Get the product_id (either existing or newly created)
            product_id = product_id_map.get(shopify_product_id)
            if not product_id:
                continue
            
            variants = shopify_product.get("variants", [])
            for variant in variants:
                shopify_variant_id = variant.get("id")
                if not shopify_variant_id:
                    continue
                
                variant_title = variant.get("title", "Default")
                quantity = int(variant.get("inventory_quantity", 0) or 0)
                
                variant_data = {
                    "product_id": product_id,
                    "title": variant_title,
                    "quantity": quantity,
                    "shopify_variant_id": shopify_variant_id,
                    "updated_at": current_time
                }
                
                if shopify_variant_id in existing_variants_map:
                    # Variant exists, check if needs update
                    existing_variant = existing_variants_map[shopify_variant_id]
                    if variant_has_changed(variant_data, existing_variant):
                        variant_data["id"] = existing_variant["id"]
                        variants_to_update.append(variant_data)
                else:
                    # New variant
                    variant_data["created_at"] = current_time
                    variants_to_insert.append(variant_data)
        
        # Insert new variants
        created_variants_count = 0
        if variants_to_insert:
            batch_size = 1000
            for i in range(0, len(variants_to_insert), batch_size):
                batch = variants_to_insert[i:i + batch_size]
                org_table(supabase, org_id, "shopify_variants").insert(batch).execute()
                created_variants_count += len(batch)

        # Update existing variants
        updated_variants_count = 0
        if variants_to_update:
            batch_size = 1000
            for i in range(0, len(variants_to_update), batch_size):
                batch = variants_to_update[i:i + batch_size]
                org_table(supabase, org_id, "shopify_variants").upsert(batch, on_conflict="id").execute()
                updated_variants_count += len(batch)
        
        # Calculate totals
        total_active_products = sum(1 for p in all_products if p.get("status") == "active")
        total_active_variants = 0
        for product in all_products:
            if product.get("status") == "active":
                variants = product.get("variants", [])
                if variants:
                    total_active_variants += sum(1 for v in variants if v.get("id"))
                else:
                    total_active_variants += 1
        
        return {
            "message": "Products synced successfully",
            "products": {
                "created": created_products_count,
                "updated": updated_products_count,
                "deactivated": deactivated_products_count,
                "total_from_shopify": total_active_products
            },
            "variants": {
                "created": created_variants_count,
                "updated": updated_variants_count,
                "total_from_shopify": total_active_variants
            },
            "pages_fetched": page_count,
            "total_products_from_shopify": len(all_products)
        }
        
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        error_text = e.response.text
        try:
            error_text = str(e.response.json())
        except ValueError:
            pass
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Shopify API error: {error_text}\nURL: {api_url if 'api_url' in locals() else 'N/A'}"
        )
    except httpx.RequestError:
        logger.exception("Shopify product sync: connection error")
        raise HTTPException(status_code=502, detail="Failed to connect to Shopify")
    except Exception:
        logger.exception("Shopify product sync failed")
        raise HTTPException(status_code=500, detail="Error syncing products")

@router.put("/batch-update-cost-prices")
async def batch_update_cost_prices(batch_update: ProductBatchCostPriceUpdate, org_id: str = Depends(get_org_id)):
    """Batch update cost prices for products"""
    try:
        supabase = get_supabase()
        current_time = datetime.now(timezone.utc).isoformat()

        cost_price_by_id = {update.id: update.cost_price for update in batch_update.updates}
        updated_count = 0
        if cost_price_by_id:
            # An upsert is INSERT ... ON CONFLICT, and Postgres checks NOT NULL on the
            # proposed row before it resolves the conflict, so name has to be carried even
            # though this only ever updates. Reading it back org-scoped also drops any id
            # belonging to another org - upsert, unlike update, has no WHERE to filter on.
            existing = (
                org_table(supabase, org_id, "shopify_products")
                .select("id, name")
                .in_("id", list(cost_price_by_id))
                .execute().data or []
            )
            payload = [
                {"id": p["id"], "name": p["name"], "cost_price": cost_price_by_id[p["id"]], "updated_at": current_time}
                for p in existing
            ]
            if payload:
                response = org_table(supabase, org_id, "shopify_products").upsert(payload, on_conflict="id").execute()
                updated_count = len(response.data or [])

        return {
            "message": f"Successfully updated {updated_count} product(s)",
            "updated_count": updated_count
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/recalculate-order-costs")
async def recalculate_order_costs_for_product(body: RecalculateOrderCostsByProductBody, org_id: str = Depends(get_org_id)):
    """Recompute order cost_price from product costs for orders that include the given product (line starts with \"Name - \")."""
    try:
        supabase = get_supabase()
        product_id = (body.product_id or "").strip()
        if not product_id:
            raise HTTPException(status_code=400, detail="product_id is required")

        prod = (
            org_table(supabase, org_id, "shopify_products").select("name").eq("id", product_id).limit(1).execute().data
        )
        if not prod:
            raise HTTPException(status_code=404, detail="Product not found")
        pname = (prod[0].get("name") or "").strip()
        if not pname:
            raise HTTPException(status_code=400, detail="Product has no name")

        # Cost lookup by product id (preferred) and by lowercased product name (fallback), both against line_items.
        costs: Dict[str, float] = {}
        costs_by_id: Dict[str, float] = {}
        for p in org_table(supabase, org_id, "shopify_products").select("id, name, cost_price").execute().data or []:
            try:
                cost_val = float(p.get("cost_price") or 0)
            except (TypeError, ValueError):
                cost_val = 0.0
            k = (p.get("name") or "").strip().lower()
            if k:
                costs[k] = cost_val
            if p.get("id"):
                costs_by_id[p["id"]] = cost_val

        after = body.created_after.isoformat()
        now_iso = datetime.now(timezone.utc).isoformat()
        page = 500
        select_cols = "id, order_number, order_status, replacement_of_order_no, line_items, cost_price"

        # Collect orders whose effective date is on/after the cutoff. The effective date
        # is order_receiving_date (the date shown in the orders grid), falling back to
        # created_at when the receiving date is null. Each query is ordered by the unique
        # order_number so OFFSET pagination stays stable: many orders can share the same
        # created_at down to the microsecond (bulk sync), and ordering by a non-unique
        # column previously let rows on a page boundary be silently skipped.
        order_rows: List[Dict] = []
        seen_ids = set()

        def _collect(query):
            for r in fetch_all(lambda: query().order("order_number"), page_size=page):
                if r["id"] not in seen_ids:
                    seen_ids.add(r["id"])
                    order_rows.append(r)

        # 1) order_receiving_date on/after cutoff
        _collect(lambda: org_table(supabase, org_id, "shopify_orders").select(select_cols).gte("order_receiving_date", after))
        # 2) order_receiving_date is null, fall back to created_at
        _collect(lambda: org_table(supabase, org_id, "shopify_orders").select(select_cols).is_("order_receiving_date", "null").gte("created_at", after))

        scanned = updated = 0
        updated_order_numbers: List[int] = []
        for row in order_rows:
            scanned += 1
            if (row.get("order_status") or "").strip().lower() == "cancelled":
                continue
            line_items = row.get("line_items") if isinstance(row.get("line_items"), list) else []

            # Does this order include the target product?
            includes_product = any(
                isinstance(li, dict) and (
                    li.get("product_id") == product_id
                    or (li.get("name") or "").strip().lower() == pname.lower()
                )
                for li in line_items
            )
            if not includes_product:
                continue

            if _is_replacement_order(row):
                new_cost = 0.0
            else:
                # Cost by product_id (else name) × qty.
                new_cost = 0.0
                for li in line_items:
                    if not isinstance(li, dict):
                        continue
                    try:
                        qty = int(li.get("qty") or 0)
                    except (TypeError, ValueError):
                        qty = 0
                    if qty <= 0:
                        continue
                    lid = li.get("product_id")
                    if lid and lid in costs_by_id:
                        new_cost += costs_by_id[lid] * qty
                    else:
                        base = (li.get("name") or "").strip().lower()
                        if base in costs:
                            new_cost += costs[base] * qty

            # Round the accumulated cost to cents so the comparison is exact and the
            # stored value can't carry float noise (e.g. 1522.1999999999998).
            new_cost = money(new_cost)
            old = money(row.get("cost_price"))
            if old == new_cost:
                continue
            org_table(supabase, org_id, "shopify_orders").update({"cost_price": new_cost, "updated_at": now_iso}).eq("id", row["id"]).execute()
            updated += 1
            num = row.get("order_number")
            if num is not None:
                updated_order_numbers.append(num)

        logger.info("[recalculate-order-costs] updated %d order(s): %s", updated, updated_order_numbers)

        return {
            "scanned": scanned,
            "updated": updated,
            "updated_order_numbers": updated_order_numbers,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{product_id}", response_model=ProductWithVariants)
async def get_product(product_id: str, org_id: str = Depends(get_org_id)):
    """Get a single product with its variants"""
    try:
        supabase = get_supabase()

        # Get product
        response = org_table(supabase, org_id, "shopify_products").select("*").eq("id", product_id).single().execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Product not found")

        product = response.data

        # Get variants for this product
        variants_response = org_table(supabase, org_id, "shopify_variants").select("*").eq("product_id", product_id).execute()
        product["variants"] = variants_response.data or []
        product["total_quantity"] = sum(v.get("quantity", 0) for v in product["variants"])
        
        return product
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/", response_model=ProductWithVariants)
async def create_product(product: ProductCreate, org_id: str = Depends(get_org_id)):
    """Create a new product with optional variants"""
    try:
        supabase = get_supabase()
        current_time = datetime.now(timezone.utc).isoformat()

        # Prepare product data (without variants)
        product_data = product.model_dump(exclude={"variants"})
        product_data["created_at"] = current_time
        product_data["updated_at"] = current_time

        # Insert product
        response = org_table(supabase, org_id, "shopify_products").insert(product_data).execute()
        created_product = response.data[0]
        product_id = created_product["id"]

        # Insert variants if provided
        created_variants = []
        if product.variants:
            variants_data = []
            for variant in product.variants:
                variant_dict = variant.model_dump()
                variant_dict["product_id"] = product_id
                variant_dict["created_at"] = current_time
                variant_dict["updated_at"] = current_time
                variants_data.append(variant_dict)

            if variants_data:
                variants_response = org_table(supabase, org_id, "shopify_variants").insert(variants_data).execute()
                created_variants = variants_response.data
        
        created_product["variants"] = created_variants
        created_product["total_quantity"] = sum(v.get("quantity", 0) for v in created_variants)
        
        return created_product
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.put("/{product_id}")
async def update_product(product_id: str, product: ProductUpdate, org_id: str = Depends(get_org_id)):
    """Update a product"""
    try:
        supabase = get_supabase()
        update_data = {k: v for k, v in product.model_dump().items() if v is not None}
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        response = org_table(supabase, org_id, "shopify_products").update(update_data).eq("id", product_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Product not found")

        # Return product with variants
        updated_product = response.data[0]
        variants_response = org_table(supabase, org_id, "shopify_variants").select("*").eq("product_id", product_id).execute()
        updated_product["variants"] = variants_response.data or []
        updated_product["total_quantity"] = sum(v.get("quantity", 0) for v in updated_product["variants"])
        
        return updated_product
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.delete("/{product_id}")
async def delete_product(product_id: str, org_id: str = Depends(get_org_id)):
    """Delete a product (variants are deleted automatically via CASCADE)"""
    try:
        supabase = get_supabase()
        response = org_table(supabase, org_id, "shopify_products").delete().eq("id", product_id).execute()
        return {"message": "Product deleted successfully"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/search/{query}")
async def search_products(query: str, org_id: str = Depends(get_org_id)):
    """Search products by name"""
    try:
        supabase = get_supabase()

        # Same embed as get_all_products - the join happens in Postgres, not here.
        response = (
            org_table(supabase, org_id, "shopify_products")
            .select("*, shopify_variants(*)")
            .ilike("name", f"%{query}%")
            .eq("is_active", True)
            .execute()
        )
        products = response.data

        if not products:
            return []

        for product in products:
            product["variants"] = product.pop("shopify_variants", None) or []
            product["total_quantity"] = sum(v.get("quantity", 0) for v in product["variants"])

        return products
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

# ==================== VARIANT ENDPOINTS ====================

@router.get("/{product_id}/variants", response_model=List[Variant])
async def get_product_variants(product_id: str, org_id: str = Depends(get_org_id)):
    """Get all variants for a product"""
    try:
        supabase = get_supabase()
        response = org_table(supabase, org_id, "shopify_variants").select("*").eq("product_id", product_id).order("title").execute()
        return response.data
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/{product_id}/variants", response_model=Variant)
async def create_variant(product_id: str, variant: VariantCreate, org_id: str = Depends(get_org_id)):
    """Create a new variant for a product"""
    try:
        supabase = get_supabase()
        current_time = datetime.now(timezone.utc).isoformat()

        # Verify product exists
        product_response = org_table(supabase, org_id, "shopify_products").select("id").eq("id", product_id).single().execute()
        if not product_response.data:
            raise HTTPException(status_code=404, detail="Product not found")

        variant_data = variant.model_dump()
        variant_data["product_id"] = product_id
        variant_data["created_at"] = current_time
        variant_data["updated_at"] = current_time

        response = org_table(supabase, org_id, "shopify_variants").insert(variant_data).execute()
        return response.data[0]
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.put("/{product_id}/variants/{variant_id}")
async def update_variant(product_id: str, variant_id: str, variant: VariantUpdate, org_id: str = Depends(get_org_id)):
    """Update a variant"""
    try:
        supabase = get_supabase()
        update_data = {k: v for k, v in variant.model_dump().items() if v is not None}
        update_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        response = org_table(supabase, org_id, "shopify_variants").update(update_data).eq("id", variant_id).eq("product_id", product_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Variant not found")

        return response.data[0]
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.delete("/{product_id}/variants/{variant_id}")
async def delete_variant(product_id: str, variant_id: str, org_id: str = Depends(get_org_id)):
    """Delete a variant"""
    try:
        supabase = get_supabase()
        response = org_table(supabase, org_id, "shopify_variants").delete().eq("id", variant_id).eq("product_id", product_id).execute()
        return {"message": "Variant deleted successfully"}
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")

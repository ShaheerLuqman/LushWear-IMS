"""Shopify -> DB product/variant sync: fetch, reconcile, and persist.

Extracted from routes/products.py's sync_shopify_products (the manual "Sync Shopify
Products" button's handler) so the same reconciliation rules are reachable from both that
batch entry point and the webhook-driven single-product/single-variant paths (products/create,
products/update, products/delete, inventory_levels/update - see
app/routes/shopify_webhooks.py). Same relationship as app/services/shopify_sync.py has with
_sync_shopify_orders/_reconcile_one_order.

Unlike orders, products carry no freeze-after-status rules - a product's fields simply mirror
whatever Shopify last reported, always. The one sticky field is `collection`: once set (by
name-matching or an admin's manual edit), it's never re-derived from Shopify - see
_resolve_collection.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException
from supabase import create_client

from app import shopify
from app.config import settings
from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table
from app.org_settings import ensure_valid_shopify_token, get_org_integration_settings

logger = logging.getLogger("app.products_sync")

# Product titles to skip when syncing from Shopify (exact match, case-sensitive)
SHOPIFY_SYNC_PRODUCTS_IGNORE: List[str] = [
    "Brides & Bridesmaids PJs",
    "Free SHIPPING",
]


def _resolve_collection(names: List[str]) -> Optional[str]:
    """A product can sit in multiple Shopify collections; the collection column is a
    single value. Prefer whichever one the month-summary breakdown (shopify.KNOWN_COLLECTIONS)
    recognizes, else fall back to the first collection Shopify returns."""
    if not names:
        return None
    for name in names:
        if name in shopify.KNOWN_COLLECTIONS:
            return name
    return names[0]


def _normalize_value(val):
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return round(float(val), 2)
    return str(val).strip() if val else None


def product_has_changed(shopify_data: dict, existing_data: dict) -> bool:
    fields_to_compare = ["name", "price", "image_url", "collection"]
    for field in fields_to_compare:
        shopify_val = _normalize_value(shopify_data.get(field))
        existing_val = _normalize_value(existing_data.get(field))
        if field == "price":
            shopify_num = float(shopify_val) if shopify_val is not None else 0.0
            existing_num = float(existing_val) if existing_val is not None else 0.0
            if abs(shopify_num - existing_num) > 0.01:
                return True
        else:
            if shopify_val != existing_val:
                return True
    return False


def variant_has_changed(shopify_data: dict, existing_data: dict) -> bool:
    # inventory_item_id is compared here too so it gets backfilled onto variants synced
    # before it was tracked, as soon as anything else about them changes (or immediately,
    # since existing_data won't have it yet and so will differ from Shopify's value).
    fields_to_compare = ["title", "quantity", "inventory_item_id"]
    for field in fields_to_compare:
        shopify_val = _normalize_value(shopify_data.get(field))
        existing_val = _normalize_value(existing_data.get(field))
        if field in ("quantity", "inventory_item_id"):
            shopify_num = int(shopify_val) if shopify_val is not None else 0
            existing_num = int(existing_val) if existing_val is not None else 0
            if shopify_num != existing_num:
                return True
        else:
            if shopify_val != existing_val:
                return True
    return False


@dataclass
class ProductReconciliation:
    """One Shopify product's reconciliation outcome against its existing DB row (None if
    never synced) - what sync_shopify_products' batch loop and
    reconcile_and_persist_single_product (the webhook path) both act on identically.
    `action` is "insert" | "update" | "deactivate" | "skip"."""
    action: str
    shopify_product_id: Any
    product_data: Optional[dict] = None


def reconcile_one_product(
    sp_product: dict,
    existing_product: Optional[dict],
    product_collections: Dict[Any, List[str]],
    current_time: str,
) -> Optional[ProductReconciliation]:
    """Reconcile one Shopify product against its existing DB row. Returns None if the
    product carries no id, is on the ignore list, or (having never been synced) isn't
    currently active - nothing to do in either case."""
    shopify_product_id = sp_product.get("id")
    if not shopify_product_id:
        return None

    name = sp_product.get("title", "Untitled Product")
    if name in SHOPIFY_SYNC_PRODUCTS_IGNORE:
        return None

    if sp_product.get("status") != "active":
        # Archived/removed on Shopify - deactivate a previously-synced row rather than
        # deleting it (existing orders reference products by our internal id).
        if existing_product and existing_product.get("is_active", True):
            return ProductReconciliation("deactivate", shopify_product_id, {
                "id": existing_product["id"], "is_active": False, "updated_at": current_time,
            })
        return None

    images = sp_product.get("images") or []
    image_url = images[0].get("src") if images else None
    variants = sp_product.get("variants") or []
    # Price comes from the first variant (prices are the same across a product's variants).
    price = float(variants[0].get("price", 0) or 0) if variants else 0.0

    existing_collection = (existing_product.get("collection") or "").strip() if existing_product else ""
    collection = existing_collection or _resolve_collection(product_collections.get(shopify_product_id, []))

    product_data = {
        "name": name,
        "price": price,
        "image_url": image_url,
        "collection": collection,
        "shopify_product_id": shopify_product_id,
        "is_active": True,
        "updated_at": current_time,
    }

    if existing_product:
        # Also update on reactivation (was previously deactivated) even if nothing else changed.
        if product_has_changed(product_data, existing_product) or not existing_product.get("is_active", True):
            product_data["id"] = existing_product["id"]
            # Preserve cost_price - it's set locally, Shopify has no notion of it.
            product_data["cost_price"] = existing_product.get("cost_price")
            return ProductReconciliation("update", shopify_product_id, product_data)
        return ProductReconciliation("skip", shopify_product_id)

    product_data["created_at"] = current_time
    return ProductReconciliation("insert", shopify_product_id, product_data)


async def reconcile_and_persist_single_product(org_id: str, sp_product: dict) -> Optional[ProductReconciliation]:
    """Reconcile and persist one Shopify product + its variants - the webhook-driven
    counterpart to sync_shopify_products' batch loop. Called for products/create and
    products/update; `sp_product` is that event's payload, the same REST-shaped product
    object shopify.fetch_all("products", ...) returns.

    Collection membership isn't in the webhook payload (same limitation as products.json -
    Shopify models it as a separate resource), so this only calls back into Shopify
    (fetch_product_collections, a single-product call) when the product is new or has no
    collection on file yet - same "missing_collection_ids" cost-saving as the batch sync.
    """
    shopify_product_id = sp_product.get("id")
    if not shopify_product_id:
        return None

    supabase = get_supabase()
    existing_rows = org_table(supabase, org_id, "shopify_products").select("*").eq(
        "shopify_product_id", shopify_product_id
    ).execute().data or []
    existing_product = existing_rows[0] if existing_rows else None
    current_time = datetime.now(timezone.utc).isoformat()

    product_collections: Dict[Any, List[str]] = {}
    if not existing_product or not (existing_product.get("collection") or "").strip():
        org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
        product_collections = await shopify.fetch_product_collections([shopify_product_id], org_creds)

    result = reconcile_one_product(sp_product, existing_product, product_collections, current_time)
    if result is None or result.action == "skip":
        return result

    if result.action == "deactivate":
        org_table(supabase, org_id, "shopify_products").update(
            {"is_active": False, "updated_at": current_time}
        ).eq("id", result.product_data["id"]).execute()
        return result

    upserted = org_table(supabase, org_id, "shopify_products").upsert(
        result.product_data, on_conflict="shopify_product_id"
    ).execute().data
    product_id = (upserted[0]["id"] if upserted else None) or (existing_product or {}).get("id")
    if not product_id:
        return result

    existing_variants = org_table(supabase, org_id, "shopify_variants").select("*").eq(
        "product_id", product_id
    ).execute().data or []
    existing_variants_map = {v["shopify_variant_id"]: v for v in existing_variants if v.get("shopify_variant_id")}

    variants_payload = []
    for variant in sp_product.get("variants") or []:
        shopify_variant_id = variant.get("id")
        if not shopify_variant_id:
            continue
        variant_data = {
            "product_id": product_id,
            "title": variant.get("title", "Default"),
            "quantity": int(variant.get("inventory_quantity", 0) or 0),
            "shopify_variant_id": shopify_variant_id,
            "inventory_item_id": variant.get("inventory_item_id"),
            "updated_at": current_time,
        }
        existing_variant = existing_variants_map.get(shopify_variant_id)
        if existing_variant:
            if variant_has_changed(variant_data, existing_variant):
                variant_data["id"] = existing_variant["id"]
                variant_data["cost_price"] = existing_variant.get("cost_price")
                variants_payload.append(variant_data)
        else:
            variant_data["created_at"] = current_time
            variants_payload.append(variant_data)

    if variants_payload:
        org_table(supabase, org_id, "shopify_variants").upsert(
            variants_payload, on_conflict="shopify_variant_id"
        ).execute()

    return result


async def deactivate_product_by_shopify_id(org_id: str, shopify_product_id: Any) -> bool:
    """products/delete's payload is just `{"id": ...}` - too little to reconcile, so this
    deactivates directly rather than going through reconcile_one_product. Same
    deactivate-not-delete convention as everywhere else here (existing orders reference
    products by our internal id). Returns whether a matching row was found."""
    supabase = get_supabase()
    current_time = datetime.now(timezone.utc).isoformat()
    resp = org_table(supabase, org_id, "shopify_products").update(
        {"is_active": False, "updated_at": current_time}
    ).eq("shopify_product_id", shopify_product_id).execute()
    return bool(resp.data)


async def apply_inventory_level_update(org_id: str, inventory_item_id: Any, available: Any) -> bool:
    """Applies inventory_levels/update's `available` directly onto the matching variant's
    quantity. Variants already store inventory_item_id (populated by sync_shopify_products/
    reconcile_and_persist_single_product), so unlike a product or order webhook this never
    needs to call back into Shopify. Returns whether a matching variant was found."""
    supabase = get_supabase()
    current_time = datetime.now(timezone.utc).isoformat()
    resp = org_table(supabase, org_id, "shopify_variants").update(
        {"quantity": int(available or 0), "updated_at": current_time}
    ).eq("inventory_item_id", inventory_item_id).execute()
    return bool(resp.data)


async def _fetch_products_and_variants(org_id: str) -> tuple:
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


async def sync_shopify_products(org_id: str) -> dict:
    """The "Sync Shopify Products" button's handler (see routes/products.py). Batch
    equivalent of reconcile_and_persist_single_product, sharing reconcile_one_product's
    per-product rules - see that function's docstring for why collection membership is
    only fetched for products missing one."""
    try:
        return await _sync_shopify_products(org_id)
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
            detail=f"Shopify API error: {error_text}",
        )
    except httpx.RequestError:
        logger.exception("Shopify product sync: connection error")
        raise HTTPException(status_code=502, detail="Failed to connect to Shopify")
    except Exception:
        logger.exception("Shopify product sync failed")
        raise HTTPException(status_code=500, detail="Error syncing products")


async def _sync_shopify_products(org_id: str) -> dict:
    org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
    # Shopify fetch and the local DB reads are independent - run them concurrently instead
    # of paying for both durations back to back.
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

    products_to_insert = []
    products_to_update = []
    # Maps shopify_product_id -> product_id (existing or to be created), for linking variants.
    product_id_map = {}
    # shopify_product_ids seen active in this sync - anything in existing_products_map
    # not in here gets deactivated below, instead of orphaned as an untracked DB row.
    synced_shopify_ids = set()

    for shopify_product in all_products:
        shopify_product_id = shopify_product.get("id")
        if not shopify_product_id or shopify_product.get("status") != "active":
            continue
        if shopify_product.get("title", "Untitled Product") in SHOPIFY_SYNC_PRODUCTS_IGNORE:
            continue

        existing_product = existing_products_map.get(shopify_product_id)
        result = reconcile_one_product(shopify_product, existing_product, product_collections, current_time)
        if result is None:
            continue
        synced_shopify_ids.add(shopify_product_id)
        if result.action == "insert":
            products_to_insert.append(result.product_data)
        elif result.action == "update":
            product_id_map[shopify_product_id] = existing_product["id"]
            products_to_update.append(result.product_data)
        elif existing_product:
            product_id_map[shopify_product_id] = existing_product["id"]

    # Insert new products and get their IDs
    created_products_count = 0
    if products_to_insert:
        batch_size = 1000
        for i in range(0, len(products_to_insert), batch_size):
            batch = products_to_insert[i:i + batch_size]
            result = org_table(supabase, org_id, "shopify_products").insert(batch).execute()
            created_products_count += len(batch)
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

    # Now process variants for all active, successfully-mapped products
    variants_to_insert = []
    variants_to_update = []
    for shopify_product in all_products:
        shopify_product_id = shopify_product.get("id")
        if not shopify_product_id or shopify_product.get("status") != "active":
            continue
        product_id = product_id_map.get(shopify_product_id)
        if not product_id:
            continue

        for variant in shopify_product.get("variants", []):
            shopify_variant_id = variant.get("id")
            if not shopify_variant_id:
                continue
            variant_data = {
                "product_id": product_id,
                "title": variant.get("title", "Default"),
                "quantity": int(variant.get("inventory_quantity", 0) or 0),
                "shopify_variant_id": shopify_variant_id,
                # Needed to push inventory adjustments back to Shopify (bills.py) -
                # inventory_levels/adjust.json addresses a location + inventory item,
                # not a variant.
                "inventory_item_id": variant.get("inventory_item_id"),
                "updated_at": current_time,
            }
            if shopify_variant_id in existing_variants_map:
                existing_variant = existing_variants_map[shopify_variant_id]
                if variant_has_changed(variant_data, existing_variant):
                    variant_data["id"] = existing_variant["id"]
                    variant_data["cost_price"] = existing_variant.get("cost_price")
                    variants_to_update.append(variant_data)
            else:
                variant_data["created_at"] = current_time
                variants_to_insert.append(variant_data)

    created_variants_count = 0
    if variants_to_insert:
        batch_size = 1000
        for i in range(0, len(variants_to_insert), batch_size):
            batch = variants_to_insert[i:i + batch_size]
            org_table(supabase, org_id, "shopify_variants").insert(batch).execute()
            created_variants_count += len(batch)

    updated_variants_count = 0
    if variants_to_update:
        batch_size = 1000
        for i in range(0, len(variants_to_update), batch_size):
            batch = variants_to_update[i:i + batch_size]
            org_table(supabase, org_id, "shopify_variants").upsert(batch, on_conflict="id").execute()
            updated_variants_count += len(batch)

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
            "total_from_shopify": total_active_products,
        },
        "variants": {
            "created": created_variants_count,
            "updated": updated_variants_count,
            "total_from_shopify": total_active_variants,
        },
        "pages_fetched": page_count,
        "total_products_from_shopify": len(all_products),
    }

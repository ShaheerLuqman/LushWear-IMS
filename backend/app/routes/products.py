from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List, Dict
from app.models import (
    ProductCreate, ProductUpdate, ProductWithVariants,
    ProductBatchCostPriceUpdate, ProductBulkSetCostPrice, RecalculateOrderCostsByProductBody,
    StockAdjustmentBody,
    Variant, VariantCreate, VariantUpdate, VariantBatchCostPriceUpdate,
)
from app.auth import get_org_id, require_auth
from app.database import get_supabase
from app.db_utils import fetch_all
from app.money import money
from app.org_scope import org_table
from app.org_settings import ensure_valid_shopify_token, get_org_integration_settings
from app.services import event_bus, shopify_products_sync
from app import shopify
from datetime import datetime, timezone, date, timedelta
import logging

logger = logging.getLogger("app.products")
router = APIRouter(prefix="/products", tags=["products"])


# A product is "low stock" below this many units in total, and out of stock at
# zero. Mirrored by LOW_STOCK_THRESHOLD in frontend/js/orders-grid.js - the grid
# badges, the status filter and these stat cards must agree on one number.
LOW_STOCK_THRESHOLD = 10


def _is_replacement_order(row: dict) -> bool:
    """Same notion as Shopify sync: an order tagged as a replacement for another."""
    return bool(row.get("replacement_of_order_no"))


def _log_cost_history(supabase, org_id: str, user_id, rows: list, reason, effective_from) -> None:
    """Record cost changes for the Inventory screen's View History panel. Rows whose
    cost didn't actually move are dropped, so re-saving a modal without editing
    anything leaves no trail. Never raises: losing the audit row must not fail the
    price change that already committed."""
    changed = [r for r in rows if money(r["old_cost_price"]) != money(r["new_cost_price"])]
    if not changed:
        return
    payload = [
        {
            "product_id": r["product_id"],
            "variant_id": r.get("variant_id"),
            "old_cost_price": r["old_cost_price"],
            "new_cost_price": r["new_cost_price"],
            "reason": reason,
            "changed_by": user_id,
            **({"effective_from": effective_from.isoformat()} if effective_from else {}),
        }
        for r in changed
    ]
    try:
        org_table(supabase, org_id, "shopify_product_cost_history").insert(payload).execute()
    except Exception:
        logger.exception("failed to record cost history for %d change(s)", len(payload))


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
    return await shopify_products_sync.sync_shopify_products(org_id)


@router.put("/batch-update-cost-prices")
async def batch_update_cost_prices(
    batch_update: ProductBatchCostPriceUpdate,
    org_id: str = Depends(get_org_id),
    payload: dict = Depends(require_auth),
):
    """Batch update cost prices for products - and cascades the same price onto every
    variant of each product, since a product with variants no longer has one cost of
    its own to just update (see batch_update_variant_cost_prices for editing a single
    variant's cost individually, e.g. when its price genuinely differs from its siblings)."""
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
                .select("id, name, cost_price")
                .in_("id", list(cost_price_by_id))
                .execute().data or []
            )
            upsert_rows = [
                {"id": p["id"], "name": p["name"], "cost_price": cost_price_by_id[p["id"]], "updated_at": current_time}
                for p in existing
            ]
            if upsert_rows:
                response = org_table(supabase, org_id, "shopify_products").upsert(upsert_rows, on_conflict="id").execute()
                updated_count = len(response.data or [])
                _log_cost_history(
                    supabase, org_id, payload.get("sub"),
                    [{"product_id": p["id"], "old_cost_price": p.get("cost_price"),
                      "new_cost_price": cost_price_by_id[p["id"]]} for p in existing],
                    batch_update.reason, batch_update.effective_from,
                )

            existing_variants = (
                org_table(supabase, org_id, "shopify_variants")
                .select("id, title, product_id")
                .in_("product_id", [p["id"] for p in existing])
                .execute().data or []
            )
            if existing_variants:
                variant_payload = [
                    {
                        "id": v["id"], "title": v["title"], "product_id": v["product_id"],
                        "cost_price": cost_price_by_id[v["product_id"]], "updated_at": current_time,
                    }
                    for v in existing_variants
                ]
                org_table(supabase, org_id, "shopify_variants").upsert(variant_payload, on_conflict="id").execute()

        return {
            "message": f"Successfully updated {updated_count} product(s)",
            "updated_count": updated_count
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/bulk-update-cost-price")
async def bulk_update_cost_price(
    body: ProductBulkSetCostPrice,
    org_id: str = Depends(get_org_id),
    payload: dict = Depends(require_auth),
):
    """Set one cost price on every given product at once, cascading it onto each product's
    variants (see batch_update_cost_prices for the per-id variant and the
    upsert-carries-NOT-NULL-columns reasoning - identical, just one shared price here)."""
    try:
        supabase = get_supabase()
        current_time = datetime.now(timezone.utc).isoformat()

        product_ids = list(dict.fromkeys(body.product_ids))
        updated_count = 0
        if product_ids:
            existing = (
                org_table(supabase, org_id, "shopify_products")
                .select("id, name, cost_price")
                .in_("id", product_ids)
                .execute().data or []
            )
            if existing:
                response = org_table(supabase, org_id, "shopify_products").upsert(
                    [{"id": p["id"], "name": p["name"], "cost_price": body.cost_price, "updated_at": current_time} for p in existing],
                    on_conflict="id",
                ).execute()
                updated_count = len(response.data or [])
                _log_cost_history(
                    supabase, org_id, payload.get("sub"),
                    [{"product_id": p["id"], "old_cost_price": p.get("cost_price"),
                      "new_cost_price": body.cost_price} for p in existing],
                    body.reason, body.effective_from,
                )

                existing_variants = (
                    org_table(supabase, org_id, "shopify_variants")
                    .select("id, title, product_id")
                    .in_("product_id", [p["id"] for p in existing])
                    .execute().data or []
                )
                if existing_variants:
                    org_table(supabase, org_id, "shopify_variants").upsert(
                        [
                            {"id": v["id"], "title": v["title"], "product_id": v["product_id"],
                             "cost_price": body.cost_price, "updated_at": current_time}
                            for v in existing_variants
                        ],
                        on_conflict="id",
                    ).execute()

        return {
            "message": f"Successfully updated {updated_count} product(s)",
            "updated_count": updated_count,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/batch-update-variant-cost-prices")
async def batch_update_variant_cost_prices(
    batch_update: VariantBatchCostPriceUpdate,
    org_id: str = Depends(get_org_id),
    payload: dict = Depends(require_auth),
):
    """Batch update cost prices for individual variants (see batch_update_cost_prices,
    the product-level equivalent, for the same upsert-carries-NOT-NULL-columns reasoning -
    title and product_id here play the role name does there)."""
    try:
        supabase = get_supabase()
        current_time = datetime.now(timezone.utc).isoformat()

        cost_price_by_id = {update.id: update.cost_price for update in batch_update.updates}
        updated_count = 0
        if cost_price_by_id:
            existing = (
                org_table(supabase, org_id, "shopify_variants")
                .select("id, title, product_id, cost_price")
                .in_("id", list(cost_price_by_id))
                .execute().data or []
            )
            upsert_rows = [
                {
                    "id": v["id"], "title": v["title"], "product_id": v["product_id"],
                    "cost_price": cost_price_by_id[v["id"]], "updated_at": current_time,
                }
                for v in existing
            ]
            if upsert_rows:
                response = org_table(supabase, org_id, "shopify_variants").upsert(upsert_rows, on_conflict="id").execute()
                updated_count = len(response.data or [])
                _log_cost_history(
                    supabase, org_id, payload.get("sub"),
                    [{"product_id": v["product_id"], "variant_id": v["id"],
                      "old_cost_price": v.get("cost_price"),
                      "new_cost_price": cost_price_by_id[v["id"]]} for v in existing],
                    batch_update.reason, batch_update.effective_from,
                )

        return {
            "message": f"Successfully updated {updated_count} variant(s)",
            "updated_count": updated_count
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/recalculate-order-costs")
async def recalculate_order_costs_for_product(body: RecalculateOrderCostsByProductBody, org_id: str = Depends(get_org_id)):
    """Recompute order cost_price from product costs for orders that include any of the given products."""
    try:
        supabase = get_supabase()
        requested_ids = {
            pid.strip()
            for pid in ([body.product_id] if body.product_id else []) + (body.product_ids or [])
            if pid and pid.strip()
        }
        if not requested_ids:
            raise HTTPException(status_code=400, detail="product_id or product_ids is required")

        prods = (
            org_table(supabase, org_id, "shopify_products").select("id, name").in_("id", list(requested_ids)).execute().data or []
        )
        if not prods:
            raise HTTPException(status_code=404, detail="Product not found")
        target_ids = {p["id"] for p in prods}
        target_names = {(p.get("name") or "").strip().lower() for p in prods if (p.get("name") or "").strip()}

        # Cost lookup by variant id (preferred - a line item's own variant may cost more
        # or less than its product's other variants), else product id, else lowercased
        # product name (fallback), all against line_items.
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

        costs_by_variant_id: Dict[str, float] = {}
        for v in org_table(supabase, org_id, "shopify_variants").select("id, cost_price").execute().data or []:
            if v.get("id") and v.get("cost_price") is not None:
                try:
                    costs_by_variant_id[v["id"]] = float(v["cost_price"])
                except (TypeError, ValueError):
                    pass

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

            # Does this order include any of the target products?
            includes_product = any(
                isinstance(li, dict) and (
                    li.get("product_id") in target_ids
                    or (li.get("name") or "").strip().lower() in target_names
                )
                for li in line_items
            )
            if not includes_product:
                continue

            if _is_replacement_order(row):
                new_cost = 0.0
            else:
                # Cost by variant_id (else product_id, else name) × qty.
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
                    vid = li.get("variant_id")
                    lid = li.get("product_id")
                    if vid and vid in costs_by_variant_id:
                        new_cost += costs_by_variant_id[vid] * qty
                    elif lid and lid in costs_by_id:
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

        if updated:
            event_bus.publish(org_id, {"type": "orders_changed"})
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


@router.get("/inventory-summary")
async def get_inventory_summary(org_id: str = Depends(get_org_id)):
    """The Inventory screen's five stat cards, with month-over-month deltas.

    The RPC aggregates the catalog, writes today's snapshot and hands back the
    newest snapshot at least a month old. There is no scheduler in this
    deployment, so opening the screen is what builds that history - `previous`
    (and every delta) stays null until a snapshot that old exists."""
    try:
        result = get_supabase().rpc(
            "capture_inventory_snapshot",
            {"p_org_id": org_id, "p_low_stock_threshold": LOW_STOCK_THRESHOLD},
        ).execute().data or {}
        current = result.get("current") or {}
        previous = result.get("previous")
        return {
            "low_stock_threshold": LOW_STOCK_THRESHOLD,
            "current": current,
            "previous": previous,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{product_id}/cost-history")
async def get_product_cost_history(product_id: str, org_id: str = Depends(get_org_id)):
    """Cost changes recorded for this product and its variants, newest first.
    Changed-by names come from system_users (not an org-scoped business table,
    so read directly) in one lookup rather than per row."""
    try:
        supabase = get_supabase()
        rows = (
            org_table(supabase, org_id, "shopify_product_cost_history")
            .select("variant_id, old_cost_price, new_cost_price, effective_from, reason, changed_by, created_at")
            .eq("product_id", product_id)
            .order("created_at", desc=True)
            .limit(200)
            .execute().data or []
        )
        if not rows:
            return []

        user_ids = {r["changed_by"] for r in rows if r.get("changed_by")}
        names = {}
        if user_ids:
            users = supabase.table("system_users").select("id, name, email").in_("id", list(user_ids)).execute().data or []
            names = {u["id"]: (u.get("name") or u.get("email") or "") for u in users}

        variant_titles = {}
        variant_ids = {r["variant_id"] for r in rows if r.get("variant_id")}
        if variant_ids:
            variants = (
                org_table(supabase, org_id, "shopify_variants")
                .select("id, title")
                .in_("id", list(variant_ids))
                .execute().data or []
            )
            variant_titles = {v["id"]: v["title"] for v in variants}

        for r in rows:
            r["changed_by_name"] = names.get(r.get("changed_by")) or "System"
            r["variant_title"] = variant_titles.get(r.get("variant_id"))
        return rows
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{product_id}/adjust-stock")
async def adjust_product_stock(
    product_id: str,
    body: StockAdjustmentBody,
    org_id: str = Depends(get_org_id),
    payload: dict = Depends(require_auth),
):
    """Apply signed per-variant stock corrections to this product.

    Shopify is adjusted first: variant quantities are pulled from Shopify on
    every sync, so a local-only change would be silently reverted, and doing it
    in this order means a Shopify failure leaves nothing half-applied here.
    Shopify's own inventory_levels/update webhook then lands the same numbers
    again (idempotently - it writes absolute quantities), so the local write
    below is only what keeps the grid correct in the meantime."""
    try:
        supabase = get_supabase()
        deltas = {a.variant_id: a.delta for a in body.adjustments if a.delta}
        if not deltas:
            raise HTTPException(status_code=400, detail="No non-zero adjustment given")

        variants = (
            org_table(supabase, org_id, "shopify_variants")
            .select("id, title, quantity, inventory_item_id")
            .eq("product_id", product_id)
            .in_("id", list(deltas))
            .execute().data or []
        )
        if len(variants) != len(deltas):
            raise HTTPException(status_code=404, detail="Unknown variant for this product")

        moves = []
        for v in variants:
            before = v.get("quantity") or 0
            after = before + deltas[v["id"]]
            if after < 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"{v['title']} only has {before} in stock",
                )
            moves.append({"variant": v, "before": before, "after": after, "delta": deltas[v["id"]]})

        shopify_moves = [(m["variant"]["inventory_item_id"], m["delta"]) for m in moves if m["variant"].get("inventory_item_id")]
        if shopify_moves:
            org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))
            location_id = await shopify.get_primary_location_id(org_creds)
            await shopify.adjust_inventory_levels(shopify_moves, location_id, org_creds)

        current_time = datetime.now(timezone.utc).isoformat()
        org_table(supabase, org_id, "shopify_variants").upsert(
            # Same NOT NULL-columns-must-be-carried reasoning as the cost upserts above.
            [{"id": m["variant"]["id"], "title": m["variant"]["title"], "product_id": product_id,
              "quantity": m["after"], "updated_at": current_time} for m in moves],
            on_conflict="id",
        ).execute()

        org_table(supabase, org_id, "shopify_stock_adjustments").insert([
            {
                "product_id": product_id,
                "variant_id": m["variant"]["id"],
                "delta": m["delta"],
                "quantity_before": m["before"],
                "quantity_after": m["after"],
                "reason": body.reason,
                "notes": body.notes,
                "changed_by": payload.get("sub"),
            }
            for m in moves
        ]).execute()

        event_bus.publish(org_id, {"type": "products_changed"})
        return {"updated_count": len(moves)}
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


# Oldest order period the frontend offers ("Maximum" range start) - see
# ORDERS_PERIOD_OLDEST_* in frontend/js/data-api.js. Used only to clamp the
# comparison window, never the main range.
_ANALYTICS_OLDEST = date(2024, 10, 22)


def _pa_resolve_key(row: dict, by_id: Dict[str, dict], by_name: Dict[str, str]) -> str:
    """Fold an RPC product row onto a catalog product id. The RPC already resolved
    variant_id/product_id; this only has to name-match the leftovers (same tiers as
    the month-summary breakdown: exact name, then name with the variant suffix
    stripped)."""
    pid = row.get("product_id")
    if pid and pid in by_id:
        return pid
    name = (row.get("item_name") or "").strip().lower()
    if not name:
        return "name:"
    if name in by_name:
        return by_name[name]
    if " - " in name:
        base = name.rsplit(" - ", 1)[0].strip()
        if base in by_name:
            return by_name[base]
    return f"name:{name}"


@router.get("/analytics")
async def get_product_analytics(
    start: date = Query(..., description="Range start, inclusive (YYYY-MM-DD)"),
    end: date = Query(..., description="Range end, inclusive (YYYY-MM-DD)"),
    org_id: str = Depends(get_org_id),
):
    """Per-product units/revenue for [start, end] and the equal-length window right
    before it, with a size breakdown, per-collection distinct order counts and a
    bucketed sales trend. Aggregation is done in one RPC over line_items; this route
    only merges the result with the product catalog (names, collections, images,
    variant counts, stock) and adds rows for products with no sales in the window."""
    try:
        if end < start:
            raise HTTPException(status_code=400, detail="end must be on or after start")

        span_days = (end - start).days + 1
        prev_end = start - timedelta(days=1)
        prev_start = start - timedelta(days=span_days)
        has_prev = prev_end >= _ANALYTICS_OLDEST
        if has_prev and prev_start < _ANALYTICS_OLDEST:
            prev_start = _ANALYTICS_OLDEST
        grain = "day" if span_days <= 92 else "week" if span_days <= 550 else "month"

        supabase = get_supabase()
        rpc_resp = supabase.rpc("get_product_analytics", {
            "p_org_id": org_id,
            "p_start": start.isoformat(),
            "p_end": end.isoformat(),
            "p_prev_start": prev_start.isoformat() if has_prev else None,
            "p_prev_end": prev_end.isoformat() if has_prev else None,
            "p_grain": grain,
        }).execute()
        rpc = rpc_resp.data or {}
        rpc_products = rpc.get("products") or []
        rpc_orders = rpc.get("orders") or []
        rpc_trend = rpc.get("trend") or []

        catalog = fetch_all(lambda: org_table(supabase, org_id, "shopify_products")
                            .select("id, name, collection, image_url, is_active"))
        variants = fetch_all(lambda: org_table(supabase, org_id, "shopify_variants")
                             .select("product_id, quantity"))

        variant_stats: Dict[str, Dict[str, int]] = {}
        for v in variants:
            pid = v.get("product_id")
            if not pid:
                continue
            st = variant_stats.setdefault(pid, {"count": 0, "stock": 0})
            st["count"] += 1
            st["stock"] += int(v.get("quantity") or 0)

        by_id = {p["id"]: p for p in catalog}
        by_name: Dict[str, str] = {}
        for p in catalog:
            nm = (p.get("name") or "").strip().lower()
            if nm:
                by_name.setdefault(nm, p["id"])
                if " - " in nm:
                    by_name.setdefault(nm.rsplit(" - ", 1)[0].strip(), p["id"])

        agg: Dict[str, Dict[str, dict]] = {"current": {}, "previous": {}}
        for row in rpc_products:
            phase = row.get("phase")
            if phase not in agg:
                continue
            key = _pa_resolve_key(row, by_id, by_name)
            b = agg[phase].setdefault(key, {"units": 0, "revenue": 0.0, "sizes": {}, "name": row.get("item_name")})
            b["units"] += int(row.get("units") or 0)
            b["revenue"] += float(row.get("revenue") or 0)
            for sz, u in (row.get("sizes") or {}).items():
                b["sizes"][sz] = b["sizes"].get(sz, 0) + int(u or 0)

        cur, prev = agg["current"], agg["previous"]
        keys = set(cur) | set(prev) | {p["id"] for p in catalog if p.get("is_active")}

        rows = []
        for key in keys:
            c = cur.get(key)
            pv = prev.get(key)
            product = by_id.get(key)
            if product:
                if not product.get("is_active") and not c and not pv:
                    continue
                st = variant_stats.get(key, {"count": 0, "stock": 0})
                rows.append({
                    "product_id": key,
                    "name": product.get("name") or "",
                    "collection": (product.get("collection") or "").strip() or "Uncategorized",
                    "image_url": product.get("image_url"),
                    "variant_count": st["count"],
                    "stock": st["stock"],
                    "units": (c or {}).get("units", 0),
                    "revenue": money((c or {}).get("revenue", 0.0)),
                    "sizes": (c or {}).get("sizes", {}),
                    "prev_units": (pv or {}).get("units", 0),
                    "prev_revenue": money((pv or {}).get("revenue", 0.0)),
                })
            else:
                rows.append({
                    "product_id": None,
                    "name": (c or {}).get("name") or (pv or {}).get("name") or "(unknown product)",
                    "collection": "Uncategorized",
                    "image_url": None,
                    "variant_count": 0,
                    "stock": 0,
                    "units": (c or {}).get("units", 0),
                    "revenue": money((c or {}).get("revenue", 0.0)),
                    "sizes": (c or {}).get("sizes", {}),
                    "prev_units": (pv or {}).get("units", 0),
                    "prev_revenue": money((pv or {}).get("revenue", 0.0)),
                })

        orders = {"current": {}, "previous": {}}
        for o in rpc_orders:
            ph = o.get("phase")
            if ph in orders and o.get("collection") is not None:
                orders[ph][o["collection"]] = int(o.get("order_count") or 0)

        return {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "prev_start": prev_start.isoformat() if has_prev else None,
            "prev_end": prev_end.isoformat() if has_prev else None,
            "has_prev": has_prev,
            "grain": grain,
            "rows": rows,
            "orders": orders,
            "trend": rpc_trend,
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("products endpoint failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/analytics-by-city")
async def get_city_analytics(
    start: date = Query(..., description="Range start, inclusive (YYYY-MM-DD)"),
    end: date = Query(..., description="Range end, inclusive (YYYY-MM-DD)"),
    org_id: str = Depends(get_org_id),
):
    """Per-city units/revenue for [start, end] and the equal-length window right
    before it, plus a per-city product breakdown. Same basis and product
    resolution as get_product_analytics; this route only merges the RPC result
    with the product catalog (names, collections) for the city_products rows."""
    try:
        if end < start:
            raise HTTPException(status_code=400, detail="end must be on or after start")

        span_days = (end - start).days + 1
        prev_end = start - timedelta(days=1)
        prev_start = start - timedelta(days=span_days)
        has_prev = prev_end >= _ANALYTICS_OLDEST
        if has_prev and prev_start < _ANALYTICS_OLDEST:
            prev_start = _ANALYTICS_OLDEST

        supabase = get_supabase()
        rpc_resp = supabase.rpc("get_city_analytics", {
            "p_org_id": org_id,
            "p_start": start.isoformat(),
            "p_end": end.isoformat(),
            "p_prev_start": prev_start.isoformat() if has_prev else None,
            "p_prev_end": prev_end.isoformat() if has_prev else None,
        }).execute()
        rpc = rpc_resp.data or {}
        rpc_cities = rpc.get("cities") or []
        rpc_city_products = rpc.get("city_products") or []

        catalog = fetch_all(lambda: org_table(supabase, org_id, "shopify_products")
                            .select("id, name, collection"))
        by_id = {p["id"]: p for p in catalog}
        by_name: Dict[str, str] = {}
        for p in catalog:
            nm = (p.get("name") or "").strip().lower()
            if nm:
                by_name.setdefault(nm, p["id"])
                if " - " in nm:
                    by_name.setdefault(nm.rsplit(" - ", 1)[0].strip(), p["id"])

        cities: Dict[str, dict] = {}
        for row in rpc_cities:
            phase = row.get("phase")
            city = row.get("city") or "Unknown"
            b = cities.setdefault(city, {
                "city": city, "units": 0, "revenue": 0.0, "orders": 0, "products": 0,
                "prev_units": 0, "prev_revenue": 0.0,
            })
            if phase == "current":
                b["units"] = int(row.get("units") or 0)
                b["revenue"] = money(row.get("revenue") or 0.0)
                b["orders"] = int(row.get("orders") or 0)
                b["products"] = int(row.get("products") or 0)
            elif phase == "previous":
                b["prev_units"] = int(row.get("units") or 0)
                b["prev_revenue"] = money(row.get("revenue") or 0.0)

        city_products = []
        for row in rpc_city_products:
            if row.get("phase") != "current":
                continue
            key = _pa_resolve_key(row, by_id, by_name)
            product = by_id.get(key)
            city_products.append({
                "city": row.get("city") or "Unknown",
                "product_id": key if product else None,
                "name": (product or {}).get("name") or row.get("item_name") or "(unknown product)",
                "collection": ((product or {}).get("collection") or "").strip() or "Uncategorized",
                "units": int(row.get("units") or 0),
                "revenue": money(row.get("revenue") or 0.0),
            })

        return {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "prev_start": prev_start.isoformat() if has_prev else None,
            "prev_end": prev_end.isoformat() if has_prev else None,
            "has_prev": has_prev,
            "cities": sorted(cities.values(), key=lambda c: c["revenue"], reverse=True),
            "city_products": city_products,
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

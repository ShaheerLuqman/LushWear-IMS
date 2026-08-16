"""Shopify -> DB order sync: fetch, reconcile, and persist.

Extracted verbatim from routes/orders.py (D1). This is the ~800-line sync
function referenced there - the most business-critical code in the repo
(fetch -> normalize -> reconcile -> persist, including the freeze-after-fulfilled
rules, voided-order handling and `NNNN-R` replacements). The reconciliation
rules are NOT covered by the test suite - verify changes with a live sync diff
(compare created/updated/skipped and affected rows against a known-good run),
not pytest.
"""

import asyncio
import logging
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import HTTPException
from pydantic import BaseModel
from supabase import create_client

from app import shopify
from app.advance_status import recompute_advance_statuses
from app.config import settings
from app.database import get_supabase
from app.org_scope import org_table
from app.org_settings import OrgIntegrationSettings, ensure_valid_shopify_token, get_org_integration_settings

logger = logging.getLogger("app.orders")


class SyncShopifyOrdersResult(BaseModel):
    """Shape of _sync_shopify_orders's return value - either the "already
    syncing" short-circuit or a completed run's stats, never a mix of both."""
    message: str
    already_syncing: bool = False
    last_synced_at: Optional[str] = None
    synced: Optional[int] = None
    created: Optional[int] = None
    updated: Optional[int] = None
    skipped: Optional[int] = None
    pages_fetched: Optional[int] = None
    total_orders_from_shopify: Optional[int] = None
    orders_per_page: Optional[int] = None

# Cap on values per `.in_()` query - keeps the request URL well under server/proxy length
# limits when scoping a query to a large set of order numbers.
IN_QUERY_CHUNK_SIZE = 200

# Discounts applied with these codes reduce the order total and are not treated as advance.
PRICE_REDUCTION_DISCOUNT_CODES = {
    "INFLUOFF",
    "REPLACEMENT100OFF",
    "GET10OFF",
    "GET5OFF",
}


def _resolve_line_item_cost(
    name: str, product_id: Optional[str], costs_by_id: Dict[str, float], products_cost_map: Dict[str, float]
) -> float:
    """Resolve one line item's unit cost_price: by product_id (reliable - survives product
    renames), falling back to name matching (exact, then variant-suffix-stripped, then
    substring) for items that didn't resolve to a product_id. `name` here is Shopify's
    line-item `title` (bare product name, no variant), which is why the exact-match tier
    usually suffices - the fallback tiers exist for older/renamed-product edge cases."""
    if product_id and product_id in costs_by_id:
        return costs_by_id[product_id]
    if not name:
        return 0.0
    item_lower = name.lower().strip()
    if item_lower in products_cost_map:
        return products_cost_map[item_lower]
    if " - " in name:
        base_name = name.rsplit(" - ", 1)[0].lower().strip()
        if base_name in products_cost_map:
            return products_cost_map[base_name]
    for product_name, cost in products_cost_map.items():
        if product_name in item_lower or item_lower in product_name:
            return cost
    return 0.0


def _cost_from_line_items(line_items: List[dict]) -> float:
    """Total cost price from structured line items, using each item's own cost_price
    snapshot (set once at sync time by _resolve_line_item_cost - see extract_line_items).
    No product lookup needed here since the cost is already embedded per line."""
    if not line_items:
        return 0.0
    total_cost = 0.0
    for li in line_items:
        try:
            qty = int(li.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            continue
        try:
            unit_cost = float(li.get("cost_price") or 0)
        except (TypeError, ValueError):
            unit_cost = 0.0
        total_cost += unit_cost * qty
    return total_cost


def _line_items_signature(line_items) -> List[str]:
    """Comparable signature for change-detection - sorted (name, variant, qty) triples,
    replacing the old sorted-flat-name-list comparison now that items[] is gone."""
    if not isinstance(line_items, list):
        return []
    return sorted(
        f"{li.get('name', '')}|{li.get('variant_title', '')}|{li.get('qty', 0)}"
        for li in line_items if isinstance(li, dict)
    )


def _line_items_incomplete(line_items) -> bool:
    """True if any line item is missing cost_price/unit_price - the shape the one-time
    legacy `items`-column backfill produced (no per-item price/cost existed to carry over).
    A snapshot like this must be treated as stale even when name/variant/qty already match
    Shopify, or a force-sync/periodic-sync would see "nothing changed" and skip filling it in."""
    if not isinstance(line_items, list):
        return False
    return any(
        isinstance(li, dict) and (li.get("cost_price") is None or li.get("unit_price") is None)
        for li in line_items
    )


_OTHER_COURIER_TRACKING_CHARGE_RE = re.compile(r"^\D.*?\s(\d+(?:\.\d+)?)\s*$")


def _delivery_charge_from_other_tracking(courier: Optional[str], tracking_number: Optional[str]) -> Optional[float]:
    """Courier "Other" has no tracking API, so the merchant types the courier name and
    delivery charge together into Shopify's free-text tracking number field (e.g. "Bykea
    300" -> Bykea, 180). Pull the trailing number back out as delivery_charge; None if the
    tracking number doesn't end in "<name> <number>"."""
    if (courier or "").strip().lower() != "other":
        return None
    m = _OTHER_COURIER_TRACKING_CHARGE_RE.match((tracking_number or "").strip())
    return float(m.group(1)) if m else None


def _order_total_from_fulfillments(sp_order: dict) -> Optional[float]:
    """
    Compute order total from fulfillments: fulfilled merchandise (price * quantity per
    fulfillment line) + shipping_lines (excluding is_removed).

    Returns None when there are no fulfillments or no positive merchandise from fulfillment lines
    (caller should use the standard Shopify total fallbacks).
    """
    fulfillments = sp_order.get("fulfillments") or []
    if not fulfillments:
        return None

    merchandise = 0.0
    for f in fulfillments:
        fulfillment_status = str(f.get("status") or "").strip().lower()
        if fulfillment_status == "cancelled":
            continue
        for li in f.get("line_items") or []:
            qty = li.get("quantity")
            if qty is None:
                qty = 1
            try:
                qty = int(qty)
            except (TypeError, ValueError):
                qty = 0
            try:
                price = float(li.get("price") or 0)
            except (TypeError, ValueError):
                price = 0.0
            merchandise += price * qty

    if merchandise <= 0:
        return None

    shipping_lines = sp_order.get("shipping_lines") or []
    shipping_total = 0.0
    for sl in shipping_lines:
        if sl.get("is_removed"):
            continue
        disc = sl.get("discounted_price")
        if disc is not None and str(disc).strip() != "":
            try:
                shipping_total += float(disc)
                continue
            except (TypeError, ValueError):
                pass
        dps = sl.get("discounted_price_set") or sl.get("price_set")
        if isinstance(dps, dict):
            sm = dps.get("shop_money") or {}
            amt = sm.get("amount")
            if amt is not None and str(amt).strip() != "":
                try:
                    shipping_total += float(amt)
                except (TypeError, ValueError):
                    pass

    # Only fall back to order-level shipping when shipping_lines are missing.
    # If shipping_lines are present but all are removed, shipping is intentionally waived.
    if shipping_total <= 0 and not shipping_lines and sp_order.get("total_shipping_price_set"):
        shop_money = (sp_order["total_shipping_price_set"] or {}).get("shop_money") or {}
        amt = shop_money.get("amount")
        if amt is not None and str(amt).strip() != "":
            try:
                shipping_total = float(amt)
            except (TypeError, ValueError):
                pass

    return merchandise + shipping_total


SHOPIFY_SYNC_PARTITIONS = 4


async def _fetch_shopify_orders_in_range(
    start: datetime, end: datetime, org_creds: OrgIntegrationSettings, n_partitions: int = SHOPIFY_SYNC_PARTITIONS
) -> Tuple[List[dict], int]:
    """Fetch orders whose `updated_at` falls in [start, end) by splitting the range into
    `n_partitions` chunks and fetching them concurrently. Shopify's cursor pagination is
    inherently sequential *within* one query (each page's cursor depends on the previous
    page), but independent date ranges have independent cursor chains and can run in
    parallel.

    Filters on `updated_at`, not `created_at`: Shopify bumps `updated_at` on any change
    (fulfillment, financial status, tags, ...), including on orders far outside a recent
    creation window, so this is what makes _sync_shopify_orders's incremental fetch (see
    below) both correct - an order created months ago that gets returned today still has
    a fresh `updated_at` and gets picked up - and cheap on every run after the first."""
    if end <= start:
        return [], 0
    partition_length = (end - start) / n_partitions

    async def fetch_window(w_start: datetime, w_end: datetime) -> Tuple[List[dict], int]:
        query = (
            f"status=any&limit={shopify.PAGE_LIMIT}"
            f"&updated_at_min={w_start.strftime('%Y-%m-%dT%H:%M:%S')}"
            f"&updated_at_max={w_end.strftime('%Y-%m-%dT%H:%M:%S')}"
        )
        return await shopify.fetch_all("orders", query, org_creds)

    windows = [
        (start + i * partition_length, start + (i + 1) * partition_length)
        for i in range(n_partitions)
    ]
    results = await asyncio.gather(*(fetch_window(s, e) for s, e in windows))

    seen_ids = set()
    all_orders: List[dict] = []
    total_pages = 0
    for orders, pages in results:
        total_pages += pages
        for o in orders:
            if o.get("id") not in seen_ids:
                seen_ids.add(o.get("id"))
                all_orders.append(o)
    return all_orders, total_pages


# Backfill window used only when there's no prior successful sync to resume from
# (first-ever run, or sync_status.last_synced_at cleared/missing) - every subsequent
# sync uses last_synced_at as the window start instead (see _sync_shopify_orders).
SHOPIFY_SYNC_WINDOW_DAYS = 60


def _compute_sync_window_start(last_synced_at_raw: Optional[str], now: datetime) -> datetime:
    """Incremental fetch window start: the last successful sync's checkpoint, or the
    SHOPIFY_SYNC_WINDOW_DAYS backfill window if there isn't one yet (first-ever sync)
    or it's unparseable (shouldn't happen, but a corrupt/manually-edited row shouldn't
    crash the sync)."""
    if last_synced_at_raw:
        try:
            return datetime.fromisoformat(str(last_synced_at_raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            pass
    return now - timedelta(days=SHOPIFY_SYNC_WINDOW_DAYS)


# Row id in `sync_status` for the full Shopify orders sync (see _sync_shopify_orders).
_SYNC_STATUS_ORDERS_ID = "shopify_orders"
# A held lock older than this is assumed to belong to a crashed/killed sync, not a live one.
_SYNC_LOCK_STALE_AFTER = timedelta(minutes=4)


def _get_sync_status_row(supabase, org_id: str) -> Dict[str, Any]:
    resp = (
        org_table(supabase, org_id, "shopify_sync_status")
        .select("last_synced_at, in_progress")
        .eq("id", _SYNC_STATUS_ORDERS_ID)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else {"last_synced_at": None, "in_progress": False}


def _get_last_synced_at(supabase, org_id: str) -> Optional[str]:
    return _get_sync_status_row(supabase, org_id).get("last_synced_at")


def _set_last_synced_at(supabase, org_id: str, when_iso: str) -> None:
    org_table(supabase, org_id, "shopify_sync_status").update({
        "last_synced_at": when_iso,
        "updated_at": when_iso,
    }).eq("id", _SYNC_STATUS_ORDERS_ID).execute()


def _release_stale_sync_lock(supabase, org_id: str) -> None:
    """Clears a lock left behind by a crashed/killed sync. Plain AND'd filters
    (eq + eq + lt) - PostgREST/Postgres handle this combination everywhere else
    in this file (see the order_receiving_date range filters below), unlike the
    OR'd single-UPDATE version this replaced, which had no precedent in this
    codebase and turned out not to reclaim stale locks correctly."""
    stale_cutoff = (datetime.now(timezone.utc) - _SYNC_LOCK_STALE_AFTER).isoformat()
    org_table(supabase, org_id, "shopify_sync_status").update({"in_progress": False}).eq(
        "id", _SYNC_STATUS_ORDERS_ID
    ).eq("in_progress", True).lt("lock_acquired_at", stale_cutoff).execute()


def _try_acquire_sync_lock(supabase, org_id: str) -> bool:
    """Claim the sync lock with a conditional UPDATE (in_progress: false -> true).
    Postgres serializes concurrent UPDATEs on the same row, so at most one caller
    can ever flip it - race-free without an advisory lock (unusable through
    PostgREST anyway)."""
    org_table(supabase, org_id, "shopify_sync_status").upsert(
        {"id": _SYNC_STATUS_ORDERS_ID, "in_progress": False},
        on_conflict="org_id,id",
        ignore_duplicates=True,
    ).execute()
    _release_stale_sync_lock(supabase, org_id)
    now_iso = datetime.now(timezone.utc).isoformat()
    resp = (
        org_table(supabase, org_id, "shopify_sync_status")
        .update({"in_progress": True, "lock_acquired_at": now_iso})
        .eq("id", _SYNC_STATUS_ORDERS_ID)
        .eq("in_progress", False)
        .execute()
    )
    return bool(resp.data)


def _release_sync_lock(supabase, org_id: str) -> None:
    org_table(supabase, org_id, "shopify_sync_status").update({"in_progress": False}).eq(
        "id", _SYNC_STATUS_ORDERS_ID
    ).execute()


# Cap on concurrent Supabase reads while fetching products/variants/order-chunks below -
# each runs on its own client (see the comment in that loop), so this bounds how many
# simultaneous connections a single sync opens.
_BULK_CONCURRENCY = 20


async def _sync_shopify_orders(org_id: str) -> dict:
    """The frontend decides when to auto-sync (see ledgers.js); this just guarantees
    at most one sync runs at a time per org, whether triggered by one tab, several
    tabs, or the manual button while an auto-sync is in flight."""
    supabase = get_supabase()

    if not _try_acquire_sync_lock(supabase, org_id):
        # Named distinctly from the reconciliation "skipped" count below (orders that
        # didn't need changes) - both being called "skipped" made every real sync with
        # skipped_count > 0 (i.e. nearly every sync) look like a no-op to callers.
        return {"message": "Sync already in progress", "already_syncing": True}

    try:
        t_start = time.perf_counter()
        now = datetime.now(timezone.utc)
        org_creds = await ensure_valid_shopify_token(org_id, get_org_integration_settings(org_id))

        # Incremental: resume from the last successful sync's checkpoint instead of always
        # re-fetching a fixed window - see _fetch_shopify_orders_in_range for why this is
        # both correct and, after the first run, dramatically cheaper (a periodic sync's
        # window is usually minutes wide, not SHOPIFY_SYNC_WINDOW_DAYS days).
        window_start = _compute_sync_window_start(_get_last_synced_at(supabase, org_id), now)
        all_orders, page_count = await _fetch_shopify_orders_in_range(window_start, now, org_creds)
        t_shopify_fetch = time.perf_counter()

        # Only the orders Shopify actually returned need a DB row to diff against - scoping
        # existing_orders_all (and the advance recompute below) to these avoids reading the
        # entire orders table (which grows unboundedly) on every sync.
        shopify_order_numbers = set()
        for sp_order in all_orders:
            raw_number = sp_order.get("order_number")
            if raw_number:
                shopify_order_numbers.add(int(raw_number))

        existing_orders_select = (
            "id, order_number, order_status, delivery_charge, tax_amount, "
            "delivery_status, piece_received, courier, tracking_number, "
            "cost_price, line_items, total_amount, advance_amount, order_receiving_date, "
            "replacement_of_order_no"
        )
        shopify_order_numbers_list = list(shopify_order_numbers)
        order_chunks = [
            shopify_order_numbers_list[i:i + IN_QUERY_CHUNK_SIZE]
            for i in range(0, len(shopify_order_numbers_list), IN_QUERY_CHUNK_SIZE)
        ]

        # Products, variants, and each order-number chunk are independent reads - run them
        # concurrently (each on its own client; see _update_order_sync for why sharing one
        # client's connection across concurrent threads isn't safe) instead of one at a time.
        sem = asyncio.Semaphore(_BULK_CONCURRENCY)

        async def select_concurrently(table: str, select_cols: str, in_col: str = None, in_vals: Optional[List[int]] = None):
            def run():
                client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
                q = org_table(client, org_id, table).select(select_cols)
                if in_col is not None:
                    q = q.in_(in_col, in_vals)
                return q.execute().data or []
            async with sem:
                return await asyncio.to_thread(run)

        products_task = select_concurrently("shopify_products", "id, name, cost_price, shopify_product_id")
        variants_task = select_concurrently("shopify_variants", "id, shopify_variant_id")
        order_chunk_tasks = [
            select_concurrently("shopify_orders", existing_orders_select, "order_number", chunk)
            for chunk in order_chunks
        ]
        products_data, variants_data, *order_chunk_results = await asyncio.gather(
            products_task, variants_task, *order_chunk_tasks
        )

        products_cost_map = {}
        costs_by_id = {}    # products.id -> cost_price, for resolving each line item's cost_price snapshot
        # Map Shopify ids -> local ids so line_items can reference our product/variant rows.
        product_id_by_shopify = {}   # shopify_product_id -> products.id
        for p in products_data:
            if p.get("name") and p.get("cost_price") is not None:
                # Store by lowercase name for case-insensitive matching
                products_cost_map[p["name"].lower().strip()] = float(p["cost_price"])
            if p.get("shopify_product_id") is not None and p.get("id"):
                product_id_by_shopify[int(p["shopify_product_id"])] = p["id"]
            if p.get("id") and p.get("cost_price") is not None:
                costs_by_id[p["id"]] = float(p["cost_price"])

        variant_id_by_shopify = {}   # shopify_variant_id -> variants.id
        for v in variants_data:
            if v.get("shopify_variant_id") is not None and v.get("id"):
                variant_id_by_shopify[int(v["shopify_variant_id"])] = v["id"]

        existing_orders_map = {}
        existing_orders_all = [row for chunk_rows in order_chunk_results for row in chunk_rows]
        t_local_reads = time.perf_counter()

        for o in existing_orders_all:
            order_num = o.get("order_number")
            if order_num is not None:
                existing_orders_map[order_num] = o

        def extract_courier(order):
            """Extract courier from the latest non-cancelled fulfillment, or latest fulfillment if all are cancelled."""
            if "fulfillments" not in order or len(order["fulfillments"]) == 0:
                return "Unassigned"

            fulfillments = order["fulfillments"]

            # Filter out cancelled fulfillments first, but keep them as fallback
            active_fulfillments = [f for f in fulfillments if f.get("status") != "cancelled"]
            fulfillments_to_check = active_fulfillments if active_fulfillments else fulfillments

            if not fulfillments_to_check:
                return "Unassigned"

            # Find the latest fulfillment by updated_at (or created_at if updated_at is missing)
            latest_fulfillment = None
            latest_timestamp = None

            for fulfillment in fulfillments_to_check:
                # Prefer updated_at as it reflects the latest change
                timestamp_str = fulfillment.get("updated_at") or fulfillment.get("created_at")
                if not timestamp_str:
                    continue

                timestamp = _parse_iso(timestamp_str)
                if timestamp and (latest_timestamp is None or timestamp > latest_timestamp):
                    latest_timestamp = timestamp
                    latest_fulfillment = fulfillment

            # If we couldn't find by timestamp, use the last one in the list
            if not latest_fulfillment:
                latest_fulfillment = fulfillments_to_check[-1]

            tracking_company = latest_fulfillment.get("tracking_company")
            if tracking_company:
                tracking_company = str(tracking_company).strip()
                if tracking_company:
                    return tracking_company
            return "Unassigned"

        def extract_tracking_number(order):
            """Extract tracking number from the latest non-cancelled fulfillment, or latest fulfillment if all are cancelled."""
            if "fulfillments" not in order or len(order["fulfillments"]) == 0:
                return None

            fulfillments = order["fulfillments"]

            # Filter out cancelled fulfillments first, but keep them as fallback
            active_fulfillments = [f for f in fulfillments if f.get("status") != "cancelled"]
            fulfillments_to_check = active_fulfillments if active_fulfillments else fulfillments

            if not fulfillments_to_check:
                return None

            # Find the latest fulfillment by updated_at (or created_at if updated_at is missing)
            latest_fulfillment = None
            latest_timestamp = None

            for fulfillment in fulfillments_to_check:
                # Prefer updated_at as it reflects the latest change
                timestamp_str = fulfillment.get("updated_at") or fulfillment.get("created_at")
                if not timestamp_str:
                    continue

                timestamp = _parse_iso(timestamp_str)
                if timestamp and (latest_timestamp is None or timestamp > latest_timestamp):
                    latest_timestamp = timestamp
                    latest_fulfillment = fulfillment

            # If we couldn't find by timestamp, use the last one in the list
            if not latest_fulfillment:
                latest_fulfillment = fulfillments_to_check[-1]

            tracking_number = latest_fulfillment.get("tracking_number")
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
            return "unfulfilled"

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
                        except (TypeError, ValueError):
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
                        except (TypeError, ValueError):
                            return None
            return None

        def extract_line_items(order, order_status=None):
            """Build structured line_items (one object per line, real qty) from Shopify line_items.
            Resolves product_id/variant_id via Shopify ids; snapshots name/variant_title/cost_price
            so old orders survive product renames/deletes/cost changes. Excludes removed lines
            (current_quantity 0) - except for "returned" orders, where current_quantity is 0 on
            every line by definition (the whole order was refunded back), so falling back to it
            would erase the historical record of what was actually shipped/invoiced; use the
            original quantity there instead."""
            if "line_items" not in order or not order["line_items"]:
                return []
            rows = []
            for item in order["line_items"]:
                qty = item.get("quantity") if order_status == "returned" else item.get("current_quantity")
                if qty is None:
                    qty = item.get("quantity") or 0
                try:
                    qty = int(qty)
                except (TypeError, ValueError):
                    qty = 0
                if qty <= 0:
                    continue
                sp_product_id = item.get("product_id")
                sp_variant_id = item.get("variant_id")
                try:
                    unit_price = float(item.get("price") or 0)
                except (TypeError, ValueError):
                    unit_price = 0.0
                resolved_product_id = product_id_by_shopify.get(int(sp_product_id)) if sp_product_id is not None else None
                name = (item.get("title") or item.get("name") or "").strip()
                rows.append({
                    "variant_id": variant_id_by_shopify.get(int(sp_variant_id)) if sp_variant_id is not None else None,
                    "product_id": resolved_product_id,
                    "name": name,
                    "variant_title": (item.get("variant_title") or "").strip() or "-",
                    "qty": qty,
                    "unit_price": unit_price,
                    "cost_price": _resolve_line_item_cost(name, resolved_product_id, costs_by_id, products_cost_map),
                })
            return rows

        def subtotal_line_items_excluding_removed(order):
            """Sum line item totals excluding removed items. Uses current_quantity (Shopify's quantity after removals) when present, else quantity. Removed lines have current_quantity=0."""
            if "line_items" not in order or not order["line_items"]:
                return None
            total = 0.0
            for item in order["line_items"]:
                # current_quantity is the quantity after edits/removals; when a line is removed it is 0
                qty = item.get("current_quantity")
                if qty is None:
                    qty = item.get("quantity") or 0
                try:
                    qty = int(qty)
                except (TypeError, ValueError):
                    qty = 0
                if qty <= 0:
                    continue
                try:
                    price = float(item.get("price") or 0)
                    total += price * qty
                except (TypeError, ValueError):
                    pass
            return total if total > 0 else None

        def normalize_value(val):
            if val is None:
                return None
            if isinstance(val, (int, float)):
                return round(float(val), 2)
            return str(val).strip() if val else None

        def has_changed(shopify_data, existing_data, skip_assigned_courier_fields=False):
            """
            skip_assigned_courier_fields: when True, do not compare courier, tracking_number,
            total_amount, delivery_charge, tax_amount, cost_price (used when courier is assigned).
            """
            fields_to_compare = ["courier", "tracking_number", "order_status", "total_amount", "advance_amount", "delivery_charge", "tax_amount", "cost_price"]
            if skip_assigned_courier_fields:
                fields_to_compare = ["order_status", "piece_received", "advance_amount"]
            for field in fields_to_compare:
                shopify_val = normalize_value(shopify_data.get(field))
                existing_val = normalize_value(existing_data.get(field))
                if field in ["total_amount", "advance_amount", "delivery_charge", "tax_amount", "cost_price"]:
                    shopify_num = float(shopify_val) if shopify_val is not None else 0.0
                    existing_num = float(existing_val) if existing_val is not None else 0.0
                    if abs(shopify_num - existing_num) > 0.01:
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
        original_orders_to_reset_piece_received = set()
        current_time = datetime.now(timezone.utc).isoformat()

        for sp_order in all_orders:
            order_number = sp_order.get("order_number")
            if not order_number:
                continue

            order_number = int(order_number)

            courier = extract_courier(sp_order)
            tracking_number = extract_tracking_number(sp_order)
            order_status = extract_order_status(sp_order)

            # Calculate total amount: use only non-removed line items (exclude quantity 0 / removed products)
            total_line_items_price = subtotal_line_items_excluding_removed(sp_order)
            if total_line_items_price is None:
                total_line_items_price = float(sp_order.get("total_line_items_price") or 0)
            shopify_tax = extract_tax_amount(sp_order) or 0.0  # Used only for total_amount calc; we never store tax from Shopify

            # Shopify shipping: we never store it as total_amount; delivery_charge is set in-app. If delivery was removed manually in Shopify, subtract it so total_amount excludes it.
            shipping_price = 0.0
            if "total_shipping_price_set" in sp_order and sp_order["total_shipping_price_set"]:
                shop_money = sp_order["total_shipping_price_set"].get("shop_money", {})
                if shop_money:
                    shipping_price = float(shop_money.get("amount", "0.00"))
            elif "total_shipping_price" in sp_order:
                shipping_price = float(sp_order.get("total_shipping_price") or 0)

            # Treat only configured discount codes as true price reductions.
            discount_codes = sp_order.get("discount_codes") or []
            normalized_discount_codes = {
                str(code_obj.get("code") or "").strip().upper()
                for code_obj in discount_codes
                if isinstance(code_obj, dict)
            }
            has_price_reduction_discount_code = any(
                code in PRICE_REDUCTION_DISCOUNT_CODES
                for code in normalized_discount_codes
            )
            total_discounts = float(sp_order.get("current_total_discounts") or sp_order.get("total_discounts") or 0)

            # Total amount:
            # Prefer fulfillment-derived merchandise + shipping for all orders.
            # If unavailable, fall back to Shopify totals.
            financial_status_peek = (sp_order.get("financial_status") or "").strip().lower()
            current_total = sp_order.get("current_total_price")
            total_price_val = sp_order.get("total_price")
            fulfillment_based_total = _order_total_from_fulfillments(sp_order)
            if fulfillment_based_total is not None:
                total_amount = fulfillment_based_total + shopify_tax
            elif current_total is not None and str(current_total).strip() != "":
                total_amount = float(current_total)
            elif total_price_val is not None and str(total_price_val).strip() != "":
                total_amount = float(total_price_val) - shipping_price
            else:
                total_amount = total_line_items_price + shopify_tax

            if has_price_reduction_discount_code:
                # Code-based discounts reduce selling price instead of being treated as advance.
                total_amount = max(0.0, total_amount - total_discounts)
                financial_status = financial_status_peek
                advance_amount = total_amount if financial_status == "paid" else 0.0
            else:
                financial_status = financial_status_peek
                if financial_status == "paid":
                    advance_amount = total_amount
                else:
                    advance_amount = total_discounts

            # Shopify zeroes current_total_price (and moves financial_status to "voided") on a
            # cancelled order - mirror that instead of carrying forward a stale amount.
            if order_status == "cancelled":
                total_amount = 0.0
                advance_amount = 0.0

            # delivery_charge and tax_amount are never taken from Shopify; set manually or via CSV
            delivery_charge = 0.0
            tax_amount = 0.0
            cost_price = extract_cost_price(sp_order) or 0.0

            # Set fixed delivery charge for SCS courier
            if courier.upper() == "SCS":
                delivery_charge = 180.0
            else:
                other_charge = _delivery_charge_from_other_tracking(courier, tracking_number)
                if other_charge is not None:
                    delivery_charge = other_charge
            structured_line_items = extract_line_items(sp_order, order_status)
            calculated_cost_from_items = _cost_from_line_items(structured_line_items) if structured_line_items else 0.0

            # If cost_price is 0, calculate it from items using products table
            if cost_price == 0.0 and structured_line_items:
                cost_price = calculated_cost_from_items

            order_received_date = sp_order.get("created_at")
            if order_received_date:
                try:
                    order_received_date = datetime.fromisoformat(order_received_date.replace('Z', '+00:00')).isoformat()
                except (TypeError, ValueError, AttributeError):
                    try:
                        order_received_date = datetime.strptime(order_received_date, "%Y-%m-%dT%H:%M:%S%z").isoformat()
                    except (TypeError, ValueError):
                        order_received_date = current_time
            else:
                order_received_date = current_time

            replacement_of = None
            is_replacement_order = False
            tags_raw = sp_order.get("tags")
            tags_str = (tags_raw if isinstance(tags_raw, str) else (str(tags_raw) if tags_raw is not None else "")).strip() or ""
            for tag in tags_str.split(","):
                tag = tag.strip()
                if re.match(r"^\d+-R$", tag, re.IGNORECASE):
                    replacement_of = int(re.match(r"^(\d+)-R$", tag, re.IGNORECASE).group(1))
                    is_replacement_order = True
                    break

            # Replacement orders (XXXX-R) always have 0 cost price
            order_cost_price = 0.0 if is_replacement_order else cost_price

            order_data = {
                "order_number": order_number,
                "courier": courier,
                "tracking_number": tracking_number,
                "order_status": order_status,
                "piece_received": "Pending",
                "total_amount": total_amount,
                "advance_amount": advance_amount,
                "delivery_charge": delivery_charge,
                "tax_amount": tax_amount,
                "cost_price": order_cost_price,
                "order_receiving_date": order_received_date,
                "line_items": structured_line_items,
                "replacement_of_order_no": replacement_of,
                "updated_at": current_time
            }
            if replacement_of:
                original_orders_to_reset_piece_received.add(replacement_of)

            if order_number in existing_orders_map:
                existing_order = existing_orders_map[order_number]
                existing_status = (existing_order.get("order_status") or "").strip().lower()
                if existing_status in ("delivered", "returned"):
                    existing_courier_lower = (existing_order.get("courier") or "").strip().lower()
                    shopify_courier_lower = (courier or "").strip().lower()
                    if existing_courier_lower == "other" or shopify_courier_lower == "other":
                        # "Other" has no tracking API, so the courier name / delivery charge can
                        # only ever be corrected by re-typing the Shopify tracking-number text -
                        # keep pulling that in even past the delivered/returned freeze below.
                        existing_tracking_frozen = (existing_order.get("tracking_number") or "").strip() or None
                        shopify_tracking_frozen = (tracking_number or "").strip() or None
                        if shopify_courier_lower != existing_courier_lower or shopify_tracking_frozen != existing_tracking_frozen:
                            other_charge = _delivery_charge_from_other_tracking(courier, tracking_number)
                            update_payload = {
                                **existing_order,
                                "courier": courier,
                                "tracking_number": tracking_number,
                                "delivery_charge": other_charge if other_charge is not None else existing_order.get("delivery_charge"),
                                "updated_at": current_time,
                            }
                            if replacement_of is not None and existing_order.get("replacement_of_order_no") != replacement_of:
                                update_payload["replacement_of_order_no"] = replacement_of
                            orders_to_update.append(update_payload)
                            continue
                    # Once an order has left "unfulfilled" (e.g. delivered/returned), do not overwrite totals/items/cost.
                    # Allow only replacement_of_order_no to be set if it was missing.
                    if replacement_of is not None and existing_order.get("replacement_of_order_no") != replacement_of:
                        # Only set replacement_of_order_no (e.g. first time we see tag 5404-R); do not overwrite advance/total
                        update_payload = {
                            **existing_order,
                            "replacement_of_order_no": replacement_of,
                            "updated_at": current_time,
                        }
                        orders_to_update.append(update_payload)
                    else:
                        orders_to_skip.append(order_number)
                    continue
                shopify_order_status = (order_data.get("order_status") or "").strip().lower()
                if shopify_order_status == "cancelled":
                    order_data["order_status"] = shopify_order_status
                elif shopify_order_status == "fulfilled" and existing_status == "unfulfilled":
                    order_data["order_status"] = shopify_order_status
                else:
                    order_data["order_status"] = existing_order.get("order_status")
                # Advance is always from Shopify: paid = total_amount, not paid = total_discounts
                order_data["advance_amount"] = advance_amount
                # Preserve tax_amount (never from Shopify; set manually or via CSV)
                order_data["tax_amount"] = existing_order.get("tax_amount", 0)
                # Preserve last fetched delivery status (from courier tracking)
                order_data["delivery_status"] = existing_order.get("delivery_status")
                # Preserve piece_received (set by delivery status or manually; default Pending)
                order_data["piece_received"] = existing_order.get("piece_received") or "Pending"

                existing_courier = (existing_order.get("courier") or "").strip()
                existing_tracking = (existing_order.get("tracking_number") or "").strip() if existing_order.get("tracking_number") else None
                courier_is_assigned = bool(existing_courier and existing_courier.lower() != "unassigned")
                freeze_amounts_items_cost = existing_status != "unfulfilled"
                # advance_amount keeps syncing from Shopify through "fulfilled" (payment/financial_status can
                # still change post-fulfillment); it only freezes once the order reaches delivered/returned
                # (handled above via early continue) or another terminal-ish status.
                freeze_advance = existing_status not in ("unfulfilled", "fulfilled")
                existing_line_items = existing_order.get("line_items")
                items_changed = (
                    _line_items_signature(structured_line_items) != _line_items_signature(existing_line_items)
                    or _line_items_incomplete(existing_line_items)
                )

                # Compare and update courier and tracking_number from Shopify if they differ
                shopify_courier = (courier or "").strip()
                shopify_tracking = (tracking_number or "").strip() if tracking_number else None

                # Normalize for comparison (handle "Unassigned" vs empty)
                existing_courier_normalized = existing_courier.lower() if existing_courier else "unassigned"
                shopify_courier_normalized = shopify_courier.lower() if shopify_courier else "unassigned"

                # Update courier and tracking_number from Shopify if they differ
                courier_changed = existing_courier_normalized != shopify_courier_normalized
                tracking_changed = existing_tracking != shopify_tracking

                if courier_changed or tracking_changed:
                    # Update courier and tracking_number from Shopify
                    order_data["courier"] = courier
                    order_data["tracking_number"] = tracking_number
                else:
                    # Keep existing values if they match
                    order_data["courier"] = existing_order.get("courier")
                    order_data["tracking_number"] = existing_order.get("tracking_number")

                # Set delivery_charge: 180 for SCS courier only if not already set to a non-zero value
                # Preserve any manually set delivery_charge (never from Shopify; set manually or via CSV)
                final_courier = (order_data.get("courier") or "").strip().upper()
                existing_delivery_charge = float(existing_order.get("delivery_charge") or 0)
                if final_courier == "SCS" and existing_delivery_charge == 0:
                    # Only set to 180 if courier is SCS and delivery_charge hasn't been set yet
                    order_data["delivery_charge"] = 180.0
                elif final_courier == "OTHER" and tracking_changed:
                    # Re-derive only when the Shopify text itself changed, so a manual in-app
                    # correction isn't clobbered on every sync when nothing upstream moved.
                    other_charge = _delivery_charge_from_other_tracking(order_data.get("courier"), order_data.get("tracking_number"))
                    order_data["delivery_charge"] = other_charge if other_charge is not None else existing_delivery_charge
                else:
                    # Preserve existing delivery_charge (including any non-zero values)
                    order_data["delivery_charge"] = existing_delivery_charge

                # Preserve existing order_receiving_date - never overwrite from Shopify for existing orders
                order_data["order_receiving_date"] = existing_order.get("order_receiving_date")

                # Update total_amount/line_items/cost_price only while status is unfulfilled.
                # After it changes from unfulfilled, freeze these fields.
                if freeze_amounts_items_cost:
                    order_data["total_amount"] = existing_order.get("total_amount")
                    order_data["advance_amount"] = existing_order.get("advance_amount") if freeze_advance else advance_amount
                    # Replacement orders (XXXX-R) always have 0 cost price
                    order_data["cost_price"] = 0.0 if is_replacement_order else existing_order.get("cost_price")
                    order_data["line_items"] = existing_order.get("line_items")
                    skip_fields = True
                else:
                    order_data["total_amount"] = total_amount
                    order_data["advance_amount"] = advance_amount
                    # Only refresh line_items (which snapshots each line's cost_price) when the
                    # order's own items actually changed - not on every sync just because the
                    # order is still unfulfilled. Otherwise a product's cost_price changing later
                    # would silently overwrite an old order's cost snapshot with today's price.
                    if items_changed:
                        order_data["line_items"] = structured_line_items
                    else:
                        order_data["line_items"] = existing_order.get("line_items")
                    # Replacement orders (XXXX-R) always have 0 cost price.
                    if is_replacement_order:
                        order_data["cost_price"] = 0.0
                    elif items_changed:
                        order_data["cost_price"] = calculated_cost_from_items
                    else:
                        order_data["cost_price"] = existing_order.get("cost_price")
                    # When courier is assigned, we already avoid overwriting some fields via has_changed's skip mode.
                    skip_fields = courier_is_assigned

                # Cancellation overrides the freeze above: a cancelled order's total is 0
                # even if it was already fulfilled (and therefore otherwise frozen).
                cancelled_total_needs_fix = False
                if order_data["order_status"] == "cancelled":
                    order_data["total_amount"] = 0.0
                    order_data["advance_amount"] = 0.0
                    cancelled_total_needs_fix = (
                        abs(float(existing_order.get("total_amount") or 0)) > 0.01
                        or abs(float(existing_order.get("advance_amount") or 0)) > 0.01
                    )

                # Always update if courier or tracking_number changed, otherwise check other fields.
                # has_changed's skip_fields mode (once an order has left "unfulfilled") never compares
                # total_amount, so an already-cancelled order whose advance_amount was already 0 would
                # otherwise never get a stale total_amount corrected here - cancelled_total_needs_fix covers that.
                if courier_changed or tracking_changed or cancelled_total_needs_fix or has_changed(order_data, existing_order, skip_assigned_courier_fields=skip_fields):
                    order_data["id"] = existing_order["id"]
                    orders_to_update.append(order_data)
                else:
                    orders_to_skip.append(order_number)
            else:
                # First-time create: sync all fields from Shopify
                order_data["created_at"] = current_time
                orders_to_insert.append(order_data)
        t_diff_loop = time.perf_counter()

        created_count = 0
        if orders_to_insert:
            batch_size = 1000
            for i in range(0, len(orders_to_insert), batch_size):
                batch = orders_to_insert[i:i + batch_size]
                org_table(supabase, org_id, "shopify_orders").upsert(batch, on_conflict="org_id,order_number").execute()
                created_count += len(batch)

        updated_count = 0
        if orders_to_update:
            batch_size = 1000
            for i in range(0, len(orders_to_update), batch_size):
                batch = orders_to_update[i:i + batch_size]
                org_table(supabase, org_id, "shopify_orders").upsert(batch, on_conflict="org_id,order_number").execute()
                updated_count += len(batch)
        t_upserts = time.perf_counter()

        if original_orders_to_reset_piece_received:
            originals_resp = (
                org_table(supabase, org_id, "shopify_orders")
                .select("id, piece_received")
                .in_("order_number", list(original_orders_to_reset_piece_received))
                .execute()
            )
            ids_to_reset = [
                row["id"] for row in (originals_resp.data or [])
                if (row.get("piece_received") or "").strip().lower() == "done"
            ]
            if ids_to_reset:
                org_table(supabase, org_id, "shopify_orders").update({
                    "piece_received": "Pending",
                    "updated_at": current_time,
                }).in_("id", ids_to_reset).execute()

        t_reset_piece = time.perf_counter()

        synced_count = created_count + updated_count
        skipped_count = len(orders_to_skip)

        # Shopify advance amounts may have changed; recompute advance statuses, scoped to the
        # orders Shopify actually returned (same reasoning as existing_orders_all above).
        try:
            recompute_advance_statuses(supabase, org_id, order_numbers=shopify_order_numbers)
        except Exception as e:
            logger.warning("[sync-shopify] advance status recompute failed: %s", e)
        t_advance_recompute = time.perf_counter()

        logger.info(
            "[sync-shopify] timing: shopify_fetch=%.2fs local_reads=%.2fs diff_loop=%.2fs "
            "upserts=%.2fs reset_piece=%.2fs advance_recompute=%.2fs total=%.2fs "
            "(orders_from_shopify=%d, created=%d, updated=%d, skipped=%d)",
            t_shopify_fetch - t_start,
            t_local_reads - t_shopify_fetch,
            t_diff_loop - t_local_reads,
            t_upserts - t_diff_loop,
            t_reset_piece - t_upserts,
            t_advance_recompute - t_reset_piece,
            t_advance_recompute - t_start,
            len(all_orders), created_count, updated_count, skipped_count,
        )

        # Checkpoint at this sync's *start* time, not now (after) - anything Shopify
        # updated between t_start and here would otherwise fall in the gap between "when
        # we fetched" and "what we recorded", and never get picked up by the next sync's
        # window. Using `now` means the next sync's window starts slightly before this
        # one's did instead, which just re-covers a few seconds of overlap - harmless,
        # since re-processing an unchanged order is already a no-op (orders_to_skip).
        last_synced_at = now.isoformat()
        try:
            _set_last_synced_at(supabase, org_id, last_synced_at)
        except Exception as e:
            logger.warning("[sync-shopify] failed to persist last_synced_at: %s", e)

        return {
            "message": "Orders synced successfully",
            "last_synced_at": last_synced_at,
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
            error_text = str(e.response.json())
        except ValueError:
            pass
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Shopify API error: {error_text}\nURL: {api_url if 'api_url' in locals() else 'N/A'}"
        )
    except httpx.RequestError:
        logger.exception("Shopify order sync: connection error")
        raise HTTPException(status_code=502, detail="Failed to connect to Shopify")
    except Exception:
        logger.exception("Shopify order sync failed")
        raise HTTPException(status_code=500, detail="Error syncing orders")
    finally:
        _release_sync_lock(supabase, org_id)

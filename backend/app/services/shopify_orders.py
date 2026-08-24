"""Fetching a single order from the Shopify Admin API.

Used by the invoice route to enrich a DB order with live Shopify data (consignee,
tracking, line items). Kept apart from the PDF modules so those stay pure and
offline-testable.

Extracted verbatim from routes/orders.py.
"""

import asyncio
from typing import List, Optional

import httpx

from app.org_settings import OrgIntegrationSettings


def _clean_store_url(store_url: str) -> str:
    store_url = store_url.strip().rstrip("/")
    if store_url.startswith("http://"):
        return store_url[7:]
    if store_url.startswith("https://"):
        return store_url[8:]
    return store_url


async def _get_with_retries(client: httpx.AsyncClient, url: str, headers: dict, params: Optional[dict] = None) -> Optional[httpx.Response]:
    """GET with Shopify's standard 429/5xx retry-backoff, shared by every fetch below.
    Returns the response (whatever its status) once one comes back cleanly, or None if
    every attempt errored or kept hitting a retryable status."""
    max_attempts = 4
    for attempt in range(max_attempts):
        try:
            r = await client.get(url, headers=headers, params=params)
            if r.status_code == 429:
                retry_after_header = r.headers.get("Retry-After")
                try:
                    retry_after = float(retry_after_header) if retry_after_header else 0.0
                except (TypeError, ValueError):
                    retry_after = 0.0
                await asyncio.sleep(max(retry_after, 0.6 * (2 ** attempt)))
                continue
            if 500 <= r.status_code < 600:
                await asyncio.sleep(0.5 * (2 ** attempt))
                continue
            return r
        except Exception:
            if attempt == max_attempts - 1:
                return None
            await asyncio.sleep(0.5 * (2 ** attempt))
            continue
    return None


def _shopify_order_matches_db_order(db_order_number: str, o: dict) -> bool:
    """True if Shopify order row corresponds to our DB order_number (e.g. 6563)."""
    want = str(db_order_number).strip().lstrip("#")
    if not want:
        return False
    name = (o.get("name") or "").strip().lstrip("#")
    if name == want:
        return True
    onum = o.get("order_number")
    if onum is None:
        return False
    try:
        onum_str = str(int(onum))
    except (TypeError, ValueError):
        return False
    return onum_str == want


async def _fetch_shopify_order_by_order_number(order_number: str, org_creds: OrgIntegrationSettings) -> Optional[dict]:
    """Fetch a single order from Shopify Admin REST API by order number (e.g. 6563)."""
    store_url = org_creds.shopify_store_url
    token = org_creds.shopify_access_token
    if not store_url or not token:
        return None
    store_url = _clean_store_url(store_url)
    num = str(order_number).strip().lstrip("#")
    if not num:
        return None
    base = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/orders.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        # "#num" first: Shopify's order `name` is "#<order_number>" by default, so the bare
        # number essentially never matches - trying it first would waste a whole round trip
        # on almost every lookup.
        for name_param in (f"#{num}", num):
            r = await _get_with_retries(client, base, headers, {"status": "any", "name": name_param, "limit": 10})
            if r is None or r.status_code != 200:
                continue
            for o in r.json().get("orders") or []:
                if _shopify_order_matches_db_order(order_number, o):
                    return o
    return None


async def _fetch_shopify_customer_orders(customer_id: Optional[int], org_creds: OrgIntegrationSettings) -> List[dict]:
    """Every order Shopify has on file for a customer (used for their order-history stats,
    e.g. the Order Fulfillment view's risk/customer-status column) - Shopify has no delivery
    outcome of its own, so callers cross-reference the returned order_numbers against our own
    delivery_status. Capped at Shopify's 250-per-page max; not paginated further, so a
    customer with more than 250 orders on this store undercounts their true history."""
    if not customer_id:
        return []
    store_url = org_creds.shopify_store_url
    token = org_creds.shopify_access_token
    if not store_url or not token:
        return []
    store_url = _clean_store_url(store_url)
    base = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/customers/{customer_id}/orders.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await _get_with_retries(client, base, headers, {"status": "any", "limit": 250})
    if r is not None and r.status_code == 200:
        return r.json().get("orders") or []
    return []


async def _fetch_shopify_unfulfilled_orders(org_creds: OrgIntegrationSettings) -> List[dict]:
    """The store's 250 most-recently-created orders that Shopify currently considers
    unfulfilled - a single request, no pagination. Measured on a real store: Shopify's
    fulfillment_status=unfulfilled filter matched 1300+ orders (old ones sitting at a null
    fulfillment status, not actionable) when only 37 were actually unfulfilled by our own
    tracking - paginating through all of them to find those 37 was this endpoint's actual
    bottleneck (~11s of an ~15s request). Anything genuinely actionable today is recent, so
    the 250 latest is comfortably enough; callers still fall back to
    _fetch_shopify_order_by_order_number for any DB row this sweep doesn't cover."""
    store_url = org_creds.shopify_store_url
    token = org_creds.shopify_access_token
    if not store_url or not token:
        return []
    store_url = _clean_store_url(store_url)
    url = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/orders.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
    params = {"status": "any", "fulfillment_status": "unfulfilled", "limit": 250, "order": "created_at desc"}
    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await _get_with_retries(client, url, headers, params)
    if r is not None and r.status_code == 200:
        return r.json().get("orders") or []
    return []

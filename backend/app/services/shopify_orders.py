"""Fetching a single order from the Shopify Admin API.

Used by the invoice route to enrich a DB order with live Shopify data (consignee,
tracking, line items). Kept apart from the PDF modules so those stay pure and
offline-testable.

Extracted verbatim from routes/orders.py.
"""

import asyncio
from typing import Optional

import httpx

from app.org_settings import OrgIntegrationSettings


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
    store_url = store_url.strip().rstrip("/")
    if store_url.startswith("http://"):
        store_url = store_url[7:]
    elif store_url.startswith("https://"):
        store_url = store_url[8:]
    num = str(order_number).strip().lstrip("#")
    if not num:
        return None
    base = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/orders.json"
    headers = {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
    name_params = [num, f"#{num}"]
    async with httpx.AsyncClient(timeout=45.0) as client:
        for name_param in name_params:
            # Retry transient failures/rate limits for this name query.
            max_attempts = 4
            for attempt in range(max_attempts):
                try:
                    r = await client.get(
                        base,
                        headers=headers,
                        params={"status": "any", "name": name_param, "limit": 10},
                    )
                    if r.status_code == 200:
                        data = r.json()
                        for o in data.get("orders") or []:
                            if _shopify_order_matches_db_order(order_number, o):
                                return o
                        break
                    if r.status_code == 429:
                        retry_after_header = r.headers.get("Retry-After")
                        try:
                            retry_after = float(retry_after_header) if retry_after_header else 0.0
                        except (TypeError, ValueError):
                            retry_after = 0.0
                        # Exponential backoff with Shopify hint when available.
                        wait_seconds = max(retry_after, 0.6 * (2 ** attempt))
                        await asyncio.sleep(wait_seconds)
                        continue
                    if 500 <= r.status_code < 600:
                        await asyncio.sleep(0.5 * (2 ** attempt))
                        continue
                    break
                except Exception:
                    if attempt == max_attempts - 1:
                        break
                    await asyncio.sleep(0.5 * (2 ** attempt))
                    continue
    return None

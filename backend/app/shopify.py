import asyncio
import re
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlparse, parse_qs

import httpx
from fastapi import HTTPException

from app.org_settings import OrgIntegrationSettings

PAGE_LIMIT = 250
_TIMEOUT = 60.0
_MAX_RATE_LIMIT_RETRIES = 5


def _credentials(org_creds: OrgIntegrationSettings) -> tuple[str, str]:
    store_url = org_creds.shopify_store_url
    access_token = org_creds.shopify_access_token
    if not store_url or not access_token:
        raise HTTPException(
            status_code=400,
            detail="Shopify credentials are not configured for this organization. Set them in Settings > Integrations.",
        )
    store_url = store_url.strip().rstrip("/")
    if store_url.startswith("http://"):
        store_url = store_url[7:]
    elif store_url.startswith("https://"):
        store_url = store_url[8:]
    return store_url, access_token


def _next_page_info(link_header: str) -> str | None:
    """Extract the `page_info` cursor from Shopify's Link header, if there's a next page."""
    match = re.search(r'<([^>]+)>;\s*rel=["\']next["\']', link_header, re.IGNORECASE)
    if not match:
        return None
    url = match.group(1)
    query = urlparse(url).query
    if query:
        params = parse_qs(query, keep_blank_values=True)
        if "page_info" in params:
            return params["page_info"][0]
        found = re.search(r"[?&]page_info=([^&]+)", url)
    else:
        found = re.search(r"page_info=([^&>]+)", url)
    return unquote(found.group(1)) if found else None


async def fetch_all(
    resource: str, first_page_query: str, org_creds: OrgIntegrationSettings, max_records: Optional[int] = None
) -> tuple[List[Dict[str, Any]], int]:
    """Page through a Shopify Admin REST collection.

    `resource` is the JSON key and endpoint name (e.g. "orders" -> orders.json).
    `org_creds` is the calling org's own store URL/token/API version - see
    app.org_settings.get_org_integration_settings().
    `max_records`, if given, stops paging once at least that many records are collected
    (e.g. "most recent N orders" with a `order=created_at+desc` query - there's no date
    boundary to filter on ahead of time, so this is the only way to bound the fetch).
    Returns (records, pages_fetched).
    """
    store_url, access_token = _credentials(org_creds)
    base_url = f"https://{store_url}/admin/api/{org_creds.shopify_api_version}/{resource}.json"
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}

    records: List[Dict[str, Any]] = []
    page_info = None
    page_count = 0

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        while True:
            api_url = f"{base_url}?page_info={page_info}" if page_info else f"{base_url}?{first_page_query}"

            # Retry on 429 with backoff - concurrent partitioned fetches (see orders.py's
            # sync-shopify) make hitting the shop's rate-limit bucket more likely than a
            # single sequential fetch ever did.
            for attempt in range(_MAX_RATE_LIMIT_RETRIES):
                response = await client.get(api_url, headers=headers)
                if response.status_code != 429:
                    break
                retry_after = float(response.headers.get("Retry-After", 0) or 0)
                await asyncio.sleep(max(retry_after, 0.5 * (2 ** attempt)))

            if response.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        "Shopify API endpoint not found. Please verify:\n"
                        f"1. Store URL is correct: {store_url}\n"
                        f"2. API version is valid: {org_creds.shopify_api_version}\n"
                        "3. Access token has correct permissions\n"
                        f"4. Full URL attempted: {api_url}\n"
                        f"Response: {response.text}"
                    ),
                )
            response.raise_for_status()
            payload = response.json()
            if resource not in payload:
                raise HTTPException(status_code=500, detail="Invalid response from Shopify API")

            page = payload[resource]
            if not page:
                break
            records.extend(page)
            page_count += 1

            if max_records is not None and len(records) >= max_records:
                break

            page_info = _next_page_info(response.headers.get("Link", ""))
            if not page_info:
                break

    return records, page_count

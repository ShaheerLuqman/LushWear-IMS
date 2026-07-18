import re
from typing import Any, Dict, List
from urllib.parse import unquote, urlparse, parse_qs

import httpx
from fastapi import HTTPException

from app.config import settings

PAGE_LIMIT = 250
_TIMEOUT = 60.0


def _credentials() -> tuple[str, str]:
    store_url = settings.shopify_store_url
    access_token = settings.shopify_access_token
    if not store_url or not access_token:
        raise HTTPException(
            status_code=400,
            detail="Shopify credentials not configured. Please set SHOPIFY_STORE_URL (or SHOPIFY_API_KEY) and SHOPIFY_ADMIN_API_TOKEN environment variables.",
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


async def fetch_all(resource: str, first_page_query: str) -> tuple[List[Dict[str, Any]], int]:
    """Page through a Shopify Admin REST collection.

    `resource` is the JSON key and endpoint name (e.g. "orders" -> orders.json).
    Returns (records, pages_fetched).
    """
    store_url, access_token = _credentials()
    base_url = f"https://{store_url}/admin/api/{settings.SHOPIFY_API_VERSION}/{resource}.json"
    headers = {"X-Shopify-Access-Token": access_token, "Content-Type": "application/json"}

    records: List[Dict[str, Any]] = []
    page_info = None
    page_count = 0

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        while True:
            api_url = f"{base_url}?page_info={page_info}" if page_info else f"{base_url}?{first_page_query}"
            response = await client.get(api_url, headers=headers)
            if response.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        "Shopify API endpoint not found. Please verify:\n"
                        f"1. Store URL is correct: {store_url}\n"
                        f"2. API version is valid: {settings.SHOPIFY_API_VERSION}\n"
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

            page_info = _next_page_info(response.headers.get("Link", ""))
            if not page_info:
                break

    return records, page_count

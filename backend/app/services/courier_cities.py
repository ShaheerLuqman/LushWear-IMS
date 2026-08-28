"""Live "which cities does this courier actually support" lookups for the Order
Fulfillment view's per-row courier-city dropdown (populated once a courier is chosen
in the side panel). Only PostEx and Couriers Next have a usable cities API right now -
every other entry in the frontend's FULFILLMENT_COURIERS just gets an empty list.

Neither list is org-specific data (Couriers Next's is its whole network, unscoped;
PostEx's is its own nationwide coverage, not particular to whichever merchant token
authenticates the request), so this is one shared cache, not one per org. It's
persisted to a local JSON file (CACHE_FILE) and refreshed once at app startup (see
app.main's lifespan calling refresh_courier_cities_cache) rather than on a per-request
TTL - a fresh process/container naturally starts with an empty file, which is what
makes a restart double as a cache refresh, exactly as intended.
"""
import json
import logging
from typing import Dict, List

import httpx

from app.org_settings import OrgIntegrationSettings, any_org_courier_credential
from app.paths import CACHE_DIR

logger = logging.getLogger("app.courier_cities")

CACHE_FILE = CACHE_DIR / "courier_cities.json"


def _load_cache_file() -> Dict[str, List[str]]:
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save_cache_file() -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps(_cache), encoding="utf-8")
    except OSError:
        logger.exception("Failed to persist courier cities cache to %s", CACHE_FILE)


_cache: Dict[str, List[str]] = _load_cache_file()


def _is_truthy_flag(value) -> bool:
    """PostEx serializes isPickupCity/isDeliveryCity inconsistently - sometimes a JSON
    boolean, sometimes the string "true" (see their own docs' sample response) - so
    this tolerates either instead of an exact `is True`/`== "true"` match."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return False


async def _fetch_postex_delivery_cities(merchant_token: str) -> List[str]:
    """PostEx's Operational Cities API. The documented operationalCityType=Delivery
    filter 400s on PostEx's own backend (MethodArgumentTypeMismatchException - their
    enum parser rejects the exact string their docs show as valid), so this fetches
    every operational city and filters to isDeliveryCity client-side instead."""
    url = "https://api.postex.pk/services/integration/api/order/v2/get-operational-city"
    headers = {"token": merchant_token}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, headers=headers)
    if r.status_code != 200:
        logger.warning("PostEx operational-city fetch failed: status=%s body=%s", r.status_code, r.text[:300])
        return []
    rows = r.json().get("dist") or []
    names = {
        str(row.get("operationalCityName")).strip()
        for row in rows
        if row.get("operationalCityName") and _is_truthy_flag(row.get("isDeliveryCity"))
    }
    if not names:
        logger.warning("PostEx operational-city fetch returned 0 delivery cities (raw rows=%d)", len(rows))
    return sorted(names)


async def _fetch_couriers_next_cities() -> List[str]:
    """Couriers Next's master city list. Not vendor-specific - the "Couriers Next"
    entry in FULFILLMENT_COURIERS books with api_vendor "auto" (it picks the
    downstream carrier itself), so there's no single sub-carrier to scope a city
    list to. Per Couriers Next's own docs this endpoint takes no auth_key. Their PHP
    backend answers a successful GET with HTTP 201, not 200 - checked in the response
    body's own `response` flag instead of assuming a REST-conventional status code."""
    url = "https://portal.couriersnext.com/API/GetCitiesList.php"
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url)
    if r.status_code >= 400:
        logger.warning("Couriers Next city-list fetch failed: status=%s body=%s", r.status_code, r.text[:300])
        return []
    body = r.json()
    if body.get("response") != 1:
        logger.warning("Couriers Next city-list fetch returned response!=1: %s", str(body)[:300])
        return []
    rows = body.get("data") or []
    names = {str(row.get("city_name")).strip() for row in rows if row.get("city_name")}
    if not names:
        logger.warning("Couriers Next city-list fetch returned 0 cities (raw rows=%d)", len(rows))
    return sorted(names)


async def refresh_courier_cities_cache() -> None:
    """Refetches both couriers' city lists and persists them to CACHE_FILE - called
    once at app startup. Not called on a per-request timer past that; get_courier_cities
    only ever falls back to a live fetch itself if this hasn't populated a courier yet
    (e.g. this startup call failed, or no org had PostEx credentials at the time)."""
    cn_cities = await _fetch_couriers_next_cities()
    if cn_cities:
        _cache["couriers_next"] = cn_cities

    token = any_org_courier_credential("postex")
    if token:
        postex_cities = await _fetch_postex_delivery_cities(token)
        if postex_cities:
            _cache["postex"] = postex_cities
    else:
        logger.info("No org has a PostEx merchant_token configured - skipping PostEx city cache refresh")

    _save_cache_file()


async def get_courier_cities(courier: str, org_id: str, org_creds: OrgIntegrationSettings) -> List[str]:
    """Supported-city list for one courier id, served from the cache file populated
    at app startup. Empty list for any courier without a cities API. Falls back to a
    live fetch (and persists the result) only if startup hasn't populated this
    courier's entry yet."""
    if courier in _cache:
        return _cache[courier]

    if courier == "postex":
        if not org_creds.postex_merchant_token:
            logger.warning("Courier city fetch for org %s: PostEx has no merchant_token configured", org_id)
            return []
        cities = await _fetch_postex_delivery_cities(org_creds.postex_merchant_token)
    elif courier == "couriers_next":
        cities = await _fetch_couriers_next_cities()
    else:
        return []

    if cities:
        _cache[courier] = cities
        _save_cache_file()
    return cities

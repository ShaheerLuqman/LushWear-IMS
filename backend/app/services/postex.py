"""PostEx CSV parsing and order booking.

Two unrelated halves against the same courier. The CSV parsing below was extracted
verbatim from routes/orders.py - its column mapping is deliberately fuzzy, since
PostEx exports vary in header spelling ("WH_INCOME_TAX (2%)" vs "WH INCOME TAX (2%)")
and Excel mangles long tracking numbers into exponential notation, so both are
normalised here rather than at the call site. The booking section at the bottom is
the live Create Order API behind the Order Fulfillment view.
"""

import csv
import io
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger("app.postex")


def parse_float(val: Any, default: float = 0.0) -> float:
    """Parse a CSV cell to float; return default if invalid. Strips commas and trailing %."""
    if val is None or (isinstance(val, str) and val.strip() == ""):
        return default
    try:
        s = str(val).strip().replace(",", "").rstrip("%").strip()
        return float(s) if s else default
    except (ValueError, TypeError):
        return default


def normalize_order_number(order_ref):
    """Extract order number from formats like #4807 or 4446-R.
    Returns string: '4807' for #4807, '4446-R' for 4446-R."""
    if order_ref is None:
        return None
    if isinstance(order_ref, (int, float)):
        return str(int(order_ref))
    order_str = str(order_ref).strip()
    if not order_str:
        return None
    # Check for replacement order pattern: digits followed by -R (case insensitive)
    replacement_match = re.match(r"#?(\d+)-R\b", order_str, re.IGNORECASE)
    if replacement_match:
        return f"{replacement_match.group(1)}-R"
    # Regular order: #XXXX or just digits
    match = re.search(r"\d+", order_str)
    if not match:
        return None
    return str(int(match.group(0)))


def parse_tracking_number_14(val):
    """Parse 14-digit tracking number; CSV may show it as exponential (e.g. 2.63E+13)."""
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        # Handle exponential notation (e.g. 2.63E+13 -> 26300000000000)
        if "e" in s.lower():
            n = int(float(s))
        else:
            n = int(s)
        # Return as 14-digit string (zero-pad if needed)
        return str(n).zfill(14) if 0 <= n < 10**14 else str(n)
    except (ValueError, TypeError):
        return None


def build_column_map(fieldnames: List[str]) -> Dict[str, str]:
    """Map a PostEx export's headers onto canonical keys.

    Values are the ORIGINAL fieldnames (spacing intact) because csv.DictReader keys
    rows by them. Each pattern is checked independently — not elif — so one header
    can satisfy several probes.
    """
    col_map: Dict[str, str] = {}
    for name in fieldnames:
        key_upper = name.upper().strip()
        key_norm = key_upper.replace(" ", "_")  # "WH INCOME TAX (2%)" -> "WH_INCOME_TAX_(2%)"
        if "SHIPPING_CHARGES" in key_upper and "shipping_charges" not in col_map:
            col_map["shipping_charges"] = name
        if "GST" in key_upper and "TAX" not in key_upper and "gst" not in col_map:
            col_map["gst"] = name
        if ("wh_income_tax" not in col_map and (
            "WH_INCOME_TAX" in key_norm or "INCOME_TAX" in key_norm
            or ("WH" in key_upper and "INCOME" in key_upper and "TAX" in key_upper and "SALES" not in key_upper)
        )):
            col_map["wh_income_tax"] = name
        if ("wh_sales_tax" not in col_map and (
            "WH_SALES_TAX" in key_norm or "SALES_TAX" in key_norm
            or ("WH" in key_upper and "SALES" in key_upper and "TAX" in key_upper)
        )):
            col_map["wh_sales_tax"] = name
        if ("ORDER_REF_NUMBER" in key_upper or "ORDER_NUMBER" in key_upper or "ORDER_ID" in key_upper) and "order_ref_number" not in col_map:
            col_map["order_ref_number"] = name
        if ("TRACKING_NUMBER" in key_upper or "TRACKING" in key_upper) and "tracking_number" not in col_map:
            col_map["tracking_number"] = name
        if "NET_AMOUNT" in key_upper and "net_amount" not in col_map:
            col_map["net_amount"] = name
    return col_map


def decode(content: bytes) -> str:
    """Decode CSV bytes, tolerating a UTF-8 BOM."""
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("utf-8-sig")


class CsvFormatError(ValueError):
    """The upload is not a PostEx CSV we can read (missing header or required column)."""


def parse_rows(content: bytes) -> Tuple[List[dict], List[str]]:
    """Parse a PostEx CSV into per-order update rows.

    Returns (rows, order_numbers). Each row carries the canonical fields the
    upload endpoint writes back: delivery_charge (shipping + GST), tax_amount
    (income + sales withholding), tracking_number and the CSV's own net amount
    for reconciliation.

    Raises CsvFormatError when the file has no header or lacks a required column.
    """
    reader = csv.DictReader(io.StringIO(decode(content)))
    if not reader.fieldnames:
        raise CsvFormatError("CSV has no header row.")

    col_map = build_column_map(reader.fieldnames)
    if "order_ref_number" not in col_map:
        raise CsvFormatError("CSV must contain an ORDER_REF_NUMBER, ORDER_NUMBER, or ORDER_ID column.")
    if "shipping_charges" not in col_map:
        raise CsvFormatError("CSV must contain SHIPPING_CHARGES column.")
    tracking_col = col_map.get("tracking_number")

    rows: List[dict] = []
    order_numbers: List[str] = []
    for row in reader:
        order_number = normalize_order_number(row.get(col_map["order_ref_number"], ""))
        if not order_number:
            continue
        shipping = parse_float(row.get(col_map["shipping_charges"], ""), 0)
        gst = parse_float(row.get(col_map.get("gst", ""), ""), 0)
        income_tax = parse_float(row.get(col_map.get("wh_income_tax", ""), ""), 0)
        sales_tax = parse_float(row.get(col_map.get("wh_sales_tax", ""), ""), 0)
        tracking_raw = row.get(tracking_col, "") if tracking_col else ""
        net_amount_raw = row.get(col_map.get("net_amount", ""), "") if col_map.get("net_amount") else None
        net_amount_val = (
            parse_float(net_amount_raw, None)
            if net_amount_raw is not None and str(net_amount_raw).strip() != ""
            else None
        )
        rows.append({
            "order_number": order_number,
            "delivery_charge": shipping + gst,
            "tax_amount": income_tax + sales_tax,
            "tracking_number": parse_tracking_number_14(tracking_raw),
            "csv_net_amount": net_amount_val,
        })
        order_numbers.append(order_number)
    return rows, order_numbers


# ==================== ORDER BOOKING ====================
#
# Booking (this section) is the write side of the Order Fulfillment view - it creates a
# real shipment PostEx will pick up. CSV parsing above is the unrelated read side, used
# after the fact to reconcile what PostEx actually charged.

_BASE_URL = "https://api.postex.pk/services/integration/api/order"
_TIMEOUT = 60.0
# PostEx answers every call with a string statusCode, not an HTTP-level one - a booking
# that fails validation still comes back 200 with a non-"200" statusCode in the body
# (same convention _fetch_postex_bulk already relies on in routes/orders.py).
_SUCCESS_STATUS = "200"


class PostexBookingError(Exception):
    """PostEx refused to book one order. Carries PostEx's own statusMessage so the
    fulfillment endpoint can report per-order why it failed rather than a generic 502."""


def normalize_phone(value: Optional[str]) -> Optional[str]:
    """Coerce a phone number to the 03xxxxxxxxx form create-order documents as mandatory.

    Shopify stores whatever the customer typed, so the same number arrives as
    "+92 300 1234567", "0092...", "92...", or already-correct "0300-1234567". PostEx
    rejects anything but the local 11-digit form. Returns None when the digits cannot
    be a Pakistani mobile number, so the caller reports it rather than booking a parcel
    the rider can never deliver.
    """
    if not value:
        return None
    digits = re.sub(r"\D", "", value)
    for prefix in ("0092", "92"):
        if digits.startswith(prefix) and len(digits) == len(prefix) + 10:
            digits = "0" + digits[len(prefix):]
            break
    if len(digits) == 10 and digits.startswith("3"):
        digits = "0" + digits
    return digits if len(digits) == 11 and digits.startswith("03") else None


async def create_order(
    client: httpx.AsyncClient,
    merchant_token: str,
    *,
    order_ref_number: str,
    customer_name: str,
    customer_phone: str,
    delivery_address: str,
    city_name: str,
    invoice_payment: float,
    items: int,
    order_detail: Optional[str] = None,
) -> str:
    """Book one shipment and return its PostEx tracking number.

    invoice_payment is what the rider collects on delivery, so it must already be net
    of any advance the customer paid - a fully-prepaid order books at 0, not at its
    order value. PostEx rounds to whole rupees, hence the int().

    Raises PostexBookingError when PostEx declines (unserviceable city, duplicate
    orderRefNumber, bad phone); the caller books the remaining orders regardless.
    """
    payload = {
        "cityName": city_name,
        "customerName": customer_name,
        "customerPhone": customer_phone,
        "deliveryAddress": delivery_address,
        "invoiceDivision": 0,
        "invoicePayment": int(round(invoice_payment)),
        "items": items,
        "orderRefNumber": order_ref_number,
        # Only forward bookings go through this screen; a return/replacement is still
        # raised in PostEx's own portal. pickupAddressCode is likewise omitted, which
        # makes PostEx use the account's default warehouse.
        "orderType": "Normal",
    }
    if order_detail:
        payload["orderDetail"] = order_detail

    try:
        response = await client.post(
            f"{_BASE_URL}/v3/create-order",
            headers={"token": merchant_token, "Content-Type": "application/json"},
            json=payload,
        )
    except httpx.HTTPError as exc:
        raise PostexBookingError(f"Could not reach PostEx: {exc}") from exc

    try:
        body = response.json()
    except ValueError:
        raise PostexBookingError(f"PostEx returned a non-JSON response (HTTP {response.status_code})")

    if str(body.get("statusCode")) != _SUCCESS_STATUS:
        raise PostexBookingError(body.get("statusMessage") or f"PostEx rejected the order (HTTP {response.status_code})")

    tracking_number = (body.get("dist") or {}).get("trackingNumber")
    if not tracking_number:
        # Booked but unusable: without a tracking number nothing downstream (status
        # polling, the CSV reconcile) can ever match this parcel back to the order.
        raise PostexBookingError("PostEx accepted the order but returned no tracking number")
    return str(tracking_number)

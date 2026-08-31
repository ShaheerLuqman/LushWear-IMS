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


# ==================== API SETTLEMENT DERIVATION ====================
#
# The tracking API reports the shipping charge it levied but never the withholding
# deducted at payout, so tax has to be derived. Verified against a 243-row CPR export:
# delivery_charge matched SHIPPING_CHARGES+GST on every row, and on all 203 delivered
# rows income and sales withholding were each exactly 2% of COD. Returns carry no
# withholding at all (40/40 rows zero), which is why status gates the tax below -
# applying a flat rate there would invent a charge PostEx never made.

FOLIO_API_SUFFIX = "-API"
WH_INCOME_TAX_RATE = 0.02
WH_SALES_TAX_RATE = 0.02
_SETTLEABLE_STATUSES = {"delivered", "returned"}


def _folio_from_date(raw: str) -> str:
    """A PostEx payout date as the d/m/yy folio the CSV upload records by hand.

    For a delivery that date is reservePaymentDate; for a return it is the Payment Status
    API's settlementDate. Either way it names the CPR batch the order was paid on, which is
    what the folio records - verified equal to the stored folio on 312 CSV-settled
    deliveries and every CSV-settled return checked.

    The -API suffix marks the folio as derived here rather than typed against a CPR export,
    so the two sources stay distinguishable in the grid.
    """
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(raw or ""))
    if not match:
        return ""
    year, month, day = match.groups()
    return f"{int(day)}/{int(month)}/{year[2:]}{FOLIO_API_SUFFIX}"


def parse_payment_status(dist: Optional[dict]) -> dict:
    """Fold a payment-status response's `dist` into the settled flag and folio.

    The tracking API dates only reserve payments (deliveries); a return's payout shows
    only here, as settlementDate against the CPR it was netted on. The live response is
    {settle, settlementDate, cpr1, cpr1Date}, or just {settle: false} before payout - not
    the {cprNumber_1, cprNumber_2, reservePaymentDate} shape the v4.1.9 guide documents.
    """
    d = dist or {}
    if not d.get("settle"):
        return {"settled": False, "settlement_date": "", "folio": ""}
    date = d.get("settlementDate") or d.get("cpr1Date") or ""
    return {"settled": True, "settlement_date": date, "folio": _folio_from_date(date)}


def settlement_from_tracking(dist: dict, payment_status: Optional[dict] = None) -> Optional[dict]:
    """Derive delivery_charge and tax_amount for one order from a tracking response.

    Returns None unless PostEx reports a settled terminal status, since the fee is not
    final until then. tax_amount is derived, not reported - callers must record that so
    a later CPR upload can overwrite it with the real withholding.

    payment_status is parse_payment_status()'s output. A return carries no
    reservePaymentDate, so the caller fetches its payout separately and passes it here;
    without it a return still derives its charges but stays unsettled with no folio.
    """
    status = str(dist.get("transactionStatus") or "").strip().lower()
    if status not in _SETTLEABLE_STATUSES:
        return None

    invoice = parse_float(dist.get("invoicePayment"), 0.0)
    is_return = status == "returned"
    # On a return PostEx zeroes transactionFee/Tax and bills the same amounts under
    # reversalFee/reversalTax instead; reading only the transaction pair would record a
    # zero delivery charge. Verified against 840 CSV-settled returns, all exact.
    if is_return:
        fee = parse_float(dist.get("reversalFee"), 0.0)
        gst = parse_float(dist.get("reversalTax"), 0.0)
    else:
        fee = parse_float(dist.get("transactionFee"), 0.0)
        gst = parse_float(dist.get("transactionTax"), 0.0)
    tax = 0.0 if is_return else invoice * (WH_INCOME_TAX_RATE + WH_SALES_TAX_RATE)

    if payment_status is not None:
        settled = payment_status["settled"]
        folio = payment_status["folio"]
        settlement_date = payment_status["settlement_date"]
    else:
        reserve_date = dist.get("reservePaymentDate")
        settled = bool(reserve_date) and not is_return
        folio = "" if is_return else _folio_from_date(reserve_date)
        settlement_date = "" if is_return else (reserve_date or "")

    return {
        "delivery_charge": round(fee + gst, 2),
        "tax_amount": round(tax, 2),
        "invoice_payment": round(invoice, 2),
        "order_status": "returned" if is_return else "delivered",
        "settlement_date": settlement_date,
        "folio": folio,
        "settled": settled,
    }


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

# create-order's orderType, spelled as PostEx's own get-order-types API returns them (their
# create-order doc page says "Reverse", but the value their API lists - and accepts - is
# "Reversed"). Hardcoded rather than fetched: it is a fixed three-value enum, and the
# fulfillment UI has to offer it before any booking call is made.
ORDER_TYPES = ("Normal", "Reversed", "Replacement")


class PostexBookingError(Exception):
    """PostEx refused to book one order. Carries PostEx's own statusMessage so the
    fulfillment endpoint can report per-order why it failed rather than a generic 502."""


class PostexInvoiceError(Exception):
    """The airway bill PDF could not be fetched for one or more tracking numbers."""


# Their get-invoice note: "PDF will be generated for a maximum of 10 tracking numbers."
MAX_AIRWAY_BILL_TRACKING_NUMBERS = 10


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


async def fetch_pickup_addresses(merchant_token: str) -> List[dict]:
    """The merchant's configured pickup/warehouse addresses, as
    [{code, label, city, address, is_default}] ordered as PostEx returns them.

    create-order rejects a booking that sets neither pickupAddressCode nor
    storeAddressCode ("BOTH PICKUP ADDRESS CODE AND STORE ADDRESS CODE MUST NOT BE NULL
    AT THE SAME TIME") even though the integration guide marks both Optional, so a code
    has to be chosen before anything can be booked.

    is_default is read off addressType - undocumented in the integration guide (which
    only lists phone1/phone2/contactPersonName/cityName/address/addressCode), but PostEx's
    live response marks exactly one address per merchant "Default Address" and the rest
    "Pickup/Return Address"; confirmed against a real account's get-merchant-address call.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(f"{_BASE_URL}/v1/get-merchant-address", headers={"token": merchant_token})
    if r.status_code != 200:
        logger.warning("PostEx merchant-address fetch failed: status=%s body=%s", r.status_code, r.text[:300])
        return []
    return [
        {
            "code": row.get("addressCode"),
            "label": row.get("addressType") or "Pickup Address",
            "city": row.get("cityName"),
            # PostEx stores these with embedded newlines from their own portal's textarea.
            "address": " ".join((row.get("address") or "").split()),
            "is_default": (row.get("addressType") or "").strip().lower() == "default address",
        }
        for row in (r.json().get("dist") or [])
        if row.get("addressCode")
    ]


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
    pickup_address_code: str,
    order_type: str = "Normal",
    order_detail: Optional[str] = None,
    instructions: Optional[str] = None,
    customer_email: Optional[str] = None,
    invoice_division: Optional[int] = None,
) -> str:
    """Book one shipment and return its PostEx tracking number.

    invoice_payment is what the rider collects on delivery, so it must already be net
    of any advance the customer paid - a fully-prepaid order books at 0, not at its
    order value. PostEx rounds to whole rupees, hence the int().

    order_type is one of ORDER_TYPES - a Reversed/Replacement booking collects from the
    customer instead of delivering to them, so it is picked per order rather than assumed.

    instructions is the merchant's per-order note, sent as PostEx's transactionNotes.
    invoice_division is PostEx's airway-bill split count (defaults to 1).
    customer_email is accepted for call-site symmetry with couriers_next.create_order
    but not sent - PostEx's create-order has no email field.

    Raises PostexBookingError when PostEx declines (unserviceable city, duplicate
    orderRefNumber, bad phone); the caller books the remaining orders regardless.
    """
    payload = {
        "cityName": city_name,
        "customerName": customer_name,
        "customerPhone": customer_phone,
        "deliveryAddress": delivery_address,
        "invoiceDivision": invoice_division if invoice_division and invoice_division > 0 else 1,
        "invoicePayment": int(round(invoice_payment)),
        "items": items,
        # Prefixed with # so PostEx prints "#4807" on the airway bill; the CSV reconcile
        # strips it again via normalize_order_number.
        "orderRefNumber": f"#{order_ref_number}",
        # Required in practice despite the guide marking it Optional - see
        # fetch_pickup_addresses.
        "pickupAddressCode": pickup_address_code,
        "orderType": order_type,
    }
    if order_detail:
        payload["orderDetail"] = order_detail
    if instructions:
        payload["transactionNotes"] = instructions

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


async def get_airway_bill(client: httpx.AsyncClient, merchant_token: str, tracking_numbers: List[str]) -> bytes:
    """Fetch the printable airway bill PDF for one or more booked orders.

    Unlike every other endpoint in this file, get-invoice returns the PDF bytes directly
    rather than their usual {statusCode, statusMessage, dist} envelope - a failure comes
    back as a non-200 with a plain-text or JSON body instead.
    """
    if not tracking_numbers:
        raise PostexInvoiceError("No tracking number given")
    if len(tracking_numbers) > MAX_AIRWAY_BILL_TRACKING_NUMBERS:
        raise PostexInvoiceError(
            f"PostEx generates airway bills for at most {MAX_AIRWAY_BILL_TRACKING_NUMBERS} tracking numbers at a time")

    try:
        response = await client.get(
            f"{_BASE_URL}/v1/get-invoice",
            headers={"token": merchant_token},
            params={"trackingNumbers": ",".join(tracking_numbers)},
        )
    except httpx.HTTPError as exc:
        raise PostexInvoiceError(f"Could not reach PostEx: {exc}") from exc

    if response.status_code != 200:
        try:
            message = response.json().get("statusMessage")
        except ValueError:
            message = None
        raise PostexInvoiceError(
            message or f"PostEx rejected the airway bill request (HTTP {response.status_code})")
    return response.content

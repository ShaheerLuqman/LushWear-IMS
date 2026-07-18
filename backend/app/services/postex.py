"""PostEx CSV parsing.

Extracted verbatim from routes/orders.py. The column mapping is deliberately
fuzzy: PostEx exports vary in header spelling ("WH_INCOME_TAX (2%)" vs
"WH INCOME TAX (2%)"), and Excel mangles long tracking numbers into exponential
notation, so both are normalised here rather than at the call site.
"""

import csv
import io
import re
from typing import Any, Dict, List, Optional, Tuple


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

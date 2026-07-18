"""
Advance reconciliation status helpers.

An order's advance can come from two places:
  - Shopify: stored on orders.advance_amount
  - Cashbook: order-advance inflow entries posted to the Orders ledger, tagged with
    the order_number column on cashbook_entries

advance_status (stored on orders.advance_status) reconciles the two:
  1 = no advance amount for the order (both zero)
  2 = Shopify advance present, but no cashbook entry
  3 = cashbook entry present, but no Shopify advance
  4 = advance present in both and they match
  5 = advance present in both but they do not match
"""
from typing import Dict

from app.db_utils import fetch_all
from app.money import money

# The "Orders" ledger that order advances are always posted to (mirrors the
# ORDERS_LEDGER_ID constant in the frontend).
ORDERS_LEDGER_ID = "020dbc00-d5da-4110-89e9-fa22edf002f6"

# Status codes
ADV_NONE = 1
ADV_SHOPIFY_ONLY = 2
ADV_CASHBOOK_ONLY = 3
ADV_MATCH = 4
ADV_MISMATCH = 5

def compute_advance_status(shopify_advance: float, cashbook_advance: float) -> int:
    """Return the advance_status code for one order given the two advance amounts."""
    # Rounding to cents first makes these exact comparisons; sub-cent float noise
    # (e.g. 1522.1999999999998) is normalised away rather than absorbed by a tolerance.
    shopify = money(shopify_advance)
    cashbook = money(cashbook_advance)

    if not shopify and not cashbook:
        return ADV_NONE
    if shopify and not cashbook:
        return ADV_SHOPIFY_ONLY
    if not shopify and cashbook:
        return ADV_CASHBOOK_ONLY
    return ADV_MATCH if shopify == cashbook else ADV_MISMATCH


def fetch_cashbook_advance_totals(supabase) -> Dict[str, float]:
    """
    Sum order-advance cashbook entries per order number.

    Order-advance entries are inflows on the Orders ledger that carry an order_number.
    Returns a map of order_number (str) -> total advance amount from the cashbook.
    """
    totals: Dict[str, float] = {}
    rows = fetch_all(
        lambda: supabase.table("cashbook_entries")
        .select("order_number, amount, entry_type")
        .eq("folio", ORDERS_LEDGER_ID)
        .eq("entry_type", "inflow")
        .not_.is_("order_number", "null")
    )
    for row in rows:
        num = row.get("order_number")
        if num is None:
            continue
        key = str(num).strip()
        if not key:
            continue
        try:
            totals[key] = totals.get(key, 0.0) + float(row.get("amount") or 0)
        except (TypeError, ValueError):
            continue
    return totals


def recompute_advance_statuses(supabase, order_numbers=None) -> int:
    """
    Recompute and persist advance_status on orders.

    If order_numbers is provided (iterable of str), only those orders are recomputed;
    otherwise all orders are recomputed. Returns the number of orders updated.
    """
    cashbook_totals = fetch_cashbook_advance_totals(supabase)

    # Build the set of order numbers we need to evaluate. When scoped, we still need
    # any order referenced by a cashbook entry even if its number wasn't passed in.
    scoped = None
    if order_numbers is not None:
        scoped = {str(n).strip() for n in order_numbers if str(n).strip()}

    def _orders_query():
        query = supabase.table("orders").select("id, order_number, advance_amount, advance_status")
        return query.in_("order_number", list(scoped)) if scoped is not None else query

    orders = fetch_all(_orders_query)

    updated = 0
    for o in orders:
        order_num = str(o.get("order_number") or "").strip()
        shopify_advance = float(o.get("advance_amount") or 0)
        cashbook_advance = cashbook_totals.get(order_num, 0.0)
        new_status = compute_advance_status(shopify_advance, cashbook_advance)
        if o.get("advance_status") != new_status:
            supabase.table("orders").update({"advance_status": new_status}).eq("id", o["id"]).execute()
            updated += 1
    return updated

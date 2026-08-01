"""
Advance reconciliation status helpers.

An order's advance can come from two places:
  - Shopify: stored on orders.advance_amount
  - Cashbook: order-advance credit entries posted to the Orders ledger, tagged with
    the order_number column on cashbook_entries

advance_status (stored on orders.advance_status) reconciles the two:
  1 = no advance amount for the order (both zero)
  2 = Shopify advance present, but no cashbook entry
  3 = cashbook entry present, but no Shopify advance
  4 = advance present in both and they match (within Rs. 5 tolerance)
  5 = advance present in both but they do not match (differ by Rs. 5 or more)
"""
from concurrent.futures import ThreadPoolExecutor
from typing import Dict

from supabase import create_client

from app.config import settings
from app.db_utils import fetch_all
from app.money import money
from app.ledger_roles import get_system_ledger_id
from app.org_scope import org_table

# Cap on order numbers per `.in_()` query - keeps the request URL well under server/proxy
# length limits when scoped to a large set (e.g. every order Shopify returned for a sync).
IN_QUERY_CHUNK_SIZE = 200

# Cap on concurrent threads for the chunked reads/updates below - keeps us from opening too
# many simultaneous connections when scoped to a large set (e.g. a full Shopify sync).
_CONCURRENCY = 20

def get_orders_ledger_id(supabase, org_id: str):
    """The ledger this org posts order advances to, or None if it hasn't set one.

    Was a module-level hardcoded UUID, which predated multi-tenancy: every query
    using it is org-scoped, so for any other org it matched nothing and the
    advance flow silently no-op'd."""
    return get_system_ledger_id(supabase, org_id, "orders")

# Status codes
ADV_NONE = 1
ADV_SHOPIFY_ONLY = 2
ADV_CASHBOOK_ONLY = 3
ADV_MATCH = 4
ADV_MISMATCH = 5

# Amounts within this tolerance count as a match - small discrepancies (rounding,
# manual entry) shouldn't flag every near-equal advance as a mismatch.
MATCH_TOLERANCE = 5

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
    return ADV_MATCH if abs(shopify - cashbook) < MATCH_TOLERANCE else ADV_MISMATCH


def fetch_cashbook_advance_totals(supabase, org_id: str) -> Dict[str, float]:
    """
    Sum order-advance cashbook entries per order number.

    Order-advance entries have the Orders ledger on their From side and carry an order_number.
    Returns a map of order_number (str) -> total advance amount from the cashbook.
    """
    totals: Dict[str, float] = {}
    orders_ledger_id = get_orders_ledger_id(supabase, org_id)
    if not orders_ledger_id:
        return totals

    rows = fetch_all(
        lambda: org_table(supabase, org_id, "cashbook_entries")
        .select("order_number, amount")
        # An advance is money received FROM the Orders account into cash.
        .eq("from_account_id", orders_ledger_id)
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


def recompute_advance_statuses(supabase, org_id: str, order_numbers=None) -> int:
    """
    Recompute and persist advance_status on orders, scoped to org_id.

    If order_numbers is provided (iterable of str), only those orders are recomputed;
    otherwise all orders are recomputed. Returns the number of orders updated.
    """
    cashbook_totals = fetch_cashbook_advance_totals(supabase, org_id)

    # Build the set of order numbers we need to evaluate. When scoped, we still need
    # any order referenced by a cashbook entry even if its number wasn't passed in.
    scoped = None
    if order_numbers is not None:
        scoped = list({str(n).strip() for n in order_numbers if str(n).strip()})

    # courier/order_status/total_amount/order_receiving_date are never read - they only ride
    # along in the upsert payload below. An upsert is INSERT ... ON CONFLICT, and Postgres
    # checks NOT NULL on the proposed row before it resolves the conflict, so every NOT NULL
    # column without a default has to be present even though this only ever updates.
    orders_select = (
        "id, order_number, advance_amount, advance_status, "
        "courier, order_status, total_amount, order_receiving_date"
    )
    if scoped is not None:
        chunks = [scoped[i:i + IN_QUERY_CHUNK_SIZE] for i in range(0, len(scoped), IN_QUERY_CHUNK_SIZE)]
        if len(chunks) > 1:
            # Each chunk gets its own client - sharing one client's HTTP/2 connection across
            # concurrent threads crashes with a stream-read error.
            def fetch_chunk(chunk):
                client = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
                return org_table(client, org_id, "orders").select(orders_select).in_("order_number", chunk).execute().data or []
            with ThreadPoolExecutor(max_workers=min(_CONCURRENCY, len(chunks))) as pool:
                orders = [row for rows in pool.map(fetch_chunk, chunks) for row in rows]
        elif chunks:
            orders = fetch_all(lambda: org_table(supabase, org_id, "orders").select(orders_select).in_("order_number", chunks[0]))
        else:
            orders = []
    else:
        orders = fetch_all(lambda: org_table(supabase, org_id, "orders").select(orders_select))

    to_update = []
    for o in orders:
        order_num = str(o.get("order_number") or "").strip()
        shopify_advance = float(o.get("advance_amount") or 0)
        cashbook_advance = cashbook_totals.get(order_num, 0.0)
        new_status = compute_advance_status(shopify_advance, cashbook_advance)
        if o.get("advance_status") != new_status:
            to_update.append({**o, "advance_status": new_status})

    if to_update:
        # Same batch_size as the orders upserts in shopify_sync.py - chunks a full
        # (unscoped) recompute, which can cover every order in the table.
        batch_size = 1000
        for i in range(0, len(to_update), batch_size):
            org_table(supabase, org_id, "orders").upsert(to_update[i:i + batch_size], on_conflict="id").execute()

    return len(to_update)

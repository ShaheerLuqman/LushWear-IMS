import re
from typing import Tuple


def _order_number_sort_key(order_number) -> Tuple[int, int]:
    """Numeric sort key for an order_number stored as a string.

    order_number is a VARCHAR column, so a plain string sort puts "10000" before
    "9999". Sort by the integer value instead, and keep a replacement order
    ("9865-R") immediately after its parent ("9865") via the secondary key.
    Unparseable values sort first (key 0)."""
    s = str(order_number or "").strip()
    m = re.match(r"^(\d+)(-R)?$", s, re.IGNORECASE)
    if not m:
        return (0, 0)
    return (int(m.group(1)), 1 if m.group(2) else 0)


def _order_recency_key(order: dict):
    """Sort key for "newest first" listings.

    Uses order_receiving_date only. Not order_number: it is a VARCHAR, so any
    DB-side sort is lexicographic ("9999" outranks "11308") and silently returns
    the wrong rows once a LIMIT is applied. Not created_at either: bulk syncs stamp
    thousands of rows with an identical value (10307 orders span only 494 distinct
    created_at values, one cluster holding 3195), so it cannot order rows stably —
    and a non-unique sort column makes OFFSET pagination skip/duplicate rows.
    order_number stays as the tiebreaker so a replacement ("9865-R") sits next to
    its parent.
    """
    return (str(order.get("order_receiving_date") or ""), _order_number_sort_key(order.get("order_number")))

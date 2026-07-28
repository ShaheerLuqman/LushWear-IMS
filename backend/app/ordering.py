def _order_number_sort_key(order_number) -> int:
    """Numeric sort key for order_number. Unparseable/missing values sort first."""
    try:
        return int(order_number)
    except (TypeError, ValueError):
        return 0


def _order_recency_key(order: dict):
    """Sort key for "newest first" listings.

    Uses order_receiving_date as the primary key, with order_number as a stable
    numeric tiebreaker for rows sharing the same date. Not created_at: bulk syncs
    stamp thousands of rows with an identical value (10307 orders span only 494
    distinct created_at values, one cluster holding 3195), so it cannot order rows
    stably - and a non-unique sort column makes OFFSET pagination skip/duplicate rows.
    """
    return (str(order.get("order_receiving_date") or ""), _order_number_sort_key(order.get("order_number")))

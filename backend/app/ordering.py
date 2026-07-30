def _order_number_sort_key(order_number) -> int:
    """Numeric sort key for order_number. Unparseable/missing values sort first."""
    try:
        return int(order_number)
    except (TypeError, ValueError):
        return 0

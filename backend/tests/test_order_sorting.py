from app.routes.orders import _order_number_sort_key, _order_recency_key


def test_sort_key_is_numeric_not_lexicographic():
    # The bug this guards: as strings, "9999" > "11308".
    assert _order_number_sort_key("11308") > _order_number_sort_key("9999")


def test_replacement_sorts_immediately_after_its_parent():
    parent = _order_number_sort_key("9865")
    replacement = _order_number_sort_key("9865-R")
    following = _order_number_sort_key("9866")
    assert parent < replacement < following


def test_replacement_suffix_is_case_insensitive():
    assert _order_number_sort_key("9865-r") == _order_number_sort_key("9865-R")


def test_unparseable_order_numbers_sort_first():
    assert _order_number_sort_key("weird") == (0, 0)
    assert _order_number_sort_key(None) == (0, 0)
    assert _order_number_sort_key("") == (0, 0)


def _sorted_numbers(orders):
    return [o["order_number"] for o in sorted(orders, key=_order_recency_key, reverse=True)]


def test_recency_key_orders_by_receiving_date():
    orders = [
        {"order_number": "100", "order_receiving_date": "2026-07-01T10:00:00+00:00"},
        {"order_number": "101", "order_receiving_date": "2026-07-03T10:00:00+00:00"},
        {"order_number": "102", "order_receiving_date": "2026-07-02T10:00:00+00:00"},
    ]
    assert _sorted_numbers(orders) == ["101", "102", "100"]


def test_order_number_breaks_ties_on_identical_timestamps():
    ts = "2026-07-01T10:00:00+00:00"
    orders = [
        {"order_number": "9865", "order_receiving_date": ts},
        {"order_number": "9866", "order_receiving_date": ts},
        {"order_number": "9865-R", "order_receiving_date": ts},
    ]
    assert _sorted_numbers(orders) == ["9866", "9865-R", "9865"]


def test_missing_receiving_date_sorts_last():
    orders = [
        {"order_number": "100", "order_receiving_date": None},
        {"order_number": "101", "order_receiving_date": "2026-07-01T10:00:00+00:00"},
    ]
    assert _sorted_numbers(orders) == ["101", "100"]

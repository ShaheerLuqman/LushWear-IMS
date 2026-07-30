from app.ordering import _order_number_sort_key


def test_sort_key_is_numeric_not_lexicographic():
    # The bug this guards: as strings, "9999" > "11308".
    assert _order_number_sort_key("11308") > _order_number_sort_key("9999")


def test_sort_key_accepts_int_input():
    # orders.order_number comes back from the DB as int; the request-body
    # variants (bulk actions, packaging list, etc.) may still pass a str.
    assert _order_number_sort_key(9866) > _order_number_sort_key(9865)
    assert _order_number_sort_key(9866) == _order_number_sort_key("9866")


def test_unparseable_order_numbers_sort_first():
    assert _order_number_sort_key("weird") == 0
    assert _order_number_sort_key(None) == 0
    assert _order_number_sort_key("") == 0

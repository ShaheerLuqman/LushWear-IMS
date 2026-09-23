from app.routes.orders import _order_total_from_fulfillments


def _shop_money(amount):
    return {"shop_money": {"amount": amount}}


class TestOrderTotalFromFulfillments:
    def test_returns_none_without_fulfillments(self):
        assert _order_total_from_fulfillments({}) is None
        assert _order_total_from_fulfillments({"fulfillments": []}) is None

    def test_sums_price_times_quantity(self):
        order = {"fulfillments": [
            {"status": "success", "line_items": [
                {"price": "100.00", "quantity": 2},
                {"price": "50.00", "quantity": 1},
            ]}
        ]}
        assert _order_total_from_fulfillments(order) == 250.0

    def test_cancelled_fulfillments_are_excluded(self):
        order = {"fulfillments": [
            {"status": "cancelled", "line_items": [{"price": "999.00", "quantity": 1}]},
            {"status": "success", "line_items": [{"price": "100.00", "quantity": 1}]},
        ]}
        assert _order_total_from_fulfillments(order) == 100.0

    def test_all_cancelled_yields_none(self):
        order = {"fulfillments": [
            {"status": "cancelled", "line_items": [{"price": "999.00", "quantity": 1}]},
        ]}
        assert _order_total_from_fulfillments(order) is None

    def test_adds_shipping_lines(self):
        order = {
            "fulfillments": [{"status": "success", "line_items": [{"price": "100.00", "quantity": 1}]}],
            "shipping_lines": [{"discounted_price": "180.00"}],
        }
        assert _order_total_from_fulfillments(order) == 280.0

    def test_removed_shipping_lines_are_skipped(self):
        order = {
            "fulfillments": [{"status": "success", "line_items": [{"price": "100.00", "quantity": 1}]}],
            "shipping_lines": [{"discounted_price": "180.00", "is_removed": True}],
        }
        assert _order_total_from_fulfillments(order) == 100.0

    def test_order_level_shipping_only_used_when_no_shipping_lines(self):
        # Present-but-removed shipping lines mean delivery was waived deliberately,
        # so the order-level total must not be substituted.
        waived = {
            "fulfillments": [{"status": "success", "line_items": [{"price": "100.00", "quantity": 1}]}],
            "shipping_lines": [{"discounted_price": "0", "is_removed": True}],
            "total_shipping_price_set": _shop_money("180.00"),
        }
        assert _order_total_from_fulfillments(waived) == 100.0

        missing = {
            "fulfillments": [{"status": "success", "line_items": [{"price": "100.00", "quantity": 1}]}],
            "total_shipping_price_set": _shop_money("180.00"),
        }
        assert _order_total_from_fulfillments(missing) == 280.0

    def test_missing_quantity_defaults_to_one(self):
        order = {"fulfillments": [{"status": "success", "line_items": [{"price": "100.00"}]}]}
        assert _order_total_from_fulfillments(order) == 100.0


def test_price_reduction_code_not_double_subtracted_from_net_total():
    from app.services.shopify_sync import _reconcile_one_order
    sp_order = {
        "order_number": 14120,
        "total_line_items_price": "5998.00",
        "current_total_price": "5398.20",
        "current_total_discounts": "599.80",
        "discount_codes": [{"code": "Get10off", "amount": "599.80"}],
        "financial_status": "pending",
        "line_items": [{"price": "2999.00", "quantity": 2, "title": "X"}],
    }
    r = _reconcile_one_order(sp_order, {}, {}, {}, {}, {}, {}, "2026-09-23T00:00:00Z")
    assert r.order_data["total_amount"] == 5398.2
    assert r.order_data["advance_amount"] == 0.0

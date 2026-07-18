from app.routes.orders import _compute_shopify_tax, _order_total_from_fulfillments


def _shop_money(amount):
    return {"shop_money": {"amount": amount}}


class TestShopifyTax:
    def test_prefers_current_total_tax_set(self):
        order = {
            "current_total_tax_set": _shop_money("15.00"),
            "current_total_tax": "99.00",
            "total_tax_set": _shop_money("88.00"),
            "total_tax": "77.00",
        }
        assert _compute_shopify_tax(order) == 15.00

    def test_current_total_tax_beats_the_legacy_fields(self):
        assert _compute_shopify_tax({"current_total_tax": "20.00", "total_tax": "9.00"}) == 20.00

    def test_absent_current_total_tax_short_circuits_to_zero(self):
        # Documents existing sync behaviour rather than endorsing it: the
        # `float(order.get("current_total_tax") or 0)` branch returns 0.0 when the key
        # is missing, so total_tax_set / total_tax are never reached. Changing this
        # would move tax values on synced orders, so it is left alone here.
        assert _compute_shopify_tax({"total_tax_set": _shop_money("30.00"), "total_tax": "9.00"}) == 0.0
        assert _compute_shopify_tax({"total_tax": "40.00"}) == 0.0
        assert _compute_shopify_tax({}) == 0.0

    def test_total_tax_set_is_reached_when_current_total_tax_is_unparseable(self):
        order = {"current_total_tax": "abc", "total_tax_set": _shop_money("30.00")}
        assert _compute_shopify_tax(order) == 30.00

    def test_unparseable_values_do_not_raise(self):
        assert _compute_shopify_tax({"total_tax": "abc"}) == 0.0


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

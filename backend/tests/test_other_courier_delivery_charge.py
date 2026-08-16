from app.services.shopify_sync import _delivery_charge_from_other_tags


class TestDeliveryChargeFromOtherTags:
    def test_extracts_number_from_a_matching_tag(self):
        assert _delivery_charge_from_other_tags("Other", "Bykea 300, Confirmed") == 300.0

    def test_courier_must_be_other(self):
        assert _delivery_charge_from_other_tags("PostEx", "Bykea 300") is None
        assert _delivery_charge_from_other_tags(None, "Bykea 300") is None

    def test_case_insensitive_courier(self):
        assert _delivery_charge_from_other_tags("other", "Bykea 300") == 300.0

    def test_decimal_charge(self):
        assert _delivery_charge_from_other_tags("Other", "Bykea 300.50") == 300.5

    def test_multi_word_name(self):
        assert _delivery_charge_from_other_tags("Other", "Trax Rider 250") == 250.0

    def test_tag_is_matched_regardless_of_position_among_other_tags(self):
        assert _delivery_charge_from_other_tags("Other", "✅ Order Confirmed, Bykea 300, VIP") == 300.0

    def test_surrounding_whitespace_is_ignored(self):
        assert _delivery_charge_from_other_tags("Other", "  Bykea   300  ") == 300.0

    def test_other_tags_are_not_mistaken_for_a_name_plus_charge(self):
        # Real order tags seen in the wild - none should parse as a charge.
        assert _delivery_charge_from_other_tags("Other", "✅ Order Confirmed") is None
        assert _delivery_charge_from_other_tags("Other", "Cancellation Notified, ⚠ Confirmation Pending") is None

    def test_name_without_a_trailing_number_returns_none(self):
        assert _delivery_charge_from_other_tags("Other", "Bykea") is None

    def test_name_glued_to_digits_without_a_space_is_not_parsed(self):
        assert _delivery_charge_from_other_tags("Other", "Bykea300") is None

    def test_number_leading_tag_is_not_parsed(self):
        # Enforces "<name> <number>", not the reverse - matches the agreed tag shape.
        assert _delivery_charge_from_other_tags("Other", "300 Bykea") is None

    def test_empty_or_missing_tags(self):
        assert _delivery_charge_from_other_tags("Other", "") is None
        assert _delivery_charge_from_other_tags("Other", None) is None

    def test_non_string_tags_value_does_not_crash(self):
        # Shopify's tags field is a comma-separated string in REST; a non-string value
        # (e.g. a list, from some other response shape) is coerced via str() rather than
        # crashing - it just won't parse into a real tag match.
        assert _delivery_charge_from_other_tags("Other", ["Bykea 300"]) is None

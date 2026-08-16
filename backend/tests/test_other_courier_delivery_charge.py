from app.services.shopify_sync import _delivery_charge_from_other_tracking


class TestDeliveryChargeFromOtherTracking:
    def test_extracts_trailing_number_after_a_name(self):
        assert _delivery_charge_from_other_tracking("Other", "Bykea 300") == 300.0

    def test_courier_must_be_other(self):
        assert _delivery_charge_from_other_tracking("PostEx", "Bykea 300") is None
        assert _delivery_charge_from_other_tracking(None, "Bykea 300") is None

    def test_case_insensitive_courier(self):
        assert _delivery_charge_from_other_tracking("other", "Bykea 300") == 300.0

    def test_decimal_charge(self):
        assert _delivery_charge_from_other_tracking("Other", "Bykea 300.50") == 300.5

    def test_multi_word_name(self):
        assert _delivery_charge_from_other_tracking("Other", "Trax Rider 250") == 250.0

    def test_surrounding_whitespace_is_ignored(self):
        assert _delivery_charge_from_other_tracking("Other", "  Bykea   300  ") == 300.0

    def test_plain_numeric_tracking_number_is_not_a_name_plus_charge(self):
        # A real courier tracking id (all digits, no name) must not be misread as a charge.
        assert _delivery_charge_from_other_tracking("Other", "202370601123") is None

    def test_name_without_a_trailing_number_returns_none(self):
        assert _delivery_charge_from_other_tracking("Other", "Bykea") is None

    def test_name_glued_to_digits_without_a_space_is_not_parsed(self):
        assert _delivery_charge_from_other_tracking("Other", "Bykea300") is None

    def test_empty_or_missing_tracking_number(self):
        assert _delivery_charge_from_other_tracking("Other", "") is None
        assert _delivery_charge_from_other_tracking("Other", None) is None

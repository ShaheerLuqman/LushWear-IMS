from app.services.shopify_sync import _other_courier_delivery_charge, _synced_delivery_charge


class TestOtherCourierDeliveryCharge:
    def test_extracts_number_from_a_matching_tag(self):
        assert _other_courier_delivery_charge("Other", None, "Bykea 300, Confirmed") == 300.0

    def test_courier_must_be_other(self):
        assert _other_courier_delivery_charge("PostEx", None, "Bykea 300") is None
        assert _other_courier_delivery_charge(None, None, "Bykea 300") is None

    def test_case_insensitive_courier(self):
        assert _other_courier_delivery_charge("other", None, "Bykea 300") == 300.0

    def test_decimal_charge(self):
        assert _other_courier_delivery_charge("Other", None, "Bykea 300.50") == 300.5

    def test_multi_word_name(self):
        assert _other_courier_delivery_charge("Other", None, "Trax Rider 250") == 250.0

    def test_tag_is_matched_regardless_of_position_among_other_tags(self):
        assert _other_courier_delivery_charge("Other", None, "✅ Order Confirmed, Bykea 300, VIP") == 300.0

    def test_surrounding_whitespace_is_ignored(self):
        assert _other_courier_delivery_charge("Other", None, "  Bykea   300  ") == 300.0

    def test_other_tags_are_not_mistaken_for_a_name_plus_charge(self):
        # Real order tags seen in the wild - none should parse as a charge.
        assert _other_courier_delivery_charge("Other", None, "✅ Order Confirmed") is None
        assert _other_courier_delivery_charge("Other", None, "Cancellation Notified, ⚠ Confirmation Pending") is None

    def test_name_without_a_trailing_number_returns_none(self):
        assert _other_courier_delivery_charge("Other", None, "Bykea") is None

    def test_name_glued_to_digits_without_a_space_is_not_parsed(self):
        assert _other_courier_delivery_charge("Other", None, "Bykea300") is None

    def test_number_leading_tag_is_not_parsed(self):
        # Enforces "<name> <number>", not the reverse - matches the agreed tag shape.
        assert _other_courier_delivery_charge("Other", None, "300 Bykea") is None

    def test_empty_or_missing_tags(self):
        assert _other_courier_delivery_charge("Other", None, "") is None
        assert _other_courier_delivery_charge("Other", None, None) is None

    def test_non_string_tags_value_does_not_crash(self):
        # Shopify's tags field is a comma-separated string in REST; a non-string value
        # (e.g. a list, from some other response shape) is coerced via str() rather than
        # crashing - it just won't parse into a real tag match.
        assert _other_courier_delivery_charge("Other", None, ["Bykea 300"]) is None

    def test_extracts_number_from_the_tracking_number(self):
        assert _other_courier_delivery_charge("Other", "Bykea 300", "") == 300.0

    def test_tracking_number_wins_over_a_tag(self):
        assert _other_courier_delivery_charge("Other", "Bykea 300", "Bykea 250") == 300.0

    def test_falls_back_to_tag_when_tracking_number_carries_no_charge(self):
        assert _other_courier_delivery_charge("Other", "Bykea", "Bykea 250") == 250.0
        assert _other_courier_delivery_charge("Other", "111111", "Bykea 250") == 250.0

    def test_zero_charge_returns_none_so_a_manual_dc_is_kept(self):
        assert _other_courier_delivery_charge("Other", "Bykea 0", "") is None
        assert _other_courier_delivery_charge("Other", None, "Self 0") is None

    def test_tracking_number_ignored_for_other_couriers(self):
        assert _other_courier_delivery_charge("PostEx", "Bykea 300", "") is None


class TestSyncedDeliveryCharge:
    """What the sync writes as delivery_charge: None = not entered, 0 = entered as zero."""
    FIXED = {"scs": 180.0}

    def test_fixed_charge_fills_only_a_charge_never_entered(self):
        assert _synced_delivery_charge("SCS", None, "", None, self.FIXED) == 180.0
        assert _synced_delivery_charge("SCS", None, "", 0, self.FIXED) == 0.0
        assert _synced_delivery_charge("SCS", None, "", 150, self.FIXED) == 150.0

    def test_no_fixed_charge_leaves_it_not_entered(self):
        assert _synced_delivery_charge("PostEx", None, "", None, self.FIXED) is None

    def test_other_courier_tag_still_wins(self):
        assert _synced_delivery_charge("Other", None, "Bykea 300", 220, self.FIXED) == 300.0

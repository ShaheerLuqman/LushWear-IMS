import pytest

from app.advance_status import (
    ADV_CASHBOOK_ONLY,
    ADV_MATCH,
    ADV_MISMATCH,
    ADV_NONE,
    ADV_SHOPIFY_ONLY,
    compute_advance_status,
)


@pytest.mark.parametrize("shopify,cashbook,expected", [
    (0, 0, ADV_NONE),
    (None, None, ADV_NONE),
    (500, 0, ADV_SHOPIFY_ONLY),
    (0, 500, ADV_CASHBOOK_ONLY),
    (500, 500, ADV_MATCH),
    (500, 250, ADV_MISMATCH),
])
def test_status_codes(shopify, cashbook, expected):
    assert compute_advance_status(shopify, cashbook) == expected


def test_sub_cent_float_noise_still_matches():
    # Values that differ only by float representation must not read as a mismatch.
    assert compute_advance_status(1522.20, 1522.1999999999998) == ADV_MATCH


def test_one_cent_difference_is_a_mismatch():
    assert compute_advance_status(500.00, 500.01) == ADV_MISMATCH


def test_amounts_are_rounded_before_comparing():
    # 500.004 and 500.001 both round to 500.00.
    assert compute_advance_status(500.004, 500.001) == ADV_MATCH


def test_sub_cent_amount_counts_as_no_advance():
    # 0.004 rounds to 0.00, so neither side has an advance.
    assert compute_advance_status(0.004, 0) == ADV_NONE


def test_negative_advance_is_treated_as_present():
    assert compute_advance_status(-100, 0) == ADV_SHOPIFY_ONLY

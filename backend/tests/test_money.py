import pytest

from app.money import money


@pytest.mark.parametrize("value,expected", [
    (2248, 2248.0),
    (2248.0, 2248.0),
    ("123.456", 123.46),
    (None, 0.0),
    ("", 0.0),
    ("not-a-number", 0.0),
])
def test_money_coerces_and_rounds(value, expected):
    assert money(value) == expected


def test_money_normalises_float_artifacts():
    # 1522.1999999999998 is what float subtraction produces for 2248.10-(500.20+180.30+45.40)
    assert money(2248.10 - (500.20 + 180.30 + 45.40)) == 1522.20
    assert money(0.1 + 0.2) == 0.3


def test_money_rounds_half_up_not_bankers():
    # round() is round-half-to-even: round(2.675, 2) == 2.67. Currency rounds half up.
    assert money(2.675) == 2.68
    assert money(0.005) == 0.01
    assert money(-180.005) == -180.01


def test_money_returns_float_so_json_stays_numeric():
    assert isinstance(money("10.00"), float)


def test_money_is_idempotent():
    once = money(1522.1999999999998)
    assert money(once) == once

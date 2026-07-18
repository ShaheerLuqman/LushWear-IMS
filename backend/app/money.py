from decimal import Decimal, ROUND_HALF_UP

_CENT = Decimal("0.01")


def money(value) -> float:
    """Round a monetary value to 2 decimals.

    Python's round() uses banker's rounding (round-half-to-even), so round(2.675, 2)
    gives 2.67. Decimal with ROUND_HALF_UP matches how currency is normally rounded
    and how Postgres stores DECIMAL(_, 2).

    Returns float so JSON responses keep emitting numbers, not strings.
    """
    if value is None:
        return 0.0
    try:
        return float(Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP))
    except (TypeError, ValueError, ArithmeticError):
        return 0.0

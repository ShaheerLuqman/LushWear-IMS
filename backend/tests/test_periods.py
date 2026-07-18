from app.routes.orders import _period_start_end, _period_start_end_dates


def test_period_runs_22nd_to_next_22nd_exclusive():
    # PKT is UTC+5, so 22nd 00:00 PKT == 21st 19:00 UTC.
    start, end = _period_start_end(6, 2026)
    assert start == "2026-06-21T19:00:00Z"
    assert end == "2026-07-21T19:00:00Z"


def test_december_period_rolls_into_next_year():
    start, end = _period_start_end(12, 2026)
    assert start == "2026-12-21T19:00:00Z"
    assert end == "2027-01-21T19:00:00Z"


def test_periods_are_contiguous_with_no_gap_or_overlap():
    _, june_end = _period_start_end(6, 2026)
    july_start, _ = _period_start_end(7, 2026)
    assert june_end == july_start


def test_period_dates_helper():
    assert _period_start_end_dates(6, 2026) == ("2026-06-22", "2026-07-21")
    assert _period_start_end_dates(12, 2026) == ("2026-12-22", "2027-01-21")


def test_every_month_produces_a_start_before_its_end():
    for month in range(1, 13):
        start, end = _period_start_end(month, 2026)
        assert start < end

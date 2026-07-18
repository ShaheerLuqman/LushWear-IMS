import pytest

from app.paths import ASSETS_DIR
from app.services.pdf.load_sheet import _generate_pdf_load_sheet


def _order(number, **overrides):
    row = {
        "order_number": number,
        "courier": "PostEx",
        "tracking_number": "12345678901234",
        "order_status": "fulfilled",
        "total_amount": 2598.0,
        "advance_amount": 0.0,
        "delivery_charge": 180.0,
        "tax_amount": 0.0,
        "order_receiving_date": "2026-07-18T13:23:08+00:00",
        "items": ["Camisole - M"],
        "line_items": None,
    }
    row.update(overrides)
    return row


@pytest.mark.parametrize("asset", ["logo_load_sheet.png", "logo_invoice.png"])
def test_bundled_assets_are_present(asset):
    # A missing asset does not raise — the PDF just renders without the logo and a
    # warning is logged — so assert the paths resolve rather than relying on that.
    assert (ASSETS_DIR / asset).exists()


def test_generates_a_pdf():
    pdf = _generate_pdf_load_sheet([_order("11308")], None).getvalue()
    assert pdf.startswith(b"%PDF")


def test_assignment_and_rider_are_accepted():
    pdf = _generate_pdf_load_sheet(
        [_order("11308")], None, assignment_number="AS-1", rider_name="Test Rider"
    ).getvalue()
    assert pdf.startswith(b"%PDF")


def test_orders_are_sorted_numerically_not_lexicographically():
    # Guards the VARCHAR trap: "9999" must not outrank "11308" on the sheet.
    orders = [_order("9999"), _order("11308"), _order("10000")]
    _generate_pdf_load_sheet(orders, None)
    assert [o["order_number"] for o in orders] == ["9999", "10000", "11308"]


def test_empty_order_list_does_not_raise():
    assert _generate_pdf_load_sheet([], None).getvalue().startswith(b"%PDF")

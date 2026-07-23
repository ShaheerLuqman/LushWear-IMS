from app.paths import ASSETS_DIR
from app.services.pdf.invoice import (
    _build_invoice_order_context,
    _consignee_from_shopify_order,
    _format_shopify_address,
    _generate_pdf_invoice,
    _invoice_pieces_from_shopify,
    _line_items_from_db_items,
    _line_items_from_shopify_order,
    _load_invoice_shipper_defaults,
    _tracking_from_shopify_order,
)


def _db_order(**overrides):
    row = {
        "order_number": "11308",
        "courier": "PostEx",
        "tracking_number": "12345678901234",
        "order_status": "fulfilled",
        "total_amount": 2598.0,
        "advance_amount": 0.0,
        "delivery_charge": 180.0,
        "tax_amount": 0.0,
        "order_receiving_date": "2026-07-18T13:23:08+00:00",
        "line_items": [{"name": "Camisole", "variant_title": "M", "qty": 1, "unit_price": 2598.0}],
    }
    row.update(overrides)
    return row


class TestAssets:
    def test_invoice_logo_and_shipper_json_resolve(self):
        # Both moved into app/assets during the refactor; a missing file degrades
        # silently (no logo / hardcoded defaults), so assert the paths.
        assert (ASSETS_DIR / "logo_invoice.png").exists()
        assert (ASSETS_DIR / "invoice.json").exists()

    def test_shipper_defaults_load_from_assets(self):
        shipper = _load_invoice_shipper_defaults()
        assert shipper["name"]
        assert shipper["contact"]
        assert shipper["pickup_address"]


class TestShopifyShaping:
    def test_address_formatting_skips_blank_parts(self):
        addr = {"address1": "12 Main St", "address2": "", "city": "Karachi", "province": None}
        formatted = _format_shopify_address(addr)
        assert "12 Main St" in formatted and "Karachi" in formatted
        assert ", ," not in formatted

    def test_missing_address_is_empty(self):
        assert _format_shopify_address(None) == ""

    def test_consignee_falls_back_across_address_fields(self):
        order = {
            "shipping_address": {"name": "Wasif Khan", "phone": "0348", "address1": "Barikot", "city": "Swat"},
        }
        name, contact, address = _consignee_from_shopify_order(order)
        assert name == "Wasif Khan"
        assert contact == "0348"
        assert "Barikot" in address

    def test_tracking_comes_from_the_latest_fulfillment(self):
        order = {"fulfillments": [
            {"status": "success", "tracking_number": "111", "created_at": "2026-07-01T00:00:00Z"},
            {"status": "success", "tracking_number": "222", "created_at": "2026-07-05T00:00:00Z"},
        ]}
        assert _tracking_from_shopify_order(order) == "222"

    def test_tracking_absent_without_fulfillments(self):
        assert _tracking_from_shopify_order({}) is None

    def test_line_items_exclude_removed_lines(self):
        order = {"line_items": [
            {"title": "Kept", "variant_title": "M", "quantity": 2, "current_quantity": 2},
            {"title": "Removed", "variant_title": "S", "quantity": 1, "current_quantity": 0},
        ]}
        names = [li["product"] for li in _line_items_from_shopify_order(order)]
        assert names == ["Kept"]

    def test_pieces_counts_units_not_lines(self):
        order = {"line_items": [
            {"title": "A", "quantity": 2, "current_quantity": 2},
            {"title": "B", "quantity": 3, "current_quantity": 3},
        ]}
        assert _invoice_pieces_from_shopify(order) == 5


class TestDbFallback:
    def test_line_items_from_db_line_items(self):
        order = _db_order(line_items=[
            {"name": "Camisole", "variant_title": "M", "qty": 1, "unit_price": 100},
            {"name": "Robe", "variant_title": "L", "qty": 1, "unit_price": 200},
        ])
        rows = _line_items_from_db_items(order)
        assert [r["product"] for r in rows] == ["Camisole", "Robe"]

    def test_context_builds_without_a_shopify_order(self):
        # The invoice must still render when Shopify is unreachable or the order
        # predates the sync window; the DB row alone has to be enough.
        ctx = _build_invoice_order_context(_db_order(), None)
        assert ctx["invoice_order_ref"] == "#11308"
        assert ctx["invoice_line_items"]
        assert ctx["invoice_pieces"] >= 1


class TestPdf:
    def test_renders_a_pdf_from_db_only_context(self):
        ctx = _build_invoice_order_context(_db_order(), None)
        assert _generate_pdf_invoice([ctx]).getvalue().startswith(b"%PDF")

    def test_renders_multiple_orders(self):
        ctxs = [
            _build_invoice_order_context(_db_order(order_number="1"), None),
            _build_invoice_order_context(_db_order(order_number="2"), None),
        ]
        assert _generate_pdf_invoice(ctxs).getvalue().startswith(b"%PDF")

from app.services.pdf.packaging_list import (
    _aggregate_packaging_items,
    _generate_pdf_packaging_list,
    _normalize_size,
    _order_line_rows,
    _split_item_name,
)


class TestSplitItemName:
    def test_splits_on_the_last_separator(self):
        assert _split_item_name("Magenta Camisole - Set - M") == ("Magenta Camisole - Set", "M")

    def test_missing_separator_yields_placeholder_variant(self):
        assert _split_item_name("Plain Product") == ("Plain Product", "-")

    def test_blank_input(self):
        assert _split_item_name("") == ("", "-")
        assert _split_item_name(None) == ("", "-")


class TestOrderLineRows:
    def test_prefers_structured_line_items(self):
        order = {
            "line_items": [
                {"name": "Camisole", "variant_title": "M", "qty": 3, "product_id": "p1", "unit_price": 100},
            ],
            "items": ["Should Be Ignored - S"],
        }
        rows = _order_line_rows(order)
        assert len(rows) == 1
        assert rows[0]["product"] == "Camisole"
        assert rows[0]["quantity"] == 3

    def test_falls_back_to_legacy_items_one_unit_each(self):
        order = {"line_items": None, "items": ["Camisole - M", "Camisole - M", "Robe - L"]}
        rows = _order_line_rows(order)
        assert [r["quantity"] for r in rows] == [1, 1, 1]
        assert rows[0]["product"] == "Camisole"

    def test_zero_and_negative_quantities_are_dropped(self):
        order = {"line_items": [
            {"name": "Removed", "qty": 0},
            {"name": "Kept", "qty": 2},
        ]}
        assert [r["product"] for r in _order_line_rows(order)] == ["Kept"]

    def test_empty_order_yields_no_rows(self):
        assert _order_line_rows({}) == []


class TestNormalizeSize:
    def test_uppercases_and_trims(self):
        assert _normalize_size(" m ") == "M"

    def test_placeholder_and_blank_become_dash(self):
        assert _normalize_size("-") == "-"
        assert _normalize_size("") == "-"
        assert _normalize_size(None) == "-"


class TestAggregate:
    def test_counts_per_product_and_size_across_orders(self):
        orders = [
            {"line_items": [{"name": "Camisole", "variant_title": "M", "qty": 2}]},
            {"line_items": [{"name": "Camisole", "variant_title": "M", "qty": 1},
                            {"name": "Robe", "variant_title": "L", "qty": 4}]},
        ]
        rows, sizes = _aggregate_packaging_items(orders)
        by_product = {r["product"]: r for r in rows}
        assert by_product["Camisole"]["sizes"]["M"] == 3
        assert by_product["Camisole"]["total"] == 3
        assert by_product["Robe"]["total"] == 4
        assert sizes[:4] == ["S", "M", "L", "XL"]

    def test_unusual_sizes_are_appended_after_the_base_columns(self):
        orders = [{"line_items": [{"name": "PJ", "variant_title": "Free Size", "qty": 1}]}]
        _, sizes = _aggregate_packaging_items(orders)
        assert sizes[:4] == ["S", "M", "L", "XL"]
        assert "FREE SIZE" in sizes

    def test_products_are_sorted_case_insensitively(self):
        orders = [{"line_items": [
            {"name": "zebra", "variant_title": "S", "qty": 1},
            {"name": "Apple", "variant_title": "S", "qty": 1},
        ]}]
        rows, _ = _aggregate_packaging_items(orders)
        assert [r["product"] for r in rows] == ["Apple", "zebra"]


class TestPdf:
    def test_produces_a_pdf(self):
        orders = [{"line_items": [{"name": "Camisole", "variant_title": "M", "qty": 2}]}]
        rows, sizes = _aggregate_packaging_items(orders)
        assert _generate_pdf_packaging_list(rows, sizes, len(orders)).getvalue().startswith(b"%PDF")

    def test_handles_no_items_without_raising(self):
        rows, sizes = _aggregate_packaging_items([])
        assert _generate_pdf_packaging_list(rows, sizes, 0).getvalue().startswith(b"%PDF")

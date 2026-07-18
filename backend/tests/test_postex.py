import pytest

from app.services import postex


class TestParseFloat:
    @pytest.mark.parametrize("raw,expected", [
        ("180", 180.0),
        ("1,200.50", 1200.5),   # Excel thousands separator
        ("2%", 2.0),            # withholding columns are sometimes "2%"
        ("  30.6  ", 30.6),
    ])
    def test_parses_messy_cells(self, raw, expected):
        assert postex.parse_float(raw) == expected

    def test_blank_and_invalid_fall_back_to_default(self):
        assert postex.parse_float("") == 0.0
        assert postex.parse_float(None) == 0.0
        assert postex.parse_float("abc") == 0.0
        assert postex.parse_float("", None) is None


class TestNormalizeOrderNumber:
    @pytest.mark.parametrize("raw,expected", [
        ("#4807", "4807"),
        ("4807", "4807"),
        ("0012", "12"),          # leading zeros are dropped
        (4807, "4807"),          # numeric cell
        (4807.0, "4807"),
        ("4446-R", "4446-R"),    # replacement orders keep the suffix
        ("#9865-r", "9865-R"),   # and are upper-cased
        ("order 4807", "4807"),
    ])
    def test_extracts_the_order_number(self, raw, expected):
        assert postex.normalize_order_number(raw) == expected

    def test_returns_none_when_there_is_no_number(self):
        assert postex.normalize_order_number("BADREF") is None
        assert postex.normalize_order_number("") is None
        assert postex.normalize_order_number(None) is None


class TestParseTrackingNumber:
    def test_expands_excel_exponential_notation(self):
        # Excel mangles long tracking numbers into "2.63E+13".
        assert postex.parse_tracking_number_14("2.63E+13") == "26300000000000"
        assert postex.parse_tracking_number_14("5.5E+13") == "55000000000000"

    def test_pads_short_numbers_to_14_digits(self):
        assert postex.parse_tracking_number_14("123") == "00000000000123"

    def test_keeps_a_full_length_number_as_is(self):
        assert postex.parse_tracking_number_14("26300000000123") == "26300000000123"

    def test_preserves_already_padded_values(self):
        assert postex.parse_tracking_number_14("00026300000001") == "00026300000001"

    def test_unparseable_values_yield_none(self):
        assert postex.parse_tracking_number_14("abc") is None
        assert postex.parse_tracking_number_14("") is None
        assert postex.parse_tracking_number_14(None) is None


class TestColumnMap:
    def test_matches_spaced_and_underscored_headers(self):
        spaced = postex.build_column_map(
            ["ORDER_REF_NUMBER", "SHIPPING_CHARGES", "GST", "WH INCOME TAX (2%)", "WH SALES TAX (2%)"]
        )
        underscored = postex.build_column_map(
            ["ORDER_REF_NUMBER", "SHIPPING_CHARGES", "GST", "WH_INCOME_TAX (2%)", "WH_SALES_TAX (2%)"]
        )
        assert spaced["wh_income_tax"] == "WH INCOME TAX (2%)"
        assert underscored["wh_income_tax"] == "WH_INCOME_TAX (2%)"

    def test_gst_does_not_swallow_the_tax_columns(self):
        col_map = postex.build_column_map(["GST", "WH SALES TAX (2%)"])
        assert col_map["gst"] == "GST"
        assert col_map["wh_sales_tax"] == "WH SALES TAX (2%)"

    def test_accepts_order_number_and_order_id_aliases(self):
        assert "order_ref_number" in postex.build_column_map(["ORDER_NUMBER"])
        assert "order_ref_number" in postex.build_column_map(["ORDER_ID"])

    def test_original_spacing_is_preserved_for_dictreader_lookups(self):
        col_map = postex.build_column_map([" Shipping_Charges "])
        assert col_map["shipping_charges"] == " Shipping_Charges "


CSV = (
    b"ORDER_REF_NUMBER,SHIPPING_CHARGES,GST,WH INCOME TAX (2%),WH SALES TAX (2%),TRACKING_NUMBER,NET_AMOUNT\n"
    b"#4807,180,30.6,12.5,5.5,2.63E+13,2400.50\n"
    b"4446-R,180,30.6,0,0,00026300000001,1200\n"
    b",180,30,0,0,999,10\n"
)


class TestParseRows:
    def test_parses_and_totals_the_fee_columns(self):
        rows, nums = postex.parse_rows(CSV)
        assert nums == ["4807", "4446-R"]
        first = rows[0]
        assert first["delivery_charge"] == 210.6   # shipping + GST
        assert first["tax_amount"] == 18.0         # income + sales withholding
        assert first["tracking_number"] == "26300000000000"
        assert first["csv_net_amount"] == 2400.5

    def test_rows_without_an_order_reference_are_skipped(self):
        rows, _ = postex.parse_rows(CSV)
        assert len(rows) == 2

    def test_tolerates_a_utf8_bom(self):
        rows, _ = postex.parse_rows(b"\xef\xbb\xbf" + CSV)
        assert len(rows) == 2

    def test_missing_header_is_rejected(self):
        with pytest.raises(postex.CsvFormatError):
            postex.parse_rows(b"")

    def test_missing_required_columns_are_rejected(self):
        with pytest.raises(postex.CsvFormatError, match="ORDER_REF_NUMBER"):
            postex.parse_rows(b"FOO,BAR\n1,2\n")
        with pytest.raises(postex.CsvFormatError, match="SHIPPING_CHARGES"):
            postex.parse_rows(b"ORDER_REF_NUMBER\n4807\n")

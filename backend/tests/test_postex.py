import asyncio

import httpx
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


class TestNormalizePhone:
    @pytest.mark.parametrize("raw,expected", [
        ("03001234567", "03001234567"),
        ("0300-1234567", "03001234567"),      # customer-typed separators
        ("+92 300 1234567", "03001234567"),   # what Shopify usually stores
        ("923001234567", "03001234567"),
        ("00923001234567", "03001234567"),
        ("3001234567", "03001234567"),        # leading zero dropped by a spreadsheet
    ])
    def test_coerces_to_postex_local_format(self, raw, expected):
        assert postex.normalize_phone(raw) == expected

    @pytest.mark.parametrize("raw", ["", None, "12345", "+92 21 35678901", "0300123456789"])
    def test_rejects_what_cannot_be_a_mobile_number(self, raw):
        # None means "don't book this parcel", not "send it anyway".
        assert postex.normalize_phone(raw) is None


class TestCreateOrder:
    """create_order is async; driven with plain asyncio.run since this repo has no
    pytest-asyncio (same convention as test_auth.py's TestRequireRole)."""

    BOOKING = {
        "order_ref_number": "4807",
        "customer_name": "Ayesha Khan",
        "customer_phone": "03001234567",
        "delivery_address": "12 Main Boulevard, Gulberg",
        "city_name": "Lahore",
        "invoice_payment": 4500.0,
        "items": 2,
        "pickup_address_code": "002",
    }

    @staticmethod
    def _client(monkeypatch, response_json, captured=None):
        class _Response:
            status_code = 200

            def json(self):
                return response_json

        class _Client:
            async def post(self, url, headers=None, json=None):
                if captured is not None:
                    captured.update({"url": url, "headers": headers, "json": json})
                return _Response()

        return _Client()

    def test_returns_the_tracking_number_and_sends_the_documented_shape(self, monkeypatch):
        captured = {}
        client = self._client(monkeypatch, {
            "statusCode": "200",
            "statusMessage": "ORDER HAS BEEN CREATED",
            "dist": {"trackingNumber": "CX123456789012"},
        }, captured)

        tracking = asyncio.run(postex.create_order(client, "tok", **self.BOOKING))

        assert tracking == "CX123456789012"
        assert captured["headers"]["token"] == "tok"
        assert captured["url"].endswith("/v3/create-order")
        assert captured["json"]["orderRefNumber"] == "4807"
        assert captured["json"]["cityName"] == "Lahore"
        assert captured["json"]["orderType"] == "Normal"
        assert captured["json"]["items"] == 2
        # Required in practice even though the guide marks it optional - PostEx rejects
        # a booking that names neither a pickup nor a store address code.
        assert captured["json"]["pickupAddressCode"] == "002"

    def test_order_type_is_sent_as_picked(self):
        captured = {}
        client = self._client(None, {"statusCode": "200", "dist": {"trackingNumber": "CX1"}}, captured)

        asyncio.run(postex.create_order(client, "tok", **{**self.BOOKING, "order_type": "Replacement"}))

        assert captured["json"]["orderType"] == "Replacement"

    def test_invoice_payment_is_rounded_to_whole_rupees(self):
        captured = {}
        client = self._client(None, {"statusCode": "200", "dist": {"trackingNumber": "CX1"}}, captured)

        asyncio.run(postex.create_order(client, "tok", **{**self.BOOKING, "invoice_payment": 4499.6}))

        assert captured["json"]["invoicePayment"] == 4500

    def test_optional_fields_are_omitted_rather_than_sent_empty(self):
        captured = {}
        client = self._client(None, {"statusCode": "200", "dist": {"trackingNumber": "CX1"}}, captured)

        asyncio.run(postex.create_order(client, "tok", **self.BOOKING))

        assert "orderDetail" not in captured["json"]

    def test_a_rejection_raises_with_postex_own_message(self):
        client = self._client(None, {"statusCode": "422", "statusMessage": "City is not serviceable"})

        with pytest.raises(postex.PostexBookingError, match="City is not serviceable"):
            asyncio.run(postex.create_order(client, "tok", **self.BOOKING))

    def test_a_success_without_a_tracking_number_is_still_an_error(self):
        # Booked but unmatchable downstream - must not be recorded as fulfilled.
        client = self._client(None, {"statusCode": "200", "dist": {}})

        with pytest.raises(postex.PostexBookingError):
            asyncio.run(postex.create_order(client, "tok", **self.BOOKING))


class TestGetAirwayBill:
    """get_airway_bill is async; driven with plain asyncio.run, same convention as
    TestCreateOrder above."""

    @staticmethod
    def _client(pdf_bytes=b"%PDF-1.4 fake", status_code=200, json_body=None, captured=None):
        class _Response:
            def __init__(self):
                self.status_code = status_code
                self.content = pdf_bytes

            def json(self):
                if json_body is None:
                    raise ValueError("not json")
                return json_body

        class _Client:
            async def get(self, url, headers=None, params=None):
                if captured is not None:
                    captured.update({"url": url, "headers": headers, "params": params})
                return _Response()

        return _Client()

    def test_returns_the_pdf_bytes_and_sends_the_documented_shape(self):
        captured = {}
        client = self._client(pdf_bytes=b"%PDF-1.4 the bytes", captured=captured)

        pdf = asyncio.run(postex.get_airway_bill(client, "tok", ["CX-1", "CX-2"]))

        assert pdf == b"%PDF-1.4 the bytes"
        assert captured["url"].endswith("/v1/get-invoice")
        assert captured["headers"]["token"] == "tok"
        assert captured["params"]["trackingNumbers"] == "CX-1,CX-2"

    def test_more_than_ten_tracking_numbers_is_rejected_before_calling(self):
        client = self._client()

        with pytest.raises(postex.PostexInvoiceError, match="10"):
            asyncio.run(postex.get_airway_bill(client, "tok", [f"CX-{i}" for i in range(11)]))

    def test_no_tracking_numbers_is_rejected(self):
        client = self._client()

        with pytest.raises(postex.PostexInvoiceError):
            asyncio.run(postex.get_airway_bill(client, "tok", []))

    def test_a_non_200_response_raises_with_their_message(self):
        client = self._client(status_code=404, json_body={"statusMessage": "Order Not Found"})

        with pytest.raises(postex.PostexInvoiceError, match="Order Not Found"):
            asyncio.run(postex.get_airway_bill(client, "tok", ["CX-1"]))

    def test_a_non_json_failure_body_still_raises_cleanly(self):
        client = self._client(status_code=500, json_body=None)

        with pytest.raises(postex.PostexInvoiceError, match="500"):
            asyncio.run(postex.get_airway_bill(client, "tok", ["CX-1"]))


class TestFetchPickupAddresses:
    """fetch_pickup_addresses builds its own AsyncClient, so these stub the transport
    (same pattern as test_couriers_next.TestFetchShippers). Fixture is a real
    get-merchant-address response, captured live against an actual PostEx account -
    the integration guide's documented shape omits addressType entirely."""

    LIVE_RESPONSE = {
        "statusCode": "200",
        "statusMessage": "SUCCESSFULLY OPERATED",
        "dist": [
            {
                "merchantAddressId": 55327,
                "address": "335 b block adamjee nagar society Karachi Pakistan",
                "phone1": "03390153893",
                "phone2": "03390153893",
                "contactPersonName": "Lushwear",
                "cityName": "Karachi",
                "addressCode": "001",
                "addressType": "Default Address",
            },
            {
                "merchantAddressId": 95717,
                "address": "office number 1B, 1st floor zull jallal centre",
                "phone1": "03390153893",
                "phone2": "03322158364",
                "contactPersonName": "Lushwear",
                "cityName": "Karachi",
                "addressCode": "002",
                "addressType": "Pickup/Return Address",
            },
        ],
    }

    @staticmethod
    def _install(monkeypatch, payload, status_code=200):
        def handler(request):
            return httpx.Response(status_code, json=payload)

        transport = httpx.MockTransport(handler)
        original = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = transport
            return original(*args, **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", factory)

    def test_marks_the_default_address_true_and_the_rest_false(self, monkeypatch):
        self._install(monkeypatch, self.LIVE_RESPONSE)

        addresses = asyncio.run(postex.fetch_pickup_addresses("tok"))

        assert [a["code"] for a in addresses] == ["001", "002"]
        assert addresses[0]["is_default"] is True
        assert addresses[1]["is_default"] is False

    def test_a_failed_fetch_returns_an_empty_list(self, monkeypatch):
        self._install(monkeypatch, {"statusMessage": "Unauthorized"}, status_code=401)

        assert asyncio.run(postex.fetch_pickup_addresses("bad-tok")) == []


class TestSettlementFromTracking:
    """Figures below are real rows from a PostEx CPR export, so these assert the
    derivation reproduces the courier's own settlement arithmetic."""

    def _dist(self, **over):
        base = {
            "transactionStatus": "Delivered",
            "transactionFee": 227.20,
            "transactionTax": 34.08,
            "invoicePayment": 3248.00,
            "reservePaymentDate": "2026-08-28T08:17:19.000+0500",
        }
        base.update(over)
        return base

    def test_delivered_derives_dc_and_four_percent_tax(self):
        result = postex.settlement_from_tracking(self._dist())
        assert result["delivery_charge"] == 261.28   # CSV SHIPPING_CHARGES + GST
        assert result["tax_amount"] == 129.92        # CSV WH_INCOME_TAX + WH_SALES_TAX
        assert result["order_status"] == "delivered"
        assert result["settled"] is True

    def test_returned_reads_the_reversal_fields_and_withholds_nothing(self):
        # A real return: PostEx zeroes the transaction pair and bills the same amounts
        # under reversalFee/reversalTax, with no reserve payment date.
        result = postex.settlement_from_tracking(self._dist(
            transactionStatus="Returned",
            transactionFee=0.0, transactionTax=0.0,
            reversalFee=227.20, reversalTax=34.08,
            reservePaymentDate=None,
        ))
        assert result["delivery_charge"] == 261.28   # CSV SHIPPING_CHARGES + GST
        assert result["tax_amount"] == 0.0           # 40/40 CSV return rows withheld nothing
        assert result["order_status"] == "returned"
        # Returns are never reserve-paid, so they must not be reported as awaiting payment.
        assert result["settled"] is True

    def test_zero_cod_delivered_has_no_tax(self):
        result = postex.settlement_from_tracking(self._dist(invoicePayment=0))
        assert result["tax_amount"] == 0.0
        assert result["delivery_charge"] == 261.28

    @pytest.mark.parametrize("status", ["Out For Delivery", "Booked", "UnBooked", "Attempted", ""])
    def test_non_terminal_status_is_skipped(self, status):
        # Charges are not final mid-transit, so nothing should be written.
        assert postex.settlement_from_tracking(self._dist(transactionStatus=status)) is None

    def test_unpaid_settlement_is_reported_unsettled(self):
        result = postex.settlement_from_tracking(self._dist(reservePaymentDate=None))
        assert result["settled"] is False
        assert result["reserve_payment_date"] == ""

    def test_a_return_with_no_reversal_fields_yields_zero_rather_than_the_transaction_pair(self):
        # Guards the branch itself: if the return path ever fell back to transactionFee,
        # this fixture would report 261.28 instead of 0.
        result = postex.settlement_from_tracking(self._dist(
            transactionStatus="Returned", reversalFee=0.0, reversalTax=0.0,
        ))
        assert result["delivery_charge"] == 0.0

    def test_delivered_ignores_reversal_fields(self):
        result = postex.settlement_from_tracking(self._dist(reversalFee=999.0, reversalTax=99.0))
        assert result["delivery_charge"] == 261.28

    def test_folio_is_the_reserve_payment_date_tagged_as_api_derived(self):
        # Same payout batch the CSV upload records by hand as d/m/yy, suffixed so the two
        # sources stay distinguishable.
        result = postex.settlement_from_tracking(self._dist())
        assert result["folio"] == "28/8/26-API"

    @pytest.mark.parametrize("raw,expected", [
        ("2026-08-28T08:17:19.000+0500", "28/8/26-API"),
        ("2026-01-05T00:00:00.000+0500", "5/1/26-API"),   # no zero padding, matching the CSV values
        ("2026-12-31T23:59:59.000+0500", "31/12/26-API"),
        ("", ""),
        (None, ""),
        ("not-a-date", ""),
    ])
    def test_folio_formatting(self, raw, expected):
        assert postex._folio_from_reserve_date(raw) == expected

    def test_returns_derive_no_folio(self):
        # 0 of 188 CSV-settled returns had a reserve payment date, so there is nothing to
        # derive - the caller must leave any existing folio alone.
        result = postex.settlement_from_tracking(self._dist(
            transactionStatus="Returned", reversalFee=227.20, reversalTax=34.08,
            reservePaymentDate=None,
        ))
        assert result["folio"] == ""

    @pytest.mark.parametrize("invoice,expected_tax", [
        (2598.00, 103.92),
        (2348.00, 93.92),
        (12344.00, 493.76),
        (349.00, 13.96),
    ])
    def test_matches_csv_rows(self, invoice, expected_tax):
        result = postex.settlement_from_tracking(self._dist(invoicePayment=invoice))
        assert result["tax_amount"] == expected_tax

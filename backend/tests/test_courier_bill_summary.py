"""Courier payment bill summary PDF (app/services/pdf/courier_bill_summary.py).

These lock the settlement arithmetic, which has to stay in step with
aggregateCourierPaymentReportBill in frontend/js/courier-payment-report.js -
the PDF is the printable form of that screen, so a drift here is a report that
disagrees with the UI it was exported from.
"""

from app.services.pdf.courier_bill_summary import (
    aggregate_courier_bill,
    generate_courier_bill_summary_pdf,
)


def _order(**overrides):
    base = {
        "order_number": "1001",
        "tracking_number": "TRK1",
        "total_amount": 1000,
        "advance_amount": 0,
        "delivery_charge": 100,
        "tax_amount": 0,
        "order_status": "delivered",
        "is_order_settled": True,
    }
    base.update(overrides)
    return base


class TestAggregateCourierBill:
    def test_delivered_settled_order_is_fully_received(self):
        totals = aggregate_courier_bill([_order(total_amount=1000, delivery_charge=100)])
        assert totals["billValue"] == 1000
        assert totals["netReceivable"] == 900
        assert totals["receivedAmount"] == 900
        assert totals["remainingAmount"] == 0
        assert totals["status"] == "Paid"

    def test_unsettled_return_stays_in_remaining(self):
        """An unsettled return is not reconciled with the courier yet, so its value must
        not be written off against Gross COD."""
        totals = aggregate_courier_bill([
            _order(order_status="returned", is_order_settled=False, total_amount=1000),
        ])
        assert totals["returnedTotal"] == 0
        assert totals["grossCod"] == 1000
        assert totals["remainingAmount"] == 900
        assert totals["status"] == "Unpaid"

    def test_settled_return_is_deducted_at_cod_not_total(self):
        """Bill Value is already net of the advance, so deducting a return's gross total
        would back the advance out twice and invent a phantom debt."""
        totals = aggregate_courier_bill([
            _order(order_number="1", total_amount=5000, advance_amount=0,
                   delivery_charge=200, order_status="delivered"),
            _order(order_number="2", total_amount=3000, advance_amount=500,
                   delivery_charge=150, order_status="returned"),
        ])
        assert totals["billValue"] == 7500
        assert totals["returnedTotal"] == 2500
        assert totals["grossCod"] == 5000
        assert totals["remainingAmount"] == 0

    def test_in_transit_orders_are_counted_but_not_resolved(self):
        totals = aggregate_courier_bill([
            _order(order_number="1", order_status="fulfilled", is_order_settled=False),
            _order(order_number="2", order_status="rfd", is_order_settled=False),
        ])
        assert totals["inTransitCount"] == 2
        assert totals["resolvedCount"] == 0
        assert totals["status"] == "In Transit"

    def test_cancelled_orders_count_in_neither_bucket(self):
        totals = aggregate_courier_bill([_order(order_status="cancelled")])
        assert totals["inTransitCount"] == 0
        assert totals["resolvedCount"] == 0

    def test_zero_delivery_charge_order_is_not_counted_as_received(self):
        """computeReceivable treats a zero delivery charge as "not yet costed"."""
        totals = aggregate_courier_bill([_order(delivery_charge=0)])
        assert totals["settledCount"] == 0
        assert totals["receivedAmount"] == 0

    def test_partially_paid_when_only_some_resolved_orders_are_settled(self):
        totals = aggregate_courier_bill([
            _order(order_number="1", is_order_settled=True),
            _order(order_number="2", is_order_settled=False),
        ])
        assert totals["status"] == "Partially Paid"

    def test_totals_are_rounded_to_paisa(self):
        """Float sums leave residue like -5.5e-17, which renders as "-0.00"."""
        totals = aggregate_courier_bill([
            _order(total_amount=1000.10, delivery_charge=0.20, tax_amount=0.10),
        ])
        assert totals["remainingAmount"] == 0


class TestGenerateCourierBillSummaryPdf:
    def test_produces_a_pdf(self):
        buffer = generate_courier_bill_summary_pdf(
            [_order(), _order(order_number="1002", order_status="returned")],
            "2026-08-30",
            "PostEx",
        )
        assert buffer.getvalue().startswith(b"%PDF-")

    def test_handles_an_unparseable_pickup_date(self):
        buffer = generate_courier_bill_summary_pdf([_order()], "not-a-date", "PostEx")
        assert buffer.getvalue().startswith(b"%PDF-")

    def test_renders_in_transit_orders_with_a_settled_flag(self):
        """The flag is shown for every order, not just resolved ones - an in-transit
        order can carry it, and hiding it makes the export disagree with the screen."""
        buffer = generate_courier_bill_summary_pdf(
            [_order(order_status="fulfilled", is_order_settled=True)], "2026-08-30", "PostEx"
        )
        assert buffer.getvalue().startswith(b"%PDF-")

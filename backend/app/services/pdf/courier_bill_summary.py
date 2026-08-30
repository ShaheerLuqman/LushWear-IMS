"""Courier payment bill summary PDF: the settlement statement for one bill.

A "bill" is every order a single courier picked up on a single date - the unit
couriers actually batch-settle against. It has no row of its own, so the caller
identifies it by (pickup date, courier) and this module re-derives the totals.

The arithmetic mirrors aggregateCourierPaymentReportBill in
frontend/js/courier-payment-report.js; the two must move together, since this PDF
is the printable form of what that screen shows.
"""

import logging
from datetime import datetime
from io import BytesIO
from typing import List, Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.money import money
from app.ordering import _order_number_sort_key
from app.paths import ASSETS_DIR

logger = logging.getLogger("app.courier_payment_report.pdf")

RESOLVED_STATUSES = {"delivered", "returned"}
IN_TRANSIT_STATUSES = {"unfulfilled", "fulfilled", "rfd", "cna", "ica"}


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _cod(order: dict) -> float:
    return _num(order.get("total_amount")) - _num(order.get("advance_amount"))


def _receivable(order: dict) -> Optional[float]:
    """Per-order settlement value, mirroring computeReceivable in orders-grid.js -
    including its rule that a zero delivery charge means "not yet costed", so the
    order contributes nothing rather than counting as fully received."""
    status = (order.get("order_status") or "").lower()
    delivery = _num(order.get("delivery_charge"))
    if status not in RESOLVED_STATUSES or delivery == 0:
        return None
    if status == "returned":
        return -delivery
    return _num(order.get("total_amount")) - (
        _num(order.get("advance_amount")) + delivery + _num(order.get("tax_amount"))
    )


def aggregate_courier_bill(orders: List[dict]) -> dict:
    bill_value = advance_total = charges = taxes = returned_total = received = 0.0
    resolved_count = settled_count = in_transit_count = 0

    for order in orders:
        status = (order.get("order_status") or "").lower()
        settled = bool(order.get("is_order_settled"))
        bill_value += _cod(order)
        advance_total += _num(order.get("advance_amount"))
        charges += _num(order.get("delivery_charge"))
        taxes += _num(order.get("tax_amount"))
        # Only settled returns are written off; an unsettled one is still owed, so it
        # stays inside Remaining. Deducted at COD because bill_value is already net of
        # the advance - using the gross total would back the advance out twice.
        if status == "returned" and settled:
            returned_total += _cod(order)

        if status in IN_TRANSIT_STATUSES:
            in_transit_count += 1
            continue
        if status not in RESOLVED_STATUSES:
            continue
        resolved_count += 1
        if not settled:
            continue
        receivable = _receivable(order)
        if receivable is None:
            continue
        settled_count += 1
        received += receivable

    if resolved_count == 0:
        status_label = "In Transit"
    elif settled_count == resolved_count:
        status_label = "Paid"
    elif settled_count == 0:
        status_label = "Unpaid"
    else:
        status_label = "Partially Paid"

    gross_cod = bill_value - returned_total
    net_receivable = gross_cod - charges - taxes

    return {
        "totalOrders": len(orders),
        "inTransitCount": in_transit_count,
        "resolvedCount": resolved_count,
        "settledCount": settled_count,
        "billValue": money(bill_value),
        "advanceTotal": money(advance_total),
        "returnedTotal": money(returned_total),
        "grossCod": money(gross_cod),
        "charges": money(charges),
        "taxes": money(taxes),
        "netReceivable": money(net_receivable),
        "receivedAmount": money(received),
        "remainingAmount": money(net_receivable - received),
        "status": status_label,
    }


def _fmt(value: float) -> str:
    return f"{value:,.2f}"


def generate_courier_bill_summary_pdf(
    orders: List[dict], pickup_date: str, courier: str
) -> BytesIO:
    totals = aggregate_courier_bill(orders)

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=15 * mm,
        leftMargin=15 * mm,
        topMargin=15 * mm,
        bottomMargin=15 * mm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "BillTitle", parent=styles["Heading1"], fontSize=18,
        textColor=colors.black, spaceAfter=4, alignment=TA_CENTER,
    )
    subtitle_style = ParagraphStyle(
        "BillSubtitle", parent=styles["Normal"], fontSize=10,
        textColor=colors.HexColor("#555555"), alignment=TA_CENTER,
    )
    heading_style = ParagraphStyle(
        "BillHeading", parent=styles["Heading2"], fontSize=12,
        textColor=colors.black, spaceBefore=10, spaceAfter=8,
    )

    elements = []

    logo_path = ASSETS_DIR / "logo_load_sheet.png"
    if logo_path.exists():
        try:
            logo = Image(str(logo_path.absolute()))
            logo._restrictSize(45 * mm, 18 * mm)
            logo.hAlign = "CENTER"
            elements.append(logo)
            elements.append(Spacer(1, 4 * mm))
        except Exception:
            logger.warning("Could not load logo for courier bill summary", exc_info=True)

    try:
        pickup_label = datetime.strptime(pickup_date, "%Y-%m-%d").strftime("%d/%m/%Y")
    except ValueError:
        pickup_label = pickup_date

    elements.append(Paragraph("Courier Payment Summary", title_style))
    elements.append(Paragraph(f"{courier} &nbsp;|&nbsp; Pickup {pickup_label}", subtitle_style))
    elements.append(Spacer(1, 8 * mm))

    overview = [
        ["Status", totals["status"], "Total Orders", str(totals["totalOrders"])],
        ["Settled", f'{totals["settledCount"]} / {totals["resolvedCount"]}',
         "In Transit", str(totals["inTransitCount"])],
    ]
    overview_table = Table(overview, colWidths=[35 * mm, 45 * mm, 35 * mm, 45 * mm])
    overview_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#BBBBBB")),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F0F0F0")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#F0F0F0")),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    elements.append(overview_table)

    elements.append(Paragraph("Financial Summary", heading_style))
    financial = [
        ["Bill Value (COD)", _fmt(totals["billValue"])],
        ["Less: Returned Orders", f'- {_fmt(totals["returnedTotal"])}'],
        ["Gross COD", _fmt(totals["grossCod"])],
        ["Less: Delivery Charges", f'- {_fmt(totals["charges"])}'],
        ["Less: Taxes (SST)", f'- {_fmt(totals["taxes"])}'],
        ["Net Receivable", _fmt(totals["netReceivable"])],
        ["Received", _fmt(totals["receivedAmount"])],
        ["Remaining", _fmt(totals["remainingAmount"])],
    ]
    financial_table = Table(financial, colWidths=[110 * mm, 50 * mm])
    financial_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#BBBBBB")),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        # Gross COD, Net Receivable and Remaining are the subtotal lines.
        ("FONTNAME", (0, 2), (-1, 2), "Helvetica-Bold"),
        ("BACKGROUND", (0, 2), (-1, 2), colors.HexColor("#F5F5F5")),
        ("FONTNAME", (0, 5), (-1, 5), "Helvetica-Bold"),
        ("BACKGROUND", (0, 5), (-1, 5), colors.HexColor("#F5F5F5")),
        ("FONTNAME", (0, 7), (-1, 7), "Helvetica-Bold"),
        ("BACKGROUND", (0, 7), (-1, 7), colors.HexColor("#E0E0E0")),
    ]))
    elements.append(financial_table)

    elements.append(Paragraph(f'Orders in this Bill ({totals["totalOrders"]})', heading_style))
    rows = [["Order #", "Tracking ID", "Status", "Total", "Advance", "Delivery", "Tax", "Receivable", "Settled"]]
    for order in sorted(orders, key=lambda o: _order_number_sort_key(o.get("order_number"))):
        receivable = _receivable(order)
        rows.append([
            str(order.get("order_number") or ""),
            str(order.get("tracking_number") or ""),
            (order.get("order_status") or "").title(),
            _fmt(money(_num(order.get("total_amount")))),
            _fmt(money(_num(order.get("advance_amount")))),
            _fmt(money(_num(order.get("delivery_charge")))),
            _fmt(money(_num(order.get("tax_amount")))),
            _fmt(money(receivable)) if receivable is not None else "-",
            "Settled" if order.get("is_order_settled") else "Unsettled",
        ])

    orders_table = Table(
        rows,
        colWidths=[19 * mm, 28 * mm, 20 * mm, 19 * mm, 19 * mm, 19 * mm, 16 * mm, 21 * mm, 19 * mm],
        repeatRows=1,
    )
    orders_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.black),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("FONTSIZE", (0, 1), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#BBBBBB")),
        ("ALIGN", (3, 1), (7, -1), "RIGHT"),
        ("ALIGN", (8, 0), (8, -1), "CENTER"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F7F7")]),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    elements.append(orders_table)

    doc.build(elements)
    buffer.seek(0)
    return buffer

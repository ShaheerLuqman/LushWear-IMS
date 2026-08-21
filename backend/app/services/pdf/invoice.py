"""Invoice PDF: shaping a DB order (optionally enriched with its Shopify order)
into an invoice context, and rendering those contexts to a PDF.

Extracted verbatim from routes/orders.py; behaviour is unchanged apart from the
logo path, which now comes from app.paths.ASSETS_DIR.
"""

import json
from datetime import datetime
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    Flowable,
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.paths import ASSETS_DIR
from app.services.pdf.packaging_list import _order_line_rows


def _shopify_latest_fulfillment_for_invoice(order: dict) -> Optional[dict]:
    """Latest non-cancelled fulfillment by updated_at/created_at (same idea as sync)."""
    fulfillments = order.get("fulfillments") or []
    if not fulfillments:
        return None
    active = [f for f in fulfillments if f.get("status") != "cancelled"]
    to_check = active if active else fulfillments
    if not to_check:
        return None
    latest = None
    latest_ts = None
    for f in to_check:
        ts_str = f.get("updated_at") or f.get("created_at")
        if not ts_str:
            continue
        try:
            ts = datetime.fromisoformat(str(ts_str).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        if latest_ts is None or ts > latest_ts:
            latest_ts = ts
            latest = f
    return latest if latest else to_check[-1]


def _tracking_from_shopify_order(order: dict) -> Optional[str]:
    f = _shopify_latest_fulfillment_for_invoice(order)
    if not f:
        return None
    tn = f.get("tracking_number")
    if tn and str(tn).strip():
        return str(tn).strip()
    return None


def _format_shopify_address(addr: Optional[dict]) -> str:
    if not addr:
        return ""
    parts = []
    for key in ("address1", "address2", "city", "province", "zip", "country"):
        v = addr.get(key)
        if v is not None and str(v).strip():
            parts.append(str(v).strip())
    return ", ".join(parts)


def _consignee_from_shopify_order(order: dict) -> Tuple[str, str, str]:
    addr = order.get("shipping_address") or order.get("billing_address") or {}
    name = (addr.get("name") or "").strip()
    if not name:
        fn = (addr.get("first_name") or "").strip()
        ln = (addr.get("last_name") or "").strip()
        name = f"{fn} {ln}".strip() or "-"
    phone = (addr.get("phone") or "").strip()
    if not phone:
        phone = (order.get("phone") or "").strip()
    if not phone:
        cust = order.get("customer") or {}
        phone = (cust.get("phone") or "").strip()
    if not phone:
        phone = (order.get("contact_email") or order.get("email") or "").strip()
    address = _format_shopify_address(addr)
    return name, phone or "-", address or "-"


def _line_items_from_shopify_order(order: dict) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for line in order.get("line_items") or []:
        qty = line.get("current_quantity")
        if qty is None:
            qty = line.get("quantity") or 0
        try:
            qty = int(qty)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            continue
        title = (line.get("title") or "").strip() or "-"
        variant = (line.get("variant_title") or "").strip()
        if not variant:
            variant = "-"
        try:
            price = float(line.get("price") or 0)
        except (TypeError, ValueError):
            price = 0.0
        rows.append({"product": title, "size": variant, "quantity": qty, "unit_price": price})
    return rows


def _line_items_from_db_items(db_order: dict) -> List[Dict[str, Any]]:
    """Invoice/load-sheet line rows (real quantity/unit_price) from a stored order's
    structured line_items."""
    rows: List[Dict[str, Any]] = []
    for row in _order_line_rows(db_order):
        if not row["product"]:
            continue
        rows.append({
            "product": row["product"],
            "size": row["variant"],
            "quantity": row["quantity"],
            "unit_price": row["unit_price"],
        })
    return rows


def _invoice_remarks_from_shopify(order: dict) -> str:
    note = (order.get("note") or "").strip()
    if note:
        return note
    tags = order.get("tags")
    tags_str = (tags if isinstance(tags, str) else (str(tags) if tags is not None else "")).strip()
    if tags_str and "confirmed" in tags_str.lower():
        return "THIS ORDER IS 100% CONFIRMED"
    return "THIS ORDER IS 100% CONFIRMED"


def _invoice_pieces_from_shopify(order: dict) -> int:
    total = 0
    for li in order.get("line_items") or []:
        q = li.get("current_quantity")
        if q is None:
            q = li.get("quantity") or 0
        try:
            q = int(q)
        except (TypeError, ValueError):
            q = 0
        if q > 0:
            total += q
    return total if total > 0 else 1


def _build_invoice_order_context(db_order: dict, sp_order: Optional[dict]) -> dict:
    """
    Merge DB row with optional Shopify order payload (same shape as debug_order.json).
    Adds invoice_* keys used only for PDF generation.
    """
    ctx = dict(db_order)
    default_origin = "Karachi"

    if sp_order:
        c_name, c_phone, c_addr = _consignee_from_shopify_order(sp_order)
        ctx["shipping_name"] = c_name
        ctx["shipping_phone"] = c_phone
        ctx["shipping_address"] = c_addr
        ref = (sp_order.get("name") or "").strip()
        ctx["invoice_order_ref"] = ref if ref else f"#{db_order.get('order_number')}"
        tn = _tracking_from_shopify_order(sp_order)
        if tn:
            ctx["tracking_number"] = tn
        try:
            cur = sp_order.get("current_total_price")
            if cur is not None and str(cur).strip() != "":
                ctx["total_amount"] = float(cur)
            else:
                ctx["total_amount"] = float(sp_order.get("total_price") or db_order.get("total_amount") or 0)
        except (TypeError, ValueError):
            ctx["total_amount"] = float(db_order.get("total_amount") or 0)
        cur = sp_order.get("currency") or sp_order.get("presentment_currency") or "PKR"
        ctx["invoice_currency"] = str(cur).strip() or "PKR"
        created = sp_order.get("created_at") or sp_order.get("processed_at")
        if created:
            ctx["order_receiving_date"] = created
        ctx["invoice_pieces"] = _invoice_pieces_from_shopify(sp_order)
        addr = sp_order.get("shipping_address") or {}
        dest_city = (addr.get("city") or "").strip()
        ctx["invoice_destination"] = dest_city or "-"
        ctx["invoice_origin"] = default_origin
        ctx["invoice_return_city"] = default_origin
        ctx["invoice_remarks"] = _invoice_remarks_from_shopify(sp_order)
        ctx["invoice_line_items"] = _line_items_from_shopify_order(sp_order)
    else:
        ctx["invoice_order_ref"] = f"#{db_order.get('order_number')}"
        ctx["invoice_currency"] = "PKR"
        # Piece count = total units across lines (real qty from line_items, else legacy array length).
        pieces = sum(r["quantity"] for r in _order_line_rows(db_order))
        ctx["invoice_pieces"] = pieces if pieces > 0 else 1
        ctx["invoice_destination"] = (db_order.get("destination") or "").strip() or "-"
        ctx["invoice_origin"] = (db_order.get("origin") or "").strip() or default_origin
        ctx["invoice_return_city"] = (db_order.get("return_city") or "").strip() or default_origin
        ctx["invoice_remarks"] = (db_order.get("remarks") or "").strip() or "THIS ORDER IS 100% CONFIRMED"
        ctx["invoice_line_items"] = _line_items_from_db_items(db_order)

    if not ctx.get("invoice_line_items"):
        ctx["invoice_line_items"] = _line_items_from_db_items(db_order)

    return ctx


def _load_invoice_shipper_defaults() -> Dict[str, str]:
    """Load fixed shipper information from invoice.json if present."""
    invoice_json_path = ASSETS_DIR / "invoice.json"
    try:
        if invoice_json_path.exists():
            with open(invoice_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                shipper = (data.get("shipper_information") or {})
                return {
                    "name": shipper.get("name") or "KeeWee",
                    "contact": shipper.get("contact") or "03390153893",
                    "pickup_address": shipper.get("pickup_address") or "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
                    "return_address": shipper.get("return_address") or "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
                }
    except Exception:
        pass
    return {
        "name": "KeeWee",
        "contact": "03390153893",
        "pickup_address": "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
        "return_address": "Office Number 1B, 1st Floor Zul Jallal Centre, 172-F/2, PECHS Karachi",
    }


class _ScaleTableToSlot(Flowable):
    """Uniform scale so a table fits within max_width x max_height (keeps 3 invoices per page)."""

    def __init__(self, child: Table, max_width: float, max_height: float):
        Flowable.__init__(self)
        self.child = child
        self.max_width = max_width
        self.max_height = max_height
        self._scale = 1.0

    def wrap(self, availWidth, availHeight):
        aw = min(availWidth, self.max_width)
        ah = min(availHeight, self.max_height)
        w, h = self.child.wrap(aw, ah)
        if not w or not h:
            return 0, 0
        self._scale = min(1.0, aw / float(w), ah / float(h))
        return w * self._scale, h * self._scale

    def draw(self):
        self.canv.saveState()
        self.canv.scale(self._scale, self._scale)
        self.child.drawOn(self.canv, 0, 0)
        self.canv.restoreState()


def _generate_pdf_invoice(orders: List[dict]) -> BytesIO:
    """Generate a PDF with one invoice table per order. Shipper info is fixed; consignee/shipment/order from each order."""
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=15*mm, leftMargin=15*mm,
        topMargin=15*mm, bottomMargin=15*mm
    )
    elements = []
    styles = getSampleStyleSheet()
    header_style = ParagraphStyle(
        "InvoiceHeader", parent=styles["Normal"], fontSize=10, textColor=colors.black, fontName="Helvetica-Bold"
    )
    normal_style = ParagraphStyle(
        "InvoiceNormal", parent=styles["Normal"], fontSize=9, textColor=colors.black
    )
    bold_style = ParagraphStyle(
        "InvoiceBold", parent=styles["Normal"], fontSize=9, textColor=colors.black, fontName="Helvetica-Bold"
    )
    shipper = _load_invoice_shipper_defaults()
    inter_table_gap = 12 * mm
    tables_per_page = 3
    slot_height = (doc.height - (tables_per_page - 1) * inter_table_gap) / tables_per_page
    logo_height = 6 * mm
    logo_gap = 1.5 * mm
    table_slot_height = max(20 * mm, slot_height - logo_height - logo_gap)
    invoice_logo_path = ASSETS_DIR / "logo_invoice.png"
    logo_width = None
    if invoice_logo_path.exists():
        try:
            iw, ih = ImageReader(str(invoice_logo_path)).getSize()
            if iw and ih:
                logo_width = logo_height * (float(iw) / float(ih))
        except Exception:
            logo_width = None

    def _cell_text(s: str) -> Paragraph:
        return Paragraph((s or "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), normal_style)

    def _cell_header(s: str) -> Paragraph:
        return Paragraph((s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), header_style)


    def _cell_bold(s: str) -> Paragraph:
        return Paragraph((s or "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), bold_style)

    for idx, order in enumerate(orders):
        if idx > 0 and idx % 3 == 0:
            elements.append(PageBreak())
        consignee_name = order.get("shipping_name") or order.get("consignee_name") or "-"
        consignee_contact = order.get("shipping_phone") or order.get("consignee_contact") or "-"
        consignee_address = order.get("shipping_address") or order.get("delivery_address") or "-"
        order_ref = order.get("invoice_order_ref") or f"#{order.get('order_number') or ''}"
        tracking = (order.get("tracking_number") or "-").strip() or "-"
        amount = float(order.get("total_amount") or 0)
        currency = (order.get("invoice_currency") or "PKR").strip()
        order_date_raw = order.get("order_receiving_date") or order.get("created_at")
        if order_date_raw:
            try:
                if isinstance(order_date_raw, str) and "T" in order_date_raw:
                    order_date = order_date_raw.split("T")[0][:10]
                else:
                    order_date = str(order_date_raw).strip()[:10]
            except Exception:
                order_date = str(order_date_raw)[:10] if order_date_raw else "-"
        else:
            order_date = "-"
        order_type = "Replacement" if order.get("replacement_of_order_no") else "Normal"
        pieces_val = order.get("invoice_pieces")
        if pieces_val is None:
            total_units = sum(r["quantity"] for r in _order_line_rows(order))
            pieces_val = total_units if total_units else 1
        pieces = str(pieces_val)
        origin = order.get("invoice_origin") or order.get("origin") or "-"
        destination = order.get("invoice_destination") or order.get("destination") or "-"
        return_city = order.get("invoice_return_city") or order.get("return_city") or "Karachi"
        remarks = "THIS ORDER IS 100% CONFIRMED"


        line_items = order.get("invoice_line_items") or []
        if line_items:
            details_parts = []
            for li in line_items:
                q = int(li.get("quantity") or 0)
                product = li.get("product") or "-"
                size = li.get("size") or ""
                part = f"{q} x {product}"
                if size:
                    part += f" - {size}"
                details_parts.append(part)
            order_details_str = ", ".join(details_parts)
        else:
            order_details_str = "-"

        table_data = [
            [_cell_header("Consignee Information"), "", _cell_header("Shipment Information"), "", _cell_header("Order Information"), ""],
            [_cell_text("Name:"), _cell_bold(consignee_name), _cell_text("Pieces"), _cell_bold(pieces), _cell_text("Amount:"), _cell_bold(f"{amount:.2f}")],
            [_cell_text("Contact:"), _cell_bold(consignee_contact), _cell_text("Order Ref:"), _cell_bold(order_ref), _cell_text("Date:"), _cell_bold(order_date)],
            [_cell_text("Delivery Address:"), _cell_bold(consignee_address), _cell_text("Tracking No:"), _cell_bold(tracking), _cell_text("Order Type:"), _cell_bold(order_type)],
            [_cell_header("Shipper Information"), "", _cell_text("Origin"), _cell_bold(origin), _cell_text("Currency:"), _cell_bold(currency)],
            [_cell_text("Name:"), _cell_bold(shipper["name"]), _cell_text("Destination"), _cell_bold(destination), _cell_text("Remarks"), _cell_bold(remarks)],
            [_cell_text("Contact:"), _cell_bold(shipper["contact"]), _cell_text("Return City:"), _cell_bold(return_city), _cell_text(""), _cell_text("")],
            [_cell_text("Pickup Address:"), _cell_bold(shipper["pickup_address"]), _cell_text(""), _cell_text(""), _cell_header("Order Details:"), _cell_bold(order_details_str)],
            [_cell_text("Return Address:"), _cell_bold(shipper["return_address"]), _cell_text(""), _cell_text(""), _cell_text(""), _cell_text("")],
        ]
        col_widths = [20*mm, 60*mm, 20*mm, 20*mm, 20*mm, 40*mm]
        tbl = Table(table_data, colWidths=col_widths)
        tbl.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 2),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ("SPAN", (0, 0), (1, 0)),
            ("SPAN", (2, 0), (3, 0)),
            ("SPAN", (4, 0), (5, 0)),
            ("SPAN", (0, 4), (1, 4)),
            ("SPAN", (1, 7), (3, 7)),
            ("SPAN", (1, 8), (3, 8)),
            ("SPAN", (4, 5), (4, 6)),
            ("SPAN", (5, 5), (5, 6)),
            ("SPAN", (4, 7), (4, 8)),
            ("SPAN", (5, 7), (5, 8)),
            ("BACKGROUND", (0, 0), (1, 0), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (2, 0), (3, 0), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (4, 0), (5, 0), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (0, 4), (1, 4), colors.HexColor("#E8E8E8")),
            ("BACKGROUND", (4, 7), (4, 8), colors.HexColor("#E8E8E8")),
        ]))
        if logo_width:
            elements.append(Image(str(invoice_logo_path), width=logo_width, height=logo_height, hAlign="LEFT"))
            elements.append(Spacer(1, logo_gap))
        elements.append(_ScaleTableToSlot(tbl, doc.width, table_slot_height))
        if idx != len(orders) - 1 and idx % tables_per_page != tables_per_page - 1:
            elements.append(Spacer(1, inter_table_gap))
    if not elements:
        elements.append(Paragraph("No orders.", normal_style))
    doc.build(elements)
    buffer.seek(0)
    return buffer

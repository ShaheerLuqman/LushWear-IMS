"""Packaging list: aggregation of order lines into per-product/per-size counts,
grouped by collection, and the PDF rendering of that table."""

from datetime import datetime
from io import BytesIO
from typing import Any, Callable, Dict, List, Optional, Tuple

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Table, TableStyle

from app.shopify import KNOWN_COLLECTIONS
from app.timezones import PKT_TIMEZONE


def _order_line_rows(order: dict) -> List[Dict[str, Any]]:
    """Normalized order lines: {product, variant, product_id, variant_id, quantity, unit_price}
    from structured line_items."""
    line_items = order.get("line_items")
    if not isinstance(line_items, list) or not line_items:
        return []
    rows: List[Dict[str, Any]] = []
    for li in line_items:
        if not isinstance(li, dict):
            continue
        try:
            qty = int(li.get("qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            continue
        rows.append({
            "product": (li.get("name") or "").strip(),
            "variant": (li.get("variant_title") or "-").strip() or "-",
            "product_id": li.get("product_id"),
            "variant_id": li.get("variant_id"),
            "quantity": qty,
            "unit_price": li.get("unit_price"),
        })
    return rows


# Base size columns always shown on the packaging list, in this order.
PACKAGING_BASE_SIZES = ["S", "M", "L", "XL"]


def _normalize_size(variant: str) -> str:
    """Normalize a variant string to a size label (uppercased, trimmed).
    Empty/placeholder variants become '-'."""
    s = str(variant or "").strip().upper()
    return s if s and s != "-" else "-"


def _aggregate_packaging_items(
    orders: List[dict],
    resolve_collection: Optional[Callable[[Optional[str], Optional[str]], str]] = None,
) -> Tuple[List[dict], List[str]]:
    """
    Combine items across orders into a per-product, per-size count.

    Returns (rows, sizes) where:
      rows  = sorted list of { product, total, sizes: { <size>: count, ... }, collection }
      sizes = ordered list of size columns to show: S, M, L, XL first, then any
              other sizes present in the data (sorted), e.g. XXL or Free Size.

    `resolve_collection(product_id, product_name)` assigns each product a collection
    (see app.shopify.build_collection_resolver); products fall under "Others" when
    it's omitted or can't resolve one.

    Uses structured line_items (real qty per line) via _order_line_rows.
    """
    # product -> size -> count
    products: Dict[str, Dict[str, int]] = {}
    product_ids: Dict[str, Any] = {}
    seen_sizes: set = set()
    for o in orders:
        for row in _order_line_rows(o):
            product = row["product"]
            if not product:
                continue
            size = _normalize_size(row["variant"])
            qty = row["quantity"]
            products.setdefault(product, {})
            products[product][size] = products[product].get(size, 0) + qty
            seen_sizes.add(size)
            product_ids.setdefault(product, row["product_id"])

    # Column order: base sizes first, then any extra sizes present (sorted).
    extra_sizes = sorted(s for s in seen_sizes if s not in PACKAGING_BASE_SIZES)
    sizes = PACKAGING_BASE_SIZES + extra_sizes

    rows: List[dict] = []
    for product in sorted(products.keys(), key=lambda s: s.lower()):
        size_counts = products[product]
        total = sum(size_counts.values())
        collection = resolve_collection(product_ids.get(product), product) if resolve_collection else "Others"
        rows.append({"product": product, "total": total, "sizes": size_counts, "collection": collection})
    return rows, sizes


def _group_by_collection(aggregated: List[dict]) -> List[Tuple[str, List[dict]]]:
    """Group aggregated product rows by collection, ordered KNOWN_COLLECTIONS first
    then "Others", omitting collections with no items."""
    groups: Dict[str, List[dict]] = {}
    for row in aggregated:
        groups.setdefault(row.get("collection") or "Others", []).append(row)
    return [(c, groups[c]) for c in KNOWN_COLLECTIONS + ["Others"] if c in groups]


def _generate_pdf_packaging_list(aggregated: List[dict], sizes: List[str], order_count: int) -> BytesIO:
    """Generate a packaging list PDF.

    Columns: S. No. | Product Name | <size columns> | Total
    Base size columns are S, M, L, XL; any extra sizes in the data are appended.
    """
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=15 * mm, leftMargin=15 * mm,
        topMargin=15 * mm, bottomMargin=15 * mm,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("PkgTitle", parent=styles["Title"], fontSize=16, spaceAfter=4, textColor=colors.black)
    sub_style = ParagraphStyle("PkgSub", parent=styles["Normal"], fontSize=9, textColor=colors.black, spaceAfter=10)
    cell_style = ParagraphStyle("PkgCell", parent=styles["Normal"], fontSize=10)
    cell_center = ParagraphStyle("PkgCellCenter", parent=cell_style, alignment=TA_CENTER)
    cell_bold = ParagraphStyle("PkgCellBold", parent=styles["Normal"], fontSize=10, fontName="Helvetica-Bold")
    cell_bold_center = ParagraphStyle("PkgCellBoldCenter", parent=cell_bold, alignment=TA_CENTER)
    section_style = ParagraphStyle("PkgSection", parent=styles["Normal"], fontSize=10.5, fontName="Helvetica-Bold")

    def _esc(s: str) -> str:
        return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    generated_on = datetime.now(PKT_TIMEZONE).strftime("%Y-%m-%d %H:%M")
    grand_total = sum(p["total"] for p in aggregated)

    elements = [
        Paragraph("Packaging List", title_style),
        Paragraph(
            f"{order_count} order(s) &middot; {len(aggregated)} product(s) &middot; "
            f"{grand_total} item(s) &middot; Generated {generated_on} PKT",
            sub_style,
        ),
    ]

    # Header: S. No. | Product Name | <sizes...> | Total
    header = [
        Paragraph("S. No.", cell_bold_center),
        Paragraph("Product Name", cell_bold),
    ]
    header += [Paragraph(_esc(s), cell_bold_center) for s in sizes]
    header.append(Paragraph("Total", cell_bold_center))
    table_data = [header]
    num_cols = len(header)

    # Rows are grouped into a shaded, full-width section row per collection;
    # S. No. numbering runs continuously across sections.
    size_totals = {s: 0 for s in sizes}
    section_row_indices: List[int] = []
    idx = 0
    for collection, rows in _group_by_collection(aggregated):
        section_row_indices.append(len(table_data))
        table_data.append(
            [Paragraph(_esc(collection), section_style)] + [Paragraph("", cell_style) for _ in range(num_cols - 1)]
        )
        for p in rows:
            idx += 1
            row = [
                Paragraph(str(idx), cell_center),
                Paragraph(_esc(p["product"]), cell_style),
            ]
            for s in sizes:
                count = p["sizes"].get(s, 0)
                size_totals[s] += count
                row.append(Paragraph(str(count) if count else "-", cell_center))
            row.append(Paragraph(str(p["total"]), cell_bold_center))
            table_data.append(row)

    if len(table_data) == 1:
        empty = [Paragraph("No items found in the selected orders.", cell_style)]
        empty += [Paragraph("", cell_style) for _ in range(num_cols - 1)]
        table_data.append(empty)
        footer_row_index = None
    else:
        # Footer totals row.
        footer = [
            Paragraph("", cell_bold),
            Paragraph("Total", cell_bold),
        ]
        footer += [Paragraph(str(size_totals[s]), cell_bold_center) for s in sizes]
        footer.append(Paragraph(str(grand_total), cell_bold_center))
        table_data.append(footer)
        footer_row_index = len(table_data) - 1

    # Column widths: S.No. and Total fixed; size columns share a band; product takes the rest.
    page_width = A4[0] - (15 * mm) * 2
    sno_w = 14 * mm
    total_w = 18 * mm
    size_w = 14 * mm
    product_w = page_width - sno_w - total_w - size_w * len(sizes)
    if product_w < 35 * mm:
        product_w = 35 * mm
    col_widths = [sno_w, product_w] + [size_w] * len(sizes) + [total_w]

    table = Table(table_data, colWidths=col_widths, repeatRows=1)
    # Black & white print friendly: white header fill, black text, black grid lines,
    # no alternating row shading.
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.white),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.black),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("LINEBELOW", (0, 0), (-1, 0), 1, colors.black),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        # Center S.No., all size columns, and Total; product name stays left.
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (2, 0), (-1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    if footer_row_index is not None:
        style.append(("LINEABOVE", (0, footer_row_index), (-1, footer_row_index), 1, colors.black))
    for r in section_row_indices:
        style.append(("SPAN", (0, r), (-1, r)))
        style.append(("BACKGROUND", (0, r), (-1, r), colors.whitesmoke))
        style.append(("ALIGN", (0, r), (-1, r), "LEFT"))
    table.setStyle(TableStyle(style))
    elements.append(table)
    doc.build(elements)
    buffer.seek(0)
    return buffer



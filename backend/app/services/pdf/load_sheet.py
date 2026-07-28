"""Load sheet PDF: the rider/assignment manifest handed to the courier.

Extracted verbatim from routes/orders.py; behaviour is unchanged apart from the
logo path, which now comes from app.paths.ASSETS_DIR rather than being resolved
relative to the module's own location.
"""

import logging
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import List, Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.ordering import _order_number_sort_key
from app.paths import ASSETS_DIR

logger = logging.getLogger("app.orders.pdf")


def _generate_pdf_load_sheet(
    orders: List[dict],
    template_path: Optional[Path] = None,
    assignment_number: Optional[str] = None,
    rider_name: Optional[str] = None,
) -> BytesIO:
    """
    Generate a PDF load sheet from orders data.
    
    Args:
        orders: List of order dictionaries
        template_path: Optional path to a PDF template (for future use with PyPDF2/pdfrw)
        assignment_number: Optional assignment number to show on the PDF
        rider_name: Optional rider name to show on the PDF
    
    Returns:
        BytesIO buffer containing the PDF
    """
    
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, 
                           rightMargin=20*mm, leftMargin=20*mm,
                           topMargin=20*mm, bottomMargin=20*mm)
    
    # Container for the 'Flowable' objects
    elements = []
    styles = getSampleStyleSheet()
    
    # Custom styles - Black and white theme
    title_style = ParagraphStyle(
        'CustomTitle',
        parent=styles['Heading1'],
        fontSize=18,
        textColor=colors.black,
        spaceAfter=30,
        alignment=TA_CENTER
    )
    
    heading_style = ParagraphStyle(
        'CustomHeading',
        parent=styles['Heading2'],
        fontSize=12,
        textColor=colors.black,
        spaceAfter=12,
        spaceBefore=12
    )
    
    normal_style = ParagraphStyle(
        'CustomNormal',
        parent=styles['Normal'],
        fontSize=10,
        textColor=colors.black
    )
    
    # Add logo image above the title
    # Path: __file__ is backend/app/routes/orders.py, so we need to go up one level to backend/app/
    logo_path = ASSETS_DIR / "logo_load_sheet.png"
    logo_absolute_path = logo_path.absolute()
    
    if logo_path.exists():
        try:
            # Load image using PIL/Pillow first to verify it can be loaded
            from PIL import Image as PILImage
            pil_img = PILImage.open(str(logo_absolute_path))
            
            # Calculate height maintaining aspect ratio (max width 80mm)
            img_width_px, img_height_px = pil_img.size
            max_width_mm = 80
            width_mm = min(max_width_mm, (img_width_px / 96) * 25.4)  # Convert pixels to mm (assuming 96 DPI)
            aspect_ratio = img_height_px / img_width_px
            height_mm = width_mm * aspect_ratio
            
            # Create reportlab Image
            logo = Image(str(logo_absolute_path), width=width_mm*mm, height=height_mm*mm)
            
            # Center the image using a table
            logo_table = Table([[logo]], colWidths=[doc.width])
            logo_table.setStyle(TableStyle([
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('LEFTPADDING', (0, 0), (-1, -1), 0),
                ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                ('TOPPADDING', (0, 0), (-1, -1), 0),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ]))
            elements.append(logo_table)
            elements.append(Spacer(1, 5*mm))
        except Exception as e:
            # If image loading fails, continue without logo
            import traceback
            logger.warning("Could not load logo image: %s", e)
            traceback.print_exc()
    else:
        logger.warning("Logo file not found at %s", logo_absolute_path)
    
    # Title
    elements.append(Paragraph("Load Sheet", title_style))
    elements.append(Spacer(1, 10*mm))
    
    # Date, Assignment #, Rider (each on its own line)
    now = datetime.now()
    current_date = now.strftime("%d/%m/%Y")
    elements.append(Paragraph(f"<b>Date:</b> {current_date}", normal_style))
    if assignment_number:
        elements.append(Paragraph(f"<b>Assignment #:</b> {assignment_number}", normal_style))
    if rider_name:
        elements.append(Paragraph(f"<b>Rider:</b> {rider_name}", normal_style))
    elements.append(Spacer(1, 5*mm))
    
    orders.sort(key=lambda x: _order_number_sort_key(x.get("order_number")))
    
    # Prepare table data
    table_data = [
        ['Order Number', 'Tracking Number', 'COD', 'Delivery Charge', 'Net Amount']
    ]
    
    net_amount_sum = 0
    
    for order in orders:
        order_number = order.get("order_number", "")
        tracking_number = order.get("tracking_number", "") or ""
        total_amount = float(order.get("total_amount", 0) or 0)
        advance_amount = float(order.get("advance_amount", 0) or 0)
        delivery_charge = float(order.get("delivery_charge", 0) or 0)
        tax_amount = float(order.get("tax_amount", 0) or 0)
        
        # Calculate COD (total_amount - advance_amount)
        cod = total_amount - advance_amount
        
        # Calculate Net Amount (receivable = total_amount - advance_amount - delivery_charge - tax_amount)
        net_amount = total_amount - advance_amount - delivery_charge - tax_amount
        net_amount_sum += net_amount
        
        # Format currency values
        table_data.append([
            order_number,
            tracking_number,
            f"{cod:.2f}",
            f"{delivery_charge:.2f}",
            f"{net_amount:.2f}"
        ])
    
    # Add final balance row - use Paragraph objects for proper formatting
    # Create styles with appropriate alignment
    final_balance_label_style = ParagraphStyle(
        'FinalBalanceLabel',
        parent=normal_style,
        alignment=TA_LEFT
    )
    final_balance_amount_style = ParagraphStyle(
        'FinalBalanceAmount',
        parent=normal_style,
        alignment=TA_RIGHT
    )
    table_data.append([
        '',
        '',
        '',
        Paragraph('<b>Final Balance</b>', final_balance_label_style),
        Paragraph(f'<b>{net_amount_sum:.2f}</b>', final_balance_amount_style)
    ])
    
    # Create table
    table = Table(table_data, colWidths=[40*mm, 50*mm, 30*mm, 35*mm, 35*mm])
    
    # Style the table - Black and white style
    table.setStyle(TableStyle([
        # Header row - black background with white text
        ('BACKGROUND', (0, 0), (-1, 0), colors.black),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 11),
        ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
        ('TOPPADDING', (0, 0), (-1, 0), 12),
        
        # Data rows - white background with black text, alternating rows
        ('BACKGROUND', (0, 1), (-1, -2), colors.white),
        ('TEXTCOLOR', (0, 1), (-1, -2), colors.black),
        ('FONTNAME', (0, 1), (-1, -2), 'Helvetica'),
        ('FONTSIZE', (0, 1), (-1, -2), 10),
        ('GRID', (0, 0), (-1, -1), 1, colors.black),
        ('ROWBACKGROUNDS', (0, 1), (-1, -2), [colors.white, colors.HexColor('#F5F5F5')]),
        
        # Final balance row - light gray background with black text
        ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor('#E0E0E0')),
        ('TEXTCOLOR', (0, -1), (-1, -1), colors.black),
        ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'),
        ('FONTSIZE', (0, -1), (-1, -1), 11),
        ('TOPPADDING', (0, -1), (-1, -1), 12),
        ('BOTTOMPADDING', (0, -1), (-1, -1), 12),
        
        # Alignment for numeric columns
        ('ALIGN', (2, 1), (-1, -1), 'RIGHT'),
    ]))
    
    elements.append(table)
    
    # Build PDF
    doc.build(elements)
    buffer.seek(0)
    return buffer

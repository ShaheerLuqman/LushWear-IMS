from io import BytesIO

from reportlab.pdfgen import canvas

from app.order_pdf import extract_order_numbers


def _pdf(lines):
    buf = BytesIO()
    c = canvas.Canvas(buf)
    y = 800
    for line in lines:
        c.drawString(40, y, line)
        y -= 20
    c.showPage()
    c.save()
    buf.seek(0)
    return buf.read()


def test_postex_labels_without_hash():
    pdf = _pdf([
        "Pieces: 1 Order Ref: 13141 Tracking No: 20306960008683",
        "Amount: 3248.00/- Date: 31/8/2026 Destination: Rawalpindi 46300",
        "Pieces: 2 Order Ref: 13140 Tracking No: 21306960008684",
    ])
    assert extract_order_numbers(pdf) == ["13141", "13140"]


def test_postex_labels_with_hash_and_replacement():
    pdf = _pdf(["Order Ref: #13140", "Order Ref: #4446-R"])
    assert extract_order_numbers(pdf) == ["13140", "4446-R"]


def test_couriers_next_labels():
    pdf = _pdf([
        "No. of Pieces 1 Order ID. : #13139 COD Amount Rs: 3,398.00",
        "No. of Pieces 2 Order ID. : #13119 COD Amount Rs: 6,148.00",
    ])
    assert extract_order_numbers(pdf) == ["13139", "13119"]

"""Extract order numbers from a PostEx / courier labels PDF.

Order numbers appear in the labels next to the "Order Ref:" caption (with or
without a leading '#' — PostEx dropped the '#' at some point). They are 4-5 digit
numbers, optionally suffixed with '-R' for replacement orders. This module pulls
the text out of every page and collects each unique order number, preserving
first-seen order.
"""

import re
from io import BytesIO
from pathlib import Path
from typing import List, Union

from pypdf import PdfReader

# Anchored on the "Order Ref:" caption so amounts, dates and postal codes on the
# label can't be misread as order numbers. '#' is optional; '-R' marks replacements.
ORDER_RE = re.compile(r"Order Ref:\s*#?(\d{4,5}(?:-R)?)\b", re.IGNORECASE)


def extract_order_numbers(source: Union[bytes, BytesIO, str, Path]) -> List[str]:
    """Return unique order numbers found in a PDF.

    `source` may be raw bytes, a file-like object, or a path to a PDF file.
    """
    if isinstance(source, bytes):
        source = BytesIO(source)
    reader = PdfReader(source)
    seen = set()
    ordered = []  # preserve first-seen order
    for page in reader.pages:
        text = page.extract_text() or ""
        for match in ORDER_RE.finditer(text):
            num = match.group(1).upper()
            if num not in seen:
                seen.add(num)
                ordered.append(num)
    return ordered

"""One-off probe: does PostEx's get-invoice ever return fewer pages than tracking numbers
requested, for the exact same input, across repeated calls?

Sends the same 30 real PostEx tracking numbers to /v1/get-invoice, 10 times in a row (one
call per round - all 30 fit under postex._INVOICE_TRACKING_PER_CALL, so no chunking), and
counts pages in the PDF that comes back each time. Any round with fewer than 30 pages is
the silent-drop case suspected in the Print Airway Bill flow.

Read-only against our DB; hits PostEx's live get-invoice endpoint 10 times.

    python scripts/test_airway_bill_page_counts.py [--org-name NAME] [--count 30] [--rounds 10]
"""

import argparse
import asyncio
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from pypdf import PdfReader

from _org import resolve_org_by_name
from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table
from app.org_settings import get_org_integration_settings
from app.services import postex


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--org-name", help="defaults to the sole organization if only one exists")
    ap.add_argument("--count", type=int, default=30)
    ap.add_argument("--rounds", type=int, default=10)
    args = ap.parse_args()

    sb = get_supabase()
    org_id, org_name = resolve_org_by_name(sb, args.org_name)

    token = get_org_integration_settings(org_id).postex_merchant_token
    if not token:
        sys.exit("PostEx merchant token is not configured for this organization.")

    rows = fetch_all(
        lambda: org_table(sb, org_id, "shopify_orders")
        .select("order_number, tracking_number")
        .eq("order_status", "fulfilled")
        .eq("courier", "PostEx")
        .not_.is_("tracking_number", "null")
        .order("fulfilled_at", desc=True)
        .limit(args.count)
    )
    numbers = [str(r["tracking_number"]).strip() for r in rows if str(r.get("tracking_number") or "").strip()]
    if len(numbers) < args.count:
        sys.exit(f"Only found {len(numbers)} fulfilled PostEx orders with a tracking number - need {args.count}.")
    numbers = numbers[:args.count]
    print(f"org={org_name} tracking numbers={len(numbers)} rounds={args.rounds}")
    print("first 5:", numbers[:5])
    print()

    mismatches = 0
    async with httpx.AsyncClient(timeout=60.0) as client:
        for i in range(1, args.rounds + 1):
            try:
                pdf_bytes = await postex.get_airway_bill(client, token, numbers)
            except postex.PostexInvoiceError as exc:
                print(f"round {i:2d}: ERROR - {exc}")
                mismatches += 1
                continue
            pages = len(PdfReader(io.BytesIO(pdf_bytes)).pages)
            flag = "" if pages == len(numbers) else "  <-- MISMATCH"
            print(f"round {i:2d}: requested={len(numbers)} pages={pages}{flag}")
            if pages != len(numbers):
                mismatches += 1
            await asyncio.sleep(1)  # be polite to their API between rounds

    print()
    if mismatches:
        print(f"{mismatches}/{args.rounds} round(s) had a page-count mismatch or error.")
        return 1
    print(f"All {args.rounds} rounds returned exactly {len(numbers)} pages. No mismatch reproduced.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

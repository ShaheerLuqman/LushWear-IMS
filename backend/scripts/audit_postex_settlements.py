"""Audit our stored settlement figures against PostEx's live API, for every settled order.

Orders settled from a CPR CSV (tax_amount_derived = false) carry PostEx's authoritative
figures, so replaying the API derivation against them measures whether that derivation is
trustworthy at full history scale rather than on one export. Orders the API already settled
(tax_amount_derived = true) have no independent truth, so they are only checked for
internal consistency - that what we stored still matches what the API reports today.

    python scripts/audit_postex_settlements.py [--org-name LushWear] [--limit N]

Read-only. Exits 1 if any CSV-backed order disagrees with the derivation.
"""

import argparse
import asyncio
import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table
from app.org_settings import get_org_integration_settings
from app.services import postex

BATCH = 100
CONCURRENCY = 4
URL = "https://api.postex.pk/services/integration/api/order/v1/track-bulk-order"


async def fetch_all_tracking(numbers, token):
    """Same shape as routes.orders._fetch_postex_bulk, but keeps PostEx's raw dist."""
    batches = [numbers[i:i + BATCH] for i in range(0, len(numbers), BATCH)]
    sem = asyncio.Semaphore(CONCURRENCY)
    out = {}

    async def one(client, batch):
        async with sem:
            r = await client.get(URL, headers={"token": token},
                                 params=[("TrackingNumbers", t) for t in batch])
            r.raise_for_status()
            return r.json()

    async with httpx.AsyncClient(timeout=60.0) as client:
        results = await asyncio.gather(*(one(client, b) for b in batches), return_exceptions=True)
    for batch, data in zip(batches, results):
        if isinstance(data, BaseException):
            print(f"  [warn] batch of {len(batch)} failed: {data}", file=sys.stderr)
            continue
        if data.get("statusCode") != "200":
            continue
        for item in data.get("dist") or []:
            tr = item.get("trackingResponse") or {}
            if tr.get("trackingNumber"):
                out[str(tr["trackingNumber"])] = tr
    return out


async def fetch_all_payment_status(numbers, token):
    """payment-status is one call per tracking number - no bulk endpoint - so fan out.
    Returns postex.parse_payment_status() output keyed by tracking number."""
    url = "https://api.postex.pk/services/integration/api/order/v1/payment-status/"
    sem = asyncio.Semaphore(CONCURRENCY)
    out = {}

    async def one(client, tn):
        async with sem:
            r = await client.get(url + tn, headers={"token": token})
            r.raise_for_status()
            return tn, r.json()

    async with httpx.AsyncClient(timeout=60.0) as client:
        results = await asyncio.gather(*(one(client, t) for t in numbers), return_exceptions=True)
    for item in results:
        if isinstance(item, BaseException):
            print(f"  [warn] payment-status failed: {item}", file=sys.stderr)
            continue
        tn, data = item
        if data.get("statusCode") == "200":
            out[tn] = postex.parse_payment_status(data.get("dist"))
    return out


def _folio_dates_equal(ours: str, theirs: str) -> bool:
    """True when two folios name the same day in different notations.

    Older folios were typed "3/16" (m/d, no year) where the current convention is
    "16/3/26" - the same payout batch, so flagging them as mismatched is noise.
    """
    a = re.match(r"^(\d{1,2})/(\d{1,2})$", ours)
    b = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2})$", theirs)
    return bool(a and b and int(a.group(2)) == int(b.group(1)) and int(a.group(1)) == int(b.group(2)))


def _same_folio(ours: str, theirs: str) -> bool:
    bare_ours = ours.removesuffix(postex.FOLIO_API_SUFFIX)
    bare_theirs = theirs.removesuffix(postex.FOLIO_API_SUFFIX)
    return bare_ours == bare_theirs or _folio_dates_equal(bare_ours, bare_theirs)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--org-name", default="LushWear")
    ap.add_argument("--limit", type=int, default=25, help="max example rows printed per bucket")
    ap.add_argument("--out", type=Path, help="write every discrepancy to this CSV for review")
    args = ap.parse_args()

    sb = get_supabase()
    orgs = sb.table("system_organizations").select("id, name").execute().data or []
    match = [o for o in orgs if o["name"].lower() == args.org_name.lower()]
    if not match:
        sys.exit(f"No organization named {args.org_name!r}")
    org_id = match[0]["id"]

    rows = fetch_all(
        lambda: org_table(sb, org_id, "shopify_orders")
        .select("order_number, order_status, courier, is_order_settled, tax_amount_derived, "
                "tracking_number, delivery_charge, tax_amount, total_amount, advance_amount, folio")
        .eq("is_order_settled", True)
        .eq("courier", "PostEx")
        .order("order_number")
    )
    rows = [r for r in rows if str(r.get("tracking_number") or "").strip()]
    csv_backed = [r for r in rows if not r.get("tax_amount_derived")]
    api_settled = [r for r in rows if r.get("tax_amount_derived")]
    print(f"settled PostEx orders with tracking: {len(rows)}")
    print(f"  CSV-settled (ground truth):        {len(csv_backed)}")
    print(f"  API-settled (consistency only):    {len(api_settled)}\n")

    token = get_org_integration_settings(org_id).postex_merchant_token
    if not token:
        sys.exit("PostEx merchant token is not configured for this organization.")

    numbers = [str(r["tracking_number"]).strip() for r in rows]
    print(f"querying PostEx for {len(numbers)} tracking numbers...")
    live = asyncio.run(fetch_all_tracking(numbers, token))
    print(f"  returned: {len(live)}")

    # Returns carry no reservePaymentDate; their folio and payout come from payment-status.
    return_numbers = [
        tn for tn in numbers
        if str((live.get(tn) or {}).get("transactionStatus") or "").strip().lower() == "returned"
    ]
    pay_status = asyncio.run(fetch_all_payment_status(return_numbers, token)) if return_numbers else {}
    print(f"  payment-status fetched for {len(pay_status)}/{len(return_numbers)} return(s)\n")

    buckets = {"delivery_charge": [], "tax_amount": [], "status": [], "unpaid": []}
    missing, pending, checked = [], [], 0
    discrepancies = []

    for r in csv_backed:
        tn = str(r["tracking_number"]).strip()
        dist = live.get(tn)
        if not dist:
            missing.append(r["order_number"])
            discrepancies.append({
                "order_number": r["order_number"], "tracking_number": tn, "field": "tracking_number",
                "ours": tn, "postex": "not found", "difference": "",
                "reason": "PostEx has no record of this tracking number",
                "our_status": (r.get("order_status") or "").strip().lower(), "postex_status": "",
                "total_amount": f"{float(r.get('total_amount') or 0):.2f}", "invoice_payment": "",
                "our_receivable": "", "postex_receivable": "", "receivable_difference": "",
                "folio": str(r.get("folio") or "").strip(),
            })
            continue
        is_return = str(dist.get("transactionStatus") or "").strip().lower() == "returned"
        derived = postex.settlement_from_tracking(dist, payment_status=pay_status.get(tn) if is_return else None)
        if derived is None:
            status_now = str(dist.get("transactionStatus") or "")
            pending.append((r["order_number"], status_now))
            discrepancies.append({
                "order_number": r["order_number"], "tracking_number": tn, "field": "order_status",
                "ours": (r.get("order_status") or "").strip().lower(), "postex": status_now,
                "difference": "",
                "reason": "settled here but PostEx has not marked it delivered or returned",
                "our_status": (r.get("order_status") or "").strip().lower(), "postex_status": status_now,
                "total_amount": f"{float(r.get('total_amount') or 0):.2f}", "invoice_payment": "",
                "our_receivable": "", "postex_receivable": "", "receivable_difference": "",
                "folio": str(r.get("folio") or "").strip(),
            })
            continue
        checked += 1
        ours_dc = round(float(r.get("delivery_charge") or 0), 2)
        ours_tax = round(float(r.get("tax_amount") or 0), 2)
        ours_status = (r.get("order_status") or "").strip().lower()
        reasons = []

        if abs(derived["delivery_charge"] - ours_dc) > 0.011:
            buckets["delivery_charge"].append((r["order_number"], r["order_status"], derived["delivery_charge"], ours_dc))
            reasons.append(("delivery_charge", f"{ours_dc:.2f}", f"{derived['delivery_charge']:.2f}",
                            f"{derived['delivery_charge'] - ours_dc:+.2f}",
                            "our stored delivery charge is not what PostEx billed"))
        if abs(derived["tax_amount"] - ours_tax) > 0.011:
            buckets["tax_amount"].append((r["order_number"], r["order_status"], derived["tax_amount"], ours_tax))
            reasons.append(("tax_amount", f"{ours_tax:.2f}", f"{derived['tax_amount']:.2f}",
                            f"{derived['tax_amount'] - ours_tax:+.2f}",
                            "withholding differs from 2% income + 2% sales of the COD amount"))
        if derived["order_status"] != ours_status:
            buckets["status"].append((r["order_number"], "", derived["order_status"], ours_status))
            reasons.append(("order_status", ours_status, derived["order_status"], "",
                            "PostEx reports a different final status than we recorded"))
        if not derived["settled"]:
            buckets["unpaid"].append((r["order_number"], r["order_status"], "no reserve date", "settled here"))
            reasons.append(("is_order_settled", "settled", "not paid out", "",
                            "marked settled here but PostEx shows no reserve payment"))

        ours_folio = str(r.get("folio") or "").strip()
        want_folio = derived["folio"]
        if want_folio and ours_folio and not _same_folio(ours_folio, want_folio):
            reasons.append(("folio", ours_folio, want_folio, "",
                            "folio does not match PostEx's reserve payment date"))

        if reasons:
            receivable = (round(-derived["delivery_charge"], 2) if derived["order_status"] == "returned"
                          else round(float(r.get("total_amount") or 0) - float(r.get("advance_amount") or 0)
                                     - derived["delivery_charge"] - derived["tax_amount"], 2))
            ours_receivable = (round(-ours_dc, 2) if ours_status == "returned"
                               else round(float(r.get("total_amount") or 0) - float(r.get("advance_amount") or 0)
                                          - ours_dc - ours_tax, 2))
            for field, ours, theirs, delta, why in reasons:
                discrepancies.append({
                    "order_number": r["order_number"],
                    "tracking_number": tn,
                    "field": field,
                    "ours": ours,
                    "postex": theirs,
                    "difference": delta,
                    "reason": why,
                    "our_status": ours_status,
                    "postex_status": derived["order_status"],
                    "total_amount": f"{float(r.get('total_amount') or 0):.2f}",
                    "invoice_payment": f"{derived['invoice_payment']:.2f}",
                    "our_receivable": f"{ours_receivable:.2f}",
                    "postex_receivable": f"{receivable:.2f}",
                    "receivable_difference": f"{receivable - ours_receivable:+.2f}",
                    "folio": ours_folio,
                })

    print("=" * 62)
    print(f"CSV-BACKED ORDERS: derivation vs PostEx's own figures ({checked} compared)")
    print("=" * 62)
    print(f"{'CHECK':<22}{'MISMATCHES':>12}")
    print("-" * 34)
    for k in ("delivery_charge", "tax_amount", "status", "unpaid"):
        print(f"{k:<22}{len(buckets[k]):>12}")
    print("-" * 34)
    total = sum(len(v) for v in buckets.values())
    print(f"{'TOTAL':<22}{total:>12}")
    if missing:
        print(f"\nnot found at PostEx: {len(missing)} -> {missing[:args.limit]}")
    if pending:
        print(f"\nnot terminal at PostEx: {len(pending)} -> {pending[:args.limit]}")

    for k, rowsx in buckets.items():
        if not rowsx:
            continue
        print(f"\n=== {k} ({len(rowsx)}) ===")
        print(f"  {'ORDER':<9}{'STATUS':<11}{'POSTEX':>18}{'OURS':>18}")
        for num, st, exp, act in rowsx[:args.limit]:
            e = f"{exp:.2f}" if isinstance(exp, float) else str(exp)
            a = f"{act:.2f}" if isinstance(act, float) else str(act)
            print(f"  {num:<9}{st:<11}{e:>18}{a:>18}")
        if len(rowsx) > args.limit:
            print(f"  ... and {len(rowsx) - args.limit} more")

    # API-settled rows have no external truth; verify only that they still agree with today's API.
    drift = []
    for r in api_settled:
        tn = str(r["tracking_number"]).strip()
        dist = live.get(tn)
        if not dist:
            continue
        is_return = str(dist.get("transactionStatus") or "").strip().lower() == "returned"
        derived = postex.settlement_from_tracking(dist, payment_status=pay_status.get(tn) if is_return else None)
        if derived is None:
            continue
        if abs(derived["delivery_charge"] - round(float(r.get("delivery_charge") or 0), 2)) > 0.011 \
           or abs(derived["tax_amount"] - round(float(r.get("tax_amount") or 0), 2)) > 0.011:
            drift.append(r["order_number"])
    print(f"\nAPI-settled rows re-checked against today's API: {len(api_settled)}, drifted: {len(drift)}")
    if drift:
        print(f"  {drift[:args.limit]}")

    if args.out and discrepancies:
        cols = ["order_number", "tracking_number", "field", "ours", "postex", "difference", "reason",
                "our_status", "postex_status", "total_amount", "invoice_payment",
                "our_receivable", "postex_receivable", "receivable_difference", "folio"]
        discrepancies.sort(key=lambda d: (str(d["field"]), d["order_number"]))
        with args.out.open("w", newline="", encoding="utf-8-sig") as fh:
            writer = csv.DictWriter(fh, fieldnames=cols)
            writer.writeheader()
            writer.writerows(discrepancies)
        affected = len({d["order_number"] for d in discrepancies})
        print(f"\nwrote {len(discrepancies)} discrepancy row(s) across {affected} order(s) to {args.out}")

    if total == 0:
        print("\nNo discrepancies: the derivation reproduces PostEx's own figures on every CSV-backed order.")
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(main())

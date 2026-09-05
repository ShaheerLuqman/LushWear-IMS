"""Reconcile a PostEx CPR export against what we actually stored.

Reads the CSV through the same parser the upload endpoint uses, then compares every
field that upload writes - delivery_charge, tax_amount, tracking_number, courier,
is_order_settled - plus the receivable the grid derives, against the live rows.

    python scripts/reconcile_postex_csv.py <export.csv> [--org <uuid>|--org-name LushWear]

Read-only: it never writes. Exits 1 when any discrepancy is found so it can gate a run.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import get_supabase
from app.db_utils import fetch_all
from app.money import money
from app.org_scope import org_table
from app.services import postex

FIELDS = ("delivery_charge", "tax_amount", "tracking_number", "courier", "is_order_settled", "receivable")


def expected_receivable(status: str, total: float, advance: float, dc: float, tax: float) -> float:
    """The grid's own formula (upload_postex_csv applies the same one)."""
    if (status or "").strip().lower() == "returned":
        return money(-dc)
    return money(total - advance - dc - tax)


def resolve_org(supabase, org_arg: str | None, org_name: str | None) -> str:
    orgs = supabase.table("system_organizations").select("id, name").execute().data or []
    if org_arg:
        return org_arg
    if org_name:
        match = [o for o in orgs if o["name"].lower() == org_name.lower()]
        if not match:
            sys.exit(f"No organization named {org_name!r}. Available: {[o['name'] for o in orgs]}")
        return match[0]["id"]
    if len(orgs) == 1:
        return orgs[0]["id"]
    sys.exit(f"Multiple organizations - pass --org-name or --org. Available: {[o['name'] for o in orgs]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", type=Path)
    ap.add_argument("--org")
    ap.add_argument("--org-name")
    ap.add_argument("--limit", type=int, default=40, help="max discrepancy rows to print per field")
    args = ap.parse_args()

    supabase = get_supabase()
    org_id = resolve_org(supabase, args.org, args.org_name)

    rows, _ = postex.parse_rows(args.csv.read_bytes())
    by_number = {r["order_number"]: r for r in rows}
    wanted = sorted({int(n) for n in by_number if n.isdigit()})
    print(f"CSV rows parsed: {len(rows)}   distinct order numbers: {len(wanted)}\n")

    db_rows = fetch_all(
        lambda: org_table(supabase, org_id, "shopify_orders")
        .select("order_number, order_status, total_amount, advance_amount, delivery_charge, "
                "tax_amount, tracking_number, courier, is_order_settled")
        .in_("order_number", wanted)
        .order("order_number")
    )
    db_by_number = {str(o["order_number"]): o for o in db_rows}

    missing = [n for n in by_number if n not in db_by_number]
    diffs = {f: [] for f in FIELDS}
    compared = 0

    for number, csv_row in by_number.items():
        order = db_by_number.get(number)
        if not order:
            continue
        compared += 1
        status = order.get("order_status") or ""
        csv_dc = round(float(csv_row["delivery_charge"]), 2)
        csv_tax = round(float(csv_row["tax_amount"]), 2)

        actual = {
            "delivery_charge": round(float(order.get("delivery_charge") or 0), 2),
            "tax_amount": round(float(order.get("tax_amount") or 0), 2),
            "tracking_number": str(order.get("tracking_number") or "").strip(),
            "courier": str(order.get("courier") or "").strip(),
            "is_order_settled": bool(order.get("is_order_settled")),
            "receivable": expected_receivable(
                status,
                float(order.get("total_amount") or 0),
                float(order.get("advance_amount") or 0),
                round(float(order.get("delivery_charge") or 0), 2),
                round(float(order.get("tax_amount") or 0), 2),
            ),
        }
        expect = {
            "delivery_charge": csv_dc,
            "tax_amount": csv_tax,
            "tracking_number": str(csv_row.get("tracking_number") or "").strip(),
            "courier": "PostEx",
            "is_order_settled": True,
            # The CSV's own NET_AMOUNT is the courier's figure; fall back to the formula
            # when the export omits the column.
            "receivable": money(csv_row["csv_net_amount"]) if csv_row.get("csv_net_amount") is not None
                          else expected_receivable(status, float(order.get("total_amount") or 0),
                                                   float(order.get("advance_amount") or 0), csv_dc, csv_tax),
        }
        for field in FIELDS:
            exp, act = expect[field], actual[field]
            if field == "tracking_number" and not exp:
                continue  # export did not carry one; nothing to assert
            if isinstance(exp, float) and abs(exp - act) <= 0.011:
                continue
            if exp != act:
                diffs[field].append((number, status, exp, act))

    print(f"Compared against DB: {compared}   not found in DB: {len(missing)}")
    if missing:
        shown = sorted(missing, key=lambda n: (not n.isdigit(), n))[:args.limit]
        print(f"  not found: {', '.join(shown)}{' ...' if len(missing) > len(shown) else ''}")

    total_diffs = sum(len(v) for v in diffs.values())
    print(f"\n{'FIELD':<20}{'MISMATCHES':>12}")
    print("-" * 32)
    for field in FIELDS:
        print(f"{field:<20}{len(diffs[field]):>12}")
    print("-" * 32)
    print(f"{'TOTAL':<20}{total_diffs:>12}\n")

    for field in FIELDS:
        if not diffs[field]:
            continue
        print(f"=== {field} ({len(diffs[field])}) ===")
        print(f"  {'ORDER':<9}{'STATUS':<11}{'CSV/EXPECTED':>16}{'OURS':>16}")
        for number, status, exp, act in diffs[field][:args.limit]:
            e = f"{exp:.2f}" if isinstance(exp, float) else str(exp)
            a = f"{act:.2f}" if isinstance(act, float) else str(act)
            print(f"  {number:<9}{status:<11}{e:>16}{a:>16}")
        if len(diffs[field]) > args.limit:
            print(f"  ... and {len(diffs[field]) - args.limit} more")
        print()

    if total_diffs == 0 and not missing:
        print("No discrepancies: every field matches the CSV.")
    return 1 if (total_diffs or missing) else 0


if __name__ == "__main__":
    raise SystemExit(main())

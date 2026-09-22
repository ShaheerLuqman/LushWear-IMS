"""Pre-onboarding courier reconciliation: the CPR CSVs an org uploads at
onboarding to work out what its courier still owes it.

Unlike routes/orders.py's ordinary CPR upload this posts nothing and creates no
payout rows - every settlement it records is dated before the onboarding date,
so its money arrived before the books start and belongs to the opening position.
What it produces is the *remaining* orders, which become the pre-onboarding bill
(build_pre_onboarding_bill). See PRE_ONBOARDING_COURIER_PLAN.md.
"""

import logging
from typing import Dict, List, Tuple

from app.database import get_supabase
from app.org_scope import org_table
from app.services import postex
from app.db_utils import fetch_all

logger = logging.getLogger(__name__)

# Only PostEx ships a CPR parser today. Adding a courier is a parser plus an
# entry here - the flow itself is courier-agnostic.
PARSERS = {"postex": postex.parse_rows}

# The courier name written onto orders, per courier id.
COURIER_NAMES = {"postex": "PostEx"}


def supported(courier_id: str) -> bool:
    return courier_id.lower() in PARSERS


def parse(courier_id: str, contents: List[bytes]) -> Tuple[Dict[str, dict], List[str]]:
    """Merge several CSVs into one {order_number: row} map. A later file wins on
    a duplicate, which is what re-uploading a corrected CPR should do."""
    parser = PARSERS[courier_id.lower()]
    by_order: Dict[str, dict] = {}
    numbers: List[str] = []
    for content in contents:
        rows, csv_order_numbers = parser(content)
        numbers.extend(csv_order_numbers)
        for row in rows:
            key = str(row.get("order_number") or "").strip()
            if key:
                by_order[key] = row
    return by_order, numbers


def mark_settled(org_id: str, courier_id: str, by_order: Dict[str, dict]) -> dict:
    """Write each CSV row's settlement onto its order: charges, tax, status and
    the settled flag, exactly as an ordinary CPR would - minus the folio.

    The folio is deliberately left alone. assign_courier_payouts groups settled
    orders into payout rows by folio, org-wide, and although it now refuses to
    create payouts dated before onboarding, leaving the folio off means these
    orders never enter that path at all.
    """
    supabase = get_supabase()
    wanted = sorted({int(n) for n in by_order if n.isdigit()})
    if not wanted:
        return {"matched": 0, "unmatched": sorted(by_order.keys())}

    orders = fetch_all(
        lambda: org_table(supabase, org_id, "shopify_orders")
        .select("id, order_number, order_status, total_amount, order_receiving_date, "
                "delivery_charge, tax_amount, courier, is_order_settled, tracking_number")
        .in_("order_number", wanted)
        .order("order_number")
    )
    by_number = {str(o["order_number"]): o for o in orders if o.get("order_number") is not None}

    updates = []
    matched = []
    for number, row in by_order.items():
        order = by_number.get(number)
        if order is None:
            continue
        status = (row.get("csv_order_status") or order.get("order_status") or "").strip()
        update = {
            "id": order["id"],
            "order_number": order["order_number"],
            "order_status": status,
            "total_amount": order["total_amount"],
            "order_receiving_date": order["order_receiving_date"],
            "delivery_charge": row.get("delivery_charge") or 0,
            "tax_amount": row.get("tax_amount") or 0,
            "courier": COURIER_NAMES.get(courier_id.lower(), order.get("courier")),
            "is_order_settled": True,
            "tax_amount_derived": False,
        }
        if row.get("tracking_number"):
            update["tracking_number"] = row["tracking_number"]
        updates.append(update)
        matched.append(number)

    for i in range(0, len(updates), 1000):
        org_table(supabase, org_id, "shopify_orders").upsert(updates[i:i + 1000], on_conflict="id").execute()

    return {
        "matched": len(matched),
        "unmatched": sorted(set(by_order) - set(matched)),
    }


def build_bill(org_id: str, courier_name: str, window_days: int = 60) -> dict:
    return get_supabase().rpc("build_pre_onboarding_bill", {
        "p_org_id": org_id,
        "p_courier": courier_name,
        "p_window_days": window_days,
    }).execute().data or {}

"""One-off: explains why "Products Sold by Collection" in the month summary shows
counts under "Others". Read-only - makes no writes.

Mirrors the exact resolution logic in get_month_summary_detail (app.routes.orders)
across *all* non-cancelled orders (no date filter), and reports every distinct way
a line lands in "Others":
  - "product has a non-standard collection": the line resolved to a real product,
    but that product's `collection` value isn't one of app.shopify.KNOWN_COLLECTIONS.
  - "unresolved line item": no product_id match and no name match at all.

Usage (from backend/): venv/Scripts/python.exe -m scripts.diagnose_others_collection <org_id>
"""
import sys
from collections import defaultdict

from app import shopify
from app.database import get_supabase
from app.db_utils import fetch_all
from app.org_scope import org_table
from app.services.pdf.packaging_list import _order_line_rows

KNOWN_COLLECTIONS = shopify.KNOWN_COLLECTIONS


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m scripts.diagnose_others_collection <org_id>")
    org_id = sys.argv[1]

    supabase = get_supabase()

    products_resp = org_table(supabase, org_id, "shopify_products").select("id, name, collection, price, is_active").execute()
    products_list = []
    products_map = {}
    products_by_id = {}
    non_standard_products = []  # (name, raw_collection, is_active)
    for p in (products_resp.data or []):
        name = (p.get("name") or "").strip()
        if not name:
            continue
        name_lower = name.lower()
        coll_raw = (p.get("collection") or "").strip()
        collection_display = coll_raw if coll_raw in KNOWN_COLLECTIONS else "Others"
        if collection_display == "Others":
            non_standard_products.append((name, coll_raw or "(empty)", p.get("is_active")))
        price = float(p.get("price") or 0)
        products_list.append((name_lower, collection_display, price))
        products_map[name_lower] = (collection_display, price)
        if p.get("id"):
            products_by_id[p["id"]] = (collection_display, price)
        if " - " in name:
            base = name.rsplit(" - ", 1)[0].lower().strip()
            if base and base not in products_map:
                products_map[base] = (collection_display, price)

    def resolve_item_to_collection_and_price(item_name):
        item_lower = (item_name or "").lower().strip()
        if not item_lower:
            return ("Others", 0.0)
        if item_lower in products_map:
            return products_map[item_lower]
        if " - " in item_name:
            base = item_name.rsplit(" - ", 1)[0].lower().strip()
            if base in products_map:
                return products_map[base]
        for (name_lower, coll, price) in products_list:
            if name_lower in item_lower or item_lower in name_lower:
                return (coll, price)
        return ("Others", 0.0)

    orders = fetch_all(
        lambda: org_table(supabase, org_id, "shopify_orders").select("order_status, line_items")
    )
    non_cancelled = [o for o in orders if (o.get("order_status") or "").strip().lower() != "cancelled"]

    non_standard_hits = defaultdict(lambda: [0, 0.0])   # (item_name, raw_collection) -> [count, sum]
    unresolved_hits = defaultdict(lambda: [0, 0.0])     # item_name -> [count, sum]
    total_others_count = 0

    for order in non_cancelled:
        for row in _order_line_rows(order):
            qty = row["quantity"]
            pid = row.get("product_id")
            if pid and pid in products_by_id:
                coll, price = products_by_id[pid]
                if coll == "Others":
                    matched_product = next((p for p in (products_resp.data or []) if p.get("id") == pid), None)
                    raw = ((matched_product or {}).get("collection") or "").strip() or "(empty)"
                    key = (row["product"], raw)
                    non_standard_hits[key][0] += qty
                    non_standard_hits[key][1] += price * qty
                    total_others_count += qty
                continue
            coll, price = resolve_item_to_collection_and_price(row["product"])
            if coll == "Others":
                unresolved_hits[row["product"]][0] += qty
                unresolved_hits[row["product"]][1] += price * qty
                total_others_count += qty

    print(f"KNOWN_COLLECTIONS = {KNOWN_COLLECTIONS}\n")

    print(f"== Products with a non-standard/empty `collection` value ({len(non_standard_products)}) ==")
    for name, raw, is_active in sorted(non_standard_products, key=lambda t: t[1]):
        print(f"  [{'active' if is_active else 'INACTIVE'}] {name!r}: collection={raw!r}")

    print(f"\n== Sold line items landing in 'Others' because their product's collection is non-standard ({sum(v[0] for v in non_standard_hits.values())} units) ==")
    for (item_name, raw), (count, amount) in sorted(non_standard_hits.items(), key=lambda kv: -kv[1][0]):
        print(f"  {count:>5} x {item_name!r}  (product collection={raw!r}, sum={amount:.2f})")

    print(f"\n== Sold line items with NO product match at all ({sum(v[0] for v in unresolved_hits.values())} units) ==")
    for item_name, (count, amount) in sorted(unresolved_hits.items(), key=lambda kv: -kv[1][0]):
        print(f"  {count:>5} x {item_name!r}  (sum={amount:.2f})")

    print(f"\nTotal units counted under 'Others' across all non-cancelled orders: {total_others_count}")


if __name__ == "__main__":
    main()

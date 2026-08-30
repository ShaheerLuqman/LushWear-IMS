"""The settlement upsert is an update, but Postgres evaluates NOT NULL on the proposed
row before resolving ON CONFLICT, so a payload missing any NOT NULL column without a
default fails at runtime with 23502 - as it did for `courier`. This reads the columns
back out of the schema so a newly added one fails here rather than in production."""

import re
from pathlib import Path

import pytest

SCHEMA = Path(__file__).resolve().parents[2] / "supabase" / "supabase_schema.sql"
ROUTES = Path(__file__).resolve().parents[1] / "app" / "routes" / "orders.py"

# org_id is injected by OrgScopedTable.upsert, so callers never carry it themselves.
INJECTED = {"org_id"}


def _required_columns() -> set:
    body = re.search(
        r"CREATE TABLE IF NOT EXISTS shopify_orders\s*\((.*?)\n\);", SCHEMA.read_text(encoding="utf-8"), re.S
    )
    assert body, "could not locate the shopify_orders definition"
    required = set()
    for line in body.group(1).splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith("--"):
            continue
        if "NOT NULL" in line and "DEFAULT" not in line:
            required.add(line.split()[0])
    return required - INJECTED


def _payload_keys(func_name: str) -> set:
    src = ROUTES.read_text(encoding="utf-8")
    start = src.index(f"async def {func_name}(")
    body = src[start:src.index("\n@router.", start + 1)]
    upsert_block = body[body.index("orders_to_upsert.append({"):]
    return set(re.findall(r'"(\w+)":', upsert_block[:upsert_block.index("})")]))


def test_schema_exposes_the_not_null_columns_we_expect():
    # Guards the parser itself - a silent regex miss would make the test below vacuous.
    assert {"order_number", "courier", "order_status", "total_amount", "order_receiving_date"} <= _required_columns()


@pytest.mark.parametrize("func", ["fetch_postex_settlements"])
def test_upsert_payload_covers_every_required_column(func):
    missing = _required_columns() - _payload_keys(func)
    assert not missing, f"{func}'s upsert omits NOT NULL column(s): {sorted(missing)}"

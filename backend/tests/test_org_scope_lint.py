"""Enforces the Phase 2 chokepoint (ORGANIZATIONS_USERS_PLAN.md): business
tables must only ever be touched via app.org_scope.org_table(), never
supabase.table(name) directly. A missed call site here is a silent cross-org
data leak, not just a style nit - see app/org_scope.py's module docstring for
why this lint (not RLS) is the thing actually enforcing isolation.
"""
import re
from pathlib import Path

from app.org_scope import BUSINESS_TABLES

APP_DIR = Path(__file__).resolve().parent.parent / "app"

# org_scope.py IS the chokepoint - it's the only file allowed to call
# supabase.table(<business table>) directly.
ALLOWED_FILES = {APP_DIR / "org_scope.py"}

_TABLE_CALL_RE = re.compile(r'\.table\(\s*["\'](\w+)["\']\s*\)')


def test_business_tables_are_only_touched_through_org_table():
    violations = []
    for path in APP_DIR.rglob("*.py"):
        if path in ALLOWED_FILES:
            continue
        text = path.read_text(encoding="utf-8")
        for match in _TABLE_CALL_RE.finditer(text):
            table_name = match.group(1)
            if table_name in BUSINESS_TABLES:
                line_no = text.count("\n", 0, match.start()) + 1
                rel = path.relative_to(APP_DIR.parent)
                violations.append(f"{rel}:{line_no} calls .table({table_name!r}) directly")

    assert not violations, (
        "Business tables must be accessed via app.org_scope.org_table(supabase, org_id, name), "
        "not supabase.table(name) directly:\n" + "\n".join(violations)
    )

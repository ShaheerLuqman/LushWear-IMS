"""Shared --org-name resolution for the read-only audit/reconcile scripts."""

import sys


def resolve_org_by_name(supabase, org_name: str | None) -> tuple[str, str]:
    """Resolve --org-name to (org_id, org_name), defaulting to the sole organization
    when none is given. Exits with an error listing the available names otherwise."""
    orgs = supabase.table("system_organizations").select("id, name").execute().data or []
    if org_name:
        match = [o for o in orgs if o["name"].lower() == org_name.lower()]
        if not match:
            sys.exit(f"No organization named {org_name!r}. Available: {[o['name'] for o in orgs]}")
        return match[0]["id"], match[0]["name"]
    if len(orgs) == 1:
        return orgs[0]["id"], orgs[0]["name"]
    sys.exit(f"Multiple organizations - pass --org-name. Available: {[o['name'] for o in orgs]}")

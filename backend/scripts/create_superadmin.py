"""One-off: creates a platform-level superadmin account (Superadmin Portal
plan). Deliberately a management script, not a public HTTP endpoint - this is
a rare, high-privilege operation with no ongoing need for a self-service flow,
unlike the org bootstrap (POST /auth/bootstrap) which needed a public endpoint
before any operator tooling existed.

Usage (from backend/): venv/Scripts/python.exe -m scripts.create_superadmin <email> <password>
"""
import sys

from app.auth import hash_password
from app.database import get_supabase


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python -m scripts.create_superadmin <email> <password>")
    email, password = sys.argv[1], sys.argv[2]

    supabase = get_supabase()
    existing = supabase.table("users").select("id").eq("email", email).limit(1).execute().data
    if existing:
        raise SystemExit(f"A user with email {email!r} already exists.")

    user = supabase.table("users").insert({
        "org_id": None,
        "email": email,
        "password_hash": hash_password(password),
        "role": "superadmin",
    }).execute().data[0]
    print(f"Created superadmin {user['email']!r} ({user['id']}).")


if __name__ == "__main__":
    main()

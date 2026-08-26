from pathlib import Path

# Bundled, non-code files (logos, the invoice template). Resolved from the package
# root so callers do not depend on their own module's depth in the tree.
ASSETS_DIR = Path(__file__).resolve().parent / "assets"

# Writable local cache (see app/services/courier_cities.py) - not committed
# (gitignored) and not part of the deployed image's read-only assets. On a fresh
# container/process this is simply empty, which is what makes a restart double as
# a cache refresh.
CACHE_DIR = Path(__file__).resolve().parent.parent / "_cache"

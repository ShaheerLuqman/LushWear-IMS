from pathlib import Path

# Bundled, non-code files (logos, the invoice template). Resolved from the package
# root so callers do not depend on their own module's depth in the tree.
ASSETS_DIR = Path(__file__).resolve().parent / "assets"

"""Shared slowapi Limiter instance.

Lives in its own module (not main.py) so route modules can decorate individual
endpoints with a stricter limit without importing main.py and creating a
circular import (main.py imports the routers).
"""
from slowapi import Limiter

from app.client_ip import get_client_ip

# Applies automatically to every route that isn't decorated with @limiter.limit()
# below (see main.py's SlowAPIMiddleware) - generous enough not to bother normal
# UI usage, low enough to blunt a runaway client/script.
limiter = Limiter(key_func=get_client_ip, default_limits=["120/minute"])

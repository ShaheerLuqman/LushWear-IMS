import logging
import os
import time
import uuid

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.routes import products, orders, cashbook, ledger, app_pin
from app.auth import require_auth
from app.config import settings
from app.database import get_supabase
from app.logging_config import configure_logging
from app.rate_limit import limiter

configure_logging()
logger = logging.getLogger("app")

IS_PROD = os.getenv("APP_ENV", "development").strip().lower() == "production"

_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()] or ["*"]
_wildcard = _origins == ["*"]

if IS_PROD:
    # Fail fast on configs that are silently broken in production.
    if not os.getenv("AUTH_SECRET"):
        # Without it, auth.py signs tokens with a random per-process key that
        # invalidates every session on restart/redeploy.
        raise RuntimeError("AUTH_SECRET must be set when APP_ENV=production.")
    if _wildcard:
        # allow_origins=["*"] + allow_credentials=True is rejected by browsers.
        raise RuntimeError("ALLOWED_ORIGINS must list explicit origin(s) when APP_ENV=production.")
    if not settings.shopify_store_url:
        # No dangerous default to fall back to (unlike the old staging-store default) -
        # an unset store URL must stop the boot, not surface as a 400 on the first sync.
        raise RuntimeError("SHOPIFY_STORE_URL (or SHOPIFY_API_KEY) must be set when APP_ENV=production.")

app = FastAPI(
    title="Inventory Management System",
    description="API for managing inventory",
    version="1.0.0",
    docs_url=None if IS_PROD else "/docs",
    redoc_url=None if IS_PROD else "/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=not _wildcard,  # credentials are invalid alongside a wildcard origin
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate-limits every route by default (see app/rate_limit.py); routes decorated
# with @limiter.limit(...) (the expensive sync/PDF endpoints) get their own
# stricter limit instead of the default.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


@app.middleware("http")
async def request_id_and_timing(request: Request, call_next):
    """Stamps every request/response with an id (client-supplied or generated) and
    logs one line with status + latency - the only per-request instrumentation this
    app had before was CORS. Added outermost (after CORSMiddleware, so Starlette
    treats it as the outer wrapper) to cover the full request, not just routing."""
    request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex
    request.state.request_id = request_id
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start) * 1000
    response.headers["X-Request-Id"] = request_id
    logger.info(
        "%s %s -> %d (%.1fms) request_id=%s",
        request.method, request.url.path, response.status_code, duration_ms, request_id,
    )
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

_auth = [Depends(require_auth)]
app.include_router(products.router, prefix="/api", dependencies=_auth)
app.include_router(orders.router, prefix="/api", dependencies=_auth)
app.include_router(cashbook.router, prefix="/api", dependencies=_auth)
app.include_router(ledger.router, prefix="/api", dependencies=_auth)
# Open router — self-gates via the PIN, so it bootstraps login.
app.include_router(app_pin.router, prefix="/api")


@app.get("/")
async def root():
    return {"message": "Inventory Management System API", "status": "running"}


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.get("/ready")
async def ready_check():
    """Like /health, but actually checks Supabase connectivity - what the
    frontend's online/offline indicator should poll instead of /health, which
    only proves this process is up, not that it can reach the database."""
    try:
        get_supabase().table("app_pin").select("id").limit(1).execute()
    except Exception:
        logger.exception("Readiness check failed")
        raise HTTPException(status_code=503, detail="Not ready")
    return {"status": "ready"}


if not IS_PROD:
    @app.get("/debug/routes")
    async def debug_routes():
        return {
            "routes": [
                {"path": r.path, "methods": list(r.methods)}
                for r in app.routes
                if hasattr(r, "path") and hasattr(r, "methods")
            ]
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)

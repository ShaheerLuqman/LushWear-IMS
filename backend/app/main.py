import logging
import os

from fastapi import FastAPI, Depends, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.routes import products, orders, cashbook, ledger, app_pin
from app.auth import require_auth
from app.logging_config import configure_logging

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

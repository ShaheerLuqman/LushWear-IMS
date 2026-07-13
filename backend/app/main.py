from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from app.routes import products, orders, cashbook, ledger, app_pin
from app.auth import require_auth

app = FastAPI(
    title="Inventory Management System",
    description="API for managing inventory",
    version="1.0.0"
)

# Configure CORS for Electron app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Protected routers — every route requires a valid session token (issued on PIN verify)
_auth = [Depends(require_auth)]
app.include_router(products.router, prefix="/api", dependencies=_auth)
app.include_router(orders.router, prefix="/api", dependencies=_auth)
app.include_router(cashbook.router, prefix="/api", dependencies=_auth)
app.include_router(ledger.router, prefix="/api", dependencies=_auth)

# Open router — bootstraps login (status/verify/setup/change gate themselves via the PIN)
app.include_router(app_pin.router, prefix="/api")

@app.get("/")
async def root():
    return {"message": "Inventory Management System API", "status": "running"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

@app.get("/debug/routes")
async def debug_routes():
    """Debug endpoint to list all registered routes"""
    routes = []
    for route in app.routes:
        if hasattr(route, 'path') and hasattr(route, 'methods'):
            routes.append({
                "path": route.path,
                "methods": list(route.methods)
            })
    return {"routes": routes}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)


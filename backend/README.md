# LushWear IMS — Backend API

FastAPI backend for the LushWear Inventory Management System, deployed as a
Docker container on **Northflank**. Data lives in Supabase; PDFs are generated
server-side; integrates with Shopify and PostEx.

## How it runs

- The `Dockerfile` builds the image and starts `uvicorn app.main:app`, binding the
  port Northflank provides via `$PORT` (falls back to `7860` for local runs).
- Configuration comes from **Northflank environment variables / secrets** (service
  → Environment): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SHOPIFY_*`,
  `AUTH_SECRET`, `ALLOWED_ORIGINS`. (`SUPABASE_PUBLISHABLE_KEY` is for the
  frontend, not required by the backend.)

## Endpoints

- `GET /health` — process liveness (does not touch Supabase)
- `GET /ready` — liveness + a Supabase connectivity check; poll this for an
  online/offline signal, not `/health`
- `POST /api/auth/login` — exchange email+password for a session token (the
  old shared-PIN `/api/app-pin/verify`/`/setup` are retired — see
  ORGANIZATIONS_USERS_PLAN.md)
- `/api/*` — inventory, orders, transactions, ledger (require `Authorization: Bearer <token>`)

This folder is the `backend/` subtree of the app monorepo
(`ShaheerLuqman/LushWear-IMS`).

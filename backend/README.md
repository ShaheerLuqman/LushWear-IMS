---
title: LushWear IMS API
emoji: 📦
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# LushWear IMS — Backend API

FastAPI backend for the LushWear Inventory Management System, deployed as a
Hugging Face **Docker Space**. Data lives in Supabase; PDFs are generated
server-side; integrates with Shopify and PostEx.

## How it runs here
- The `Dockerfile` builds the image and starts `uvicorn app.main:app` on port `7860`
  (declared via `app_port` above).
- Configuration comes from **Space secrets** (Settings → Variables and secrets):
  `SUPABASE_URL`, `SUPABASE_KEY`, `SHOPIFY_*`, `AUTH_SECRET`, `ALLOWED_ORIGINS`.

## Endpoints
- `GET /health` — health check
- `POST /api/app-pin/verify` — exchange the PIN for a session token
- `/api/*` — inventory, orders, cashbook, ledger (require `Authorization: Bearer <token>`)

This folder is the `backend/` subtree of the app monorepo
(`ShaheerLuqman/LushWear-IMS`), deployed here via `git subtree`.

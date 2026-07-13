# LushWear IMS — Webapp Migration Plan

Migrate the existing **Electron desktop app** to a **web app** with the backend and
frontend deployed **separately**.

## Decisions (locked in)

| Area | Choice |
|---|---|
| Backend host | **Render** (FastAPI container / native Python) |
| Frontend host | **Vercel** (static site, no build step) |
| Database | **Supabase** — unchanged, already cloud-hosted |
| Auth | **Migrate first, add auth later** (see caveat below) |

> ⚠️ **Auth caveat:** Every API endpoint is currently **unauthenticated** — the app-PIN
> only gates the UI, not the API. Until Phase 4 lands, the backend URL must stay
> **private / unindexed** (don't link it publicly). The cashbook & ledger data make
> "add auth" a required fast follow-up, not optional.

---

## Current architecture

| Layer | Stack | Notes |
|---|---|---|
| Frontend | Electron wrapping **vanilla HTML/CSS/JS** (`index.html`, `renderer.js`, `styles.css`, `utils.js`) | No framework, no build step — already a browser app inside Electron |
| Backend | FastAPI + uvicorn, Supabase, server-side PDF gen (reportlab/openpyxl), Shopify + PostEx integrations | Already pure HTTP |
| DB | Supabase (Postgres) | Nothing to migrate |

## The 3 coupling points that must change

1. **API base URL** — `frontend/renderer.js:2`
   ```js
   const API_BASE = 'http://127.0.0.1:8000/api';
   ```
   Single constant feeds all ~60 `fetch()` calls. Make it environment-driven.

2. **Electron file operations** — 14 `window.electronAPI` calls in `renderer.js`.
   Desktop-only: save PDF to disk & open, open load-sheets folder, toggle fullscreen.
   Backend already **returns PDFs as base64** — in a browser these become normal
   **browser downloads** (`Blob` + `<a download>`). Every call is already guarded with
   `if (window.electronAPI && ...)`, so we add web fallbacks in the `else` branch.

3. **CORS** — `backend/app/main.py:12` is `allow_origins=["*"]`. Pin to the Vercel origin.

4. **Content-Security-Policy** — `frontend/index.html:8` meta tag had
   `connect-src http://127.0.0.1:8000`, which would **block fetch to the Render
   backend** even with `API_BASE` set correctly. Widened to
   `connect-src 'self' http://127.0.0.1:8000 https:` (migrate-first); tighten to the
   exact Render origin in Phase 3.

## Known non-issues
- `pywin32` is Windows-only in `requirements.txt` but **not imported anywhere** — won't block Linux deploy.
- Secrets live in `backend/.env` (gitignored). They move into Render's env-var settings, never committed.

---

## Target architecture

```
┌─────────────────────┐         ┌──────────────────────┐        ┌───────────┐
│  Frontend (static)  │  HTTPS  │  Backend (FastAPI)   │        │ Supabase  │
│      Vercel         │ ──────► │       Render         │ ─────► │ (Postgres)│
│  HTML/CSS/JS        │  fetch  │  uvicorn app.main    │        └───────────┘
└─────────────────────┘         └──────────────────────┘
                                       └──► Shopify / PostEx
```

---

## Migration phases

### Phase 1 — De-Electron the frontend (local, no deploy) ✅ DONE
1. ✅ Made `API_BASE` runtime-configurable: added `frontend/config.js` (loaded before
   `renderer.js` in `index.html`) that sets `window.API_BASE`. Local stays
   `http://127.0.0.1:8000/api`; on Vercel it becomes the Render URL. `renderer.js:2`
   now reads `window.API_BASE` with the local default as fallback.
2. ✅ Browser-download fallbacks were **already present** — every `window.electronAPI`
   call site already had a guarded `else` branch (load-sheet & invoice PDFs download
   via `Blob`, open-folder shows a "desktop only" toast, fullscreen guarded + CSS
   fullscreen still works). No changes needed.
3. ✅ Widened the CSP `connect-src` (coupling point #4 above) so the deployed bundle
   can reach an HTTPS backend.
4. ✅ Result: `index.html` + `renderer.js` + `styles.css` + `utils.js` + `config.js` +
   `assets/` = static bundle runnable in any browser. Electron files (`main.js`,
   `preload.js`, `package.json`) stay in repo but are excluded from the web deploy.

**Verified locally:** backend on `:8011`, frontend static-served on `:8012` — page
loads with config.js in correct order, live API returns product data, cross-origin
CORS preflight passes.

### Phase 1b — Full Electron removal ✅ DONE
Went beyond fallbacks and removed Electron entirely — the frontend is now a pure
static web app:
- Deleted `frontend/main.js`, `frontend/preload.js`, `frontend/package-lock.json`,
  `frontend/node_modules/`, the macOS build (`Inventory Manager.app/`), and the
  Electron launchers (`start-app.{bat,command,ps1,vbs}`, `start-frontend.bat`).
- Rewrote `frontend/package.json` as static-site metadata (no Electron; `dev` serves
  the folder).
- Stripped all 14 `window.electronAPI` call sites from `renderer.js`: PDF/load-sheet
  actions now always use browser download/open; fullscreen uses the browser
  Fullscreen API; removed the desktop-only "Open folder" button.
- Removed the Electron-only `-webkit-app-region: drag` CSS (kept the slim top bar as a
  branded web header).
- Updated `README.md` to describe the web app.
- Kept `start-backend.bat`.

### Phase 2 — Backend deploy prep
4. Add `backend/Dockerfile` (or use Render native Python) running
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
5. Pin CORS in `main.py` to the Vercel domain via an `ALLOWED_ORIGINS` env var.
6. Confirm PDF gen is headless-safe on Linux (reportlab/openpyxl are pure Python — fine).

### Phase 3 — Deploy
7. **Render:** connect repo, root = `backend/`, set env vars (Supabase + Shopify +
   `ALLOWED_ORIGINS`), deploy → get `https://...onrender.com`.
8. **Vercel:** connect repo, root = `frontend/`, no build step, set `API_BASE` to the
   Render URL → deploy.
9. Smoke-test end to end (products load, order sync, PDF download).

### Phase 4 — Add auth ✅ DONE (moved *before* deploy)
Single shared PIN → signed session token → every data route protected. Chosen over
open-deploy because a Render URL is internet-reachable; the token plumbing is reused
when full users/orgs/RBAC lands later (only the identity model changes).

**Backend:**
- `backend/app/auth.py` — PyJWT HS256 token create/verify + `require_auth` dependency.
  Secret from `AUTH_SECRET` env (random per-process fallback in dev). TTL from
  `AUTH_TOKEN_TTL_HOURS` (default 168h / 7 days).
- `app_pin.py` `/verify` and `/setup` now return `{ok, token}`.
- `main.py` guards products/orders/cashbook/ledger routers with `Depends(require_auth)`.
  `app-pin/*`, `/health`, `/` stay open (bootstrap login). CORS preflight unaffected.
- Added `PyJWT` to `requirements.txt`; `AUTH_SECRET` to `.env`.

**Frontend (`renderer.js`):**
- fetch wrapper injects `Authorization: Bearer <token>` on API calls; global 401 →
  clears token + re-opens PIN gate ("Session expired"). Token in `sessionStorage`.
- PIN verify/setup store the returned token; removed the pre-login prefetch (would
  401 without a token).

**Verified (backend):** no token → 401, valid token → 200, bogus token → 401,
OPTIONS preflight → 200. Browser login flow pending manual PIN test.

> **Deploy note:** set `AUTH_SECRET` (long random string) on Render — without it,
> tokens are invalidated on every restart/deploy.

---

## Deliverables
- `frontend/config.js` + edits to `index.html` / `renderer.js`
- `backend/Dockerfile` (+ optional `render.yaml`)
- `vercel.json` (static config)
- Updated `README.md` deploy section

## Notes
- Work on a **`webapp-migration`** branch so the desktop app on `main` stays intact.
- Changes are **additive** — the Electron desktop app keeps working after migration.

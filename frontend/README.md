# frontend/engine

The QuikMerchant frontend as a React + TypeScript SPA (Vite), replacing the
old raw HTML/JS app in `frontend/` (`index.html`, `admin.html`,
`frontend/js/*.js`). This is being migrated in over several passes - see the
migration plan for the batch order. Old files are deleted as each is ported,
not kept in parallel.

Architecture:
- `src/api.ts` - API base URL + auth-token storage + typed `apiFetch`/`apiJson`.
- `src/auth/AuthContext.tsx` - session state (`useAuth()`): account, enabled
  features, edit lock, login/logout, superadmin org-impersonation flow.
- `src/theme/ThemeContext.tsx` - light/dark theme (`useTheme()`).
- `src/toast/ToastContext.tsx` + `NotificationBell.tsx` - toasts + the header
  notification history (`useToast()`).
- `src/layout/AppShell.tsx` - sidebar nav + header, wraps every route via
  `<Outlet/>`; each page sets its own header title/toolbar with
  `usePageHeader()` (`src/layout/PageHeaderContext.tsx`).
- `src/App.tsx` - routes (`react-router`, `BrowserRouter`).
- `src/pages/*` - one component per view, replacing the matching
  `frontend/js/*.js` file(s). Views not yet migrated render `<Placeholder/>`.
- `src/styles.css` - the app's existing visual design, carried over unchanged.

## Develop

```
npm install
npm run dev     # Vite dev server, http://localhost:5173
npm run build   # tsc -b && vite build -> dist/
```

Port 5173 is already in the backend's `ALLOWED_ORIGINS` (`backend/.env`), so
no proxy/CORS setup is needed for local dev against the local backend.

`frontend/vercel.json` isn't wired to this project yet - that happens once the
migration is complete and the old `frontend/index.html`/`admin.html`/`js/*`
are deleted.

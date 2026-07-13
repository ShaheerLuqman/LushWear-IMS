// Runtime configuration for the web app.
//
// Loaded before renderer.js. `window.API_BASE` is the base URL for all backend
// API calls. Locally (and in the Electron desktop app) it points at the local
// backend. For the deployed web app, override this value with the public backend
// URL — either edit this line, or replace this file at deploy time (e.g. Vercel).
//
// Example (production): 'https://lushwear-ims.onrender.com/api'
window.API_BASE = window.API_BASE || 'http://127.0.0.1:8000/api';

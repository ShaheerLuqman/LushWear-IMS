import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Normal Vite SPA build (replaces the earlier lib/IIFE build that used to
// inject a bundle into the old, now-retired frontend/index.html). Dev server
// runs on port 8080, already present in the backend's ALLOWED_ORIGINS
// (backend/.env) - no proxy needed for local dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 8080,
  },
});

// Exists only to satisfy PWA installability criteria (desktop shortcut prompt).
// No caching - this app reads live data from a local backend, so it must never
// serve stale responses.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

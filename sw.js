/**
 * sw.js — the service worker, so the phone keeps working off the network.
 *
 * Cache-first for everything, because all of it is static and the whole point
 * is that once the phone has it, it does not need this machine again. Bump
 * CACHE when you rebuild data.js or the app will keep serving the old copy:
 * that is the one failure mode of a cache-first worker, and with financial
 * figures a silently stale number is worse than no number.
 *
 * `node deploy-check.js` prints the version this file claims against the
 * build stamp in data.js, so the two cannot drift unnoticed.
 */
/* Bump on every deploy, or an installed phone keeps serving the old app.
   deploy.js does it automatically and refuses to push if it has not. */
const CACHE = 'ledger-v18';

/* The shipped app, and nothing else. data.js and accounts.js are your
   records and are not part of it - the app starts empty and you import. */
const FILES = [
  './',
  './index.html',
  './schema.js',
  './dataset.js',
  './backend.js',
  './core.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  /* addAll is atomic: if one file fails the whole install fails, which is
     right - a half-cached app that opens and then throws is worse than one
     that did not install. */
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        /* Refresh in the background so the next open is current, but answer
           now from cache - a six megabyte data.js over wi-fi is not something
           to wait for every launch. */
        e.waitUntil(fetch(e.request)
          .then((r) => (r && r.ok ? caches.open(CACHE).then((c) => c.put(e.request, r)) : null))
          .catch(() => {}));
        return hit;
      }
      return fetch(e.request).catch(() => caches.match('./index.html'));
    })
  );
});

/* SnapCal service worker — app shell cached so the tracker opens offline.
   Bump CACHE when any shell file changes. */
const CACHE = 'snapcal-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'foods.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never touch api.anthropic.com

  // Shell files: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request).then(hit => {
      const fetched = fetch(request)
        .then(res => {
          if (res && res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
          return res;
        })
        .catch(() => hit || caches.match('index.html'));
      return hit || fetched;
    })
  );
});

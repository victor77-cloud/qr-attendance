/* Offline QR Attendance PWA — service worker.
 * Precaches the whole app shell on install; serves cache-first afterwards.
 * The network is treated as permanently unavailable: nothing in the app
 * consults a server. Cache is versioned; updates require re-provisioning.
 */
const CACHE = 'qr-attendance-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './qrcode-generator.js',
  './jsqr.js',
  './db.js',
  './crypto.js',
  './codec.js',
  './qr.js',
  './app.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    caches
      .match(request, { ignoreSearch: true })
      .then((hit) => hit || fetch(request))
      .catch(() => caches.match('./index.html'))
  );
});

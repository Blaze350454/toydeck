// Offline cache: always try the network first (so updates show up immediately),
// fall back to the cached copy when offline.
const CACHE = 'toydeck-v28';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'toys/j-faunus.webp', 'toys/j-flamewing.webp', 'toys/j-petalwish.webp', 'toys/j-phantom.webp', 'toys/j-pinhead.webp', 'toys/j-punch.webp',
  'toys/j-rhythmic3.webp', 'toys/j-rosella.webp', 'toys/j-royaleye.webp', 'toys/j-viele.webp', 'toys/j-vividwings.webp',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(e.request, { cache: 'no-cache' });
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        return (await cache.match(e.request, { ignoreSearch: true })) ?? Response.error();
      }
    }),
  );
});

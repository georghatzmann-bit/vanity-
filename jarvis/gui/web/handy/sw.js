/* Jarvis als App: macht sie installierbar und lädt das Gerüst auch ohne Netz (mit Hinweis
   "PC nicht erreichbar"). Befehle (/api) gehen immer direkt an den PC, nie aus dem Speicher. */
const CACHE = 'jarvis-app-v2';
const SHELL = ['./', 'index.html', 'handy.css', 'handy.js', 'orb.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith('/app/')) return;
  // Erst das Netz (immer die neueste Version), ohne Netz der letzte Stand
  event.respondWith(fetch(event.request)
    .then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    })
    .catch(() => caches.match(event.request, { ignoreSearch: true })));
});

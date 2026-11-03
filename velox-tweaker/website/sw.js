/* VELOX website - offline cache for the BIOS checklist (bios.html) only.
 * Registered by assets/js/bios.js. It answers only the files listed below (from the cache,
 * refreshed in the background); every other request goes to the network untouched.
 * The URL fragment with the PC data never reaches a service worker or a server. */
'use strict';
const CACHE = 'velox-bios-v1';
const FILES = [
  'bios.html',
  'brand/tokens.css',
  'brand/app-icon.svg',
  'brand/wordmark-small.svg',
  'brand/wordmark-small-light.svg',
  'assets/css/site.css',
  'assets/css/bios.css',
  'assets/js/theme.js',
  'assets/js/site.js',
  'assets/js/bios.js',
  'assets/data/bios/recommendations.json',
  'assets/icons/app-icon-32.png',
];
const scope = new URL(self.registration ? self.registration.scope : './', self.location.href);
const URLS = FILES.map((f) => new URL(f, scope).href);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('velox-bios-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  url.hash = '';
  url.search = '';
  const key = url.href;
  if (URLS.indexOf(key) < 0) return;                       // not ours: plain network
  e.respondWith(caches.open(CACHE).then((cache) => cache.match(key).then((hit) => {
    const fresh = fetch(key, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => hit);
    if (hit) { e.waitUntil(fresh.catch(() => null)); return hit; }   // stale-while-revalidate
    return fresh;
  })));
});

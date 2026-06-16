// Deck OS service worker — offline shell + Scryfall image cache.
// HTML is network-first (so hot-served edits still land); images are cache-first; /api is never cached.
const CACHE = 'deckos-v3';
const IMG_CACHE = 'deckos-img-v1';
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.indexOf('deckos-') === 0 && k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Never cache the API.
  if (url.origin === location.origin && url.pathname.indexOf('/api/') === 0) return;

  // Scryfall card images → cache-first runtime cache.
  const isScryfallImg = url.hostname.endsWith('scryfall.io') ||
    (url.hostname.endsWith('scryfall.com') && url.pathname.indexOf('/cards') >= 0);
  if (isScryfallImg) {
    e.respondWith(caches.open(IMG_CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res && res.ok) c.put(req, res.clone()); return res; }
      catch (_) { return hit || Response.error(); }
    }));
    return;
  }

  // Navigations / documents → network-first, fall back to the cached shell offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req).then(res => { caches.open(CACHE).then(c => c.put('/', res.clone())); return res; })
        .catch(() => caches.match('/').then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // Other same-origin static (icons, etc.) → stale-while-revalidate.
  if (url.origin === location.origin) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

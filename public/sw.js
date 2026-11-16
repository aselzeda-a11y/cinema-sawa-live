'use strict';
// Network-first: app updates are preferred; cache only the public shell for offline viewing.
const CACHE = 'cinema-sawa-v2-shell';
const SHELL = ['/', '/index.html', '/app.js', '/screen.js', '/realtime.js', '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/events' || url.pathname==='/health') return;
  event.respondWith(fetch(req).then(res => {
    if (res.ok && ['/',...SHELL].includes(url.pathname)) {
      const clone=res.clone();caches.open(CACHE).then(cache => cache.put(req,clone)).catch(()=>{});
    }
    return res;
  }).catch(async()=> (await caches.match(req)) || Response.error()));
});

/* ============================================================
   sw.js — network-first with a cache fallback.

   Network-first is the right call for a single-page app that ships
   its whole UI in a handful of files: you always get the newest
   build, and you still work offline from the last good copy.
   ============================================================ */

const CACHE = 'aria-os-shell-v2';
const SHELL = [
  './index.html',
  './css/app.css',
  './js/local.js',
  './js/supabase.js',
  './js/config.js',
  './js/store.js',
  './js/api.js',
  './js/memory.js',
  './js/clone.js',
  './js/ui.js',
  './js/admin.js',
  './js/app.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => null));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('aria-os-shell-') && k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // never cache API traffic or the Supabase endpoint
  if (url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html'))),
  );
});

/* The app posts {type:'NOTIFY', title, body, tag} when she misses you. */
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'NOTIFY') return;
  self.registration.showNotification(e.data.title || 'Aria OS', {
    body: e.data.body || 'She left you a message.',
    tag: e.data.tag || 'aria-os',
    renotify: true,
    icon: './assets/icon-192.png',
    badge: './assets/icon-192.png',
    data: { url: './index.html' },
  });
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return clients.openWindow(e.notification.data?.url || './index.html');
    }),
  );
});

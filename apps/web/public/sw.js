/* Bee service worker: offline app shell and API copies, and Web Push notifications. */
const SHELL = 'bee-shell-v1';
const API = 'bee-api-v1';
// Never served from a copy: live counts, AI, credentials.
const API_SKIP = /^\/api\/(notifications|ai|tokens|connected-apps|push-subscriptions|auth\/(login|logout|register|password))/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('bee-') && k !== SHELL && k !== API).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Network first; the last good response when offline. */
async function networkFirst(request, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') cache.put(key ?? request, res.clone());
    // Server or tunnel down (502/503/504): the copy is better than an error page.
    if (res.status >= 502) return (await cache.match(key ?? request)) ?? res;
    return res;
  } catch (err) {
    const hit = await cache.match(key ?? request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    // Every page is the same app shell.
    event.respondWith(networkFirst(req, SHELL, '/'));
  } else if (url.pathname.startsWith('/assets/')) {
    // Hashed file names: a copy never goes stale.
    event.respondWith(
      caches.open(SHELL).then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            }),
        ),
      ),
    );
  } else if (url.pathname.startsWith('/api/') && !API_SKIP.test(url.pathname)) {
    event.respondWith(networkFirst(req, API));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Bee', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Bee', {
      body: data.body || '',
      tag: data.tag,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  // Only ever open Bee itself.
  const target = url.origin === self.location.origin ? url.href : self.location.origin;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) return open.focus().then((c) => c.navigate(target));
      return self.clients.openWindow(target);
    }),
  );
});

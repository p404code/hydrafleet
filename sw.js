const CACHE_NAME = 'hydralink-v62';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/lohn.html',
  '/manifest.json',
  '/fahrer/',
  '/fahrer/manifest.json',
  '/bank-logik.js',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/apple-touch-icon.png',
  '/favicon-32x32.png',
  '/favicon-16x16.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,700;9..144,900&display=swap'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('supabase.co')) return;
  if (e.request.url.includes('n8n.hydrafleet.at')) return;
  if (e.request.method !== 'GET') return;

  /* HTML pages: network-first to always get latest deploy */
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  /* Static assets: stale-while-revalidate */
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
      return cached || fetchPromise;
    })
  );
});

/* Web-Push (Fahrer-Nachrichten): Text kommt von push-senden, Klick öffnet den Chat */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  // Zahl ungelesener Nachrichten am App-Symbol (iPhone ab iOS 16.4 als Home-Bildschirm-App, manche Android-Launcher)
  const symbol = Number.isInteger(d.ungelesen) && self.navigator && self.navigator.setAppBadge
    ? self.navigator.setAppBadge(d.ungelesen).catch(() => {}) : null;
  // offene Fahrerapp holt sofort neu (Zaehler am Reiter, Banner)
  const offen = clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenster) => fenster
    .filter((c) => new URL(c.url).pathname.startsWith('/fahrer')).forEach((c) => c.postMessage({ typ: 'neu' })));
  e.waitUntil(Promise.all([self.registration.showNotification(d.title || 'HYDRAlink', {
    body: d.body || 'Neue Nachricht vom Büro',
    tag: d.tag || 'nachrichten',
    renotify: true,
    icon: '/icon-192x192.png',
    badge: '/icon-192x192.png',
    data: { url: d.url || '/fahrer/#nachrichten' }
  }), symbol, offen]));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const ziel = (e.notification.data && e.notification.data.url) || '/fahrer/#nachrichten';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenster) => {
    const app = fenster.find((c) => new URL(c.url).pathname.startsWith('/fahrer'));
    if (app) { app.postMessage({ typ: 'nachrichten' }); return app.focus(); }
    return clients.openWindow(ziel);
  }));
});

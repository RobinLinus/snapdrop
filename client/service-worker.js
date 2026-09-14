var CACHE_NAME = 'snapdrop-cache-v23';
var urlsToCache = [
  'index.html',
  './',
  'styles.css',
  'vendor/msgpack.min.js',
  'scripts/protocol.js',
  'scripts/network.js',
  'scripts/ui.js',
  'scripts/clipboard.js',
  'sounds/blop.mp3',
  'images/favicon-96x96.png'
];

self.addEventListener('install', function(event) {
  // Perform install steps
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      }).then(() => self.skipWaiting())
  );
});


self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request)
      .then(function(response) {
        // Cache hit - return response
        if (response) {
          return response;
        }
        return fetch(event.request);
      }
    )
  );
});


self.addEventListener('activate', function(event) {
  console.log('Updating Service Worker...')
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(cacheName) {
          // Return true if you want to remove this cache,
          // but remember that caches are shared across
          // the whole origin
          return cacheName.startsWith('snapdrop-cache-') && cacheName !== CACHE_NAME
        }).map(function(cacheName) {
          return caches.delete(cacheName);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data || {};
    if (event.action && event.action !== 'open') return;
    if (data.link) {
      let link;
      try { link = new URL(data.link); } catch (_) { return; }
      if (link.protocol !== 'https:' && link.protocol !== 'http:') return;
      return self.clients.openWindow(link.href);
    }
    const url = new URL(data.url || './', self.registration.scope);
    if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(client => client.url === url.href);
    if (client) return client.focus();
    return self.clients.openWindow(url.href);
  })());
});

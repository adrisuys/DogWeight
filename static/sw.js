/* ==========================================================================
   Service worker: make the shell installable and usable on a bad connection.

   The split is deliberate and narrow:

   * **The shell** (HTML, CSS, JS, icons) is cached on install and served
     cache-first. It changes only when this file's VERSION does.
   * **The API** is never cached. A stale weight is worse than no weight —
     the whole point of the app is the number being current — so a failed
     request fails rather than quietly answering with last week's.
   * **Photos** are cached on first fetch and kept forever, because their
     names are content hashes and can never mean anything else.
   ========================================================================== */

const VERSION = 'dog-v1';
const SHELL = `${VERSION}-shell`;
const PHOTOS = `${VERSION}-photos`;

const SHELL_FILES = [
  '/', '/index.html', '/styles.css', '/app.js', '/charts.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, so one missing icon doesn't fail the whole install.
    await Promise.all(SHELL_FILES.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;      // always live

  if (url.pathname.startsWith('/images/')) {
    event.respondWith((async () => {
      const cache = await caches.open(PHOTOS);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) {
      // Refresh in the background so the next load has the new build without
      // this one having to wait for the network.
      event.waitUntil(
        fetch(request).then((response) => {
          if (response.ok) cache.put(request, response.clone());
        }).catch(() => {}),
      );
      return hit;
    }
    try {
      return await fetch(request);
    } catch (error) {
      // A navigation offline still gets the app shell; the API calls inside
      // it will fail and say so, which is the honest outcome.
      if (request.mode === 'navigate') {
        const shell = await cache.match('/index.html');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});

/* Build placeholders are replaced after all assets have been emitted. */
const scope = self.registration.scope;
const prefix = `reader-shell:${scope}:`;
const cacheName = `${prefix}__VERSION__`;
const files = __PRECACHE__;
const urls = files.map((file) => new URL(file, scope).href);
const shell = new URL('index.html', scope).href;
const manifest = new URL('manifest.webmanifest', scope).href;

self.addEventListener('install', (event) => {
  // Reload bypasses HTTP caches for the fixed-name Android-compatible bundle.
  // Wait for the reader's explicit update action before replacing open pages.
  event.waitUntil(caches.open(cacheName).then((cache) =>
    cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== new URL(scope).origin) return;
  // Only the application shell belongs here. Account data and book bodies use
  // the existing account-scoped stores, never a shared HTTP response cache.
  const home = new URL(scope).pathname;
  const isHome = request.mode === 'navigate' && (url.pathname === home || url.pathname === new URL(shell).pathname);
  const key = isHome ? shell : url.href;
  if (!isHome && !urls.includes(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    // Opening the app checks in with the server first. A shell served straight from cache
    // never reaches the server, so a gateway in front of it (e.g. an SSO proxy) never gets
    // to send an expired session to its login page; the page keeps working off /api while
    // every update check (sw.js and the precache, both behind that gateway) silently fails,
    // pinning the old version. So: a redirect or client error (the gateway's login flow) is
    // handed to the browser; a successful response only proves the session and is dropped
    // in favour of this worker's cached shell, which keeps the HTML on the same release as
    // the cached assets until the reader accepts an update. A network failure, a server
    // error or no answer within 4 s also uses the cached shell.
    if (isHome) {
      const cached = await cache.match(shell);
      let useCache = false;
      const network = fetch(request).then((response) => {
        // Arrived after the cached shell was chosen: drop the body instead of downloading it.
        if (useCache) void response.body?.cancel().catch(() => {});
        return response;
      }, () => null);
      if (!cached) return (await network) ?? fetch(request);
      const slow = new Promise((resolve) => setTimeout(() => resolve(undefined), 4000));
      const response = await Promise.race([network, slow]);
      // Only the gateway's login flow goes to the browser: a redirect (opaqueredirect has
      // status 0) or 401/403. Rate limits, other errors and timeouts keep the cached shell.
      if (response && (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
        || response.status === 401 || response.status === 403)) return response;
      useCache = true;
      void response?.body?.cancel().catch(() => {});
      return cached;
    }
    // The manifest is network-first: Chrome re-reads it to update an installed app
    // (orientation, icons, colours), and a cache-first copy would pin every install to
    // the manifest it first cached until the reader happened to accept an update.
    if (key === manifest) {
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) return response;
      } catch { /* Offline: the cached copy below. */ }
    }
    return (await cache.match(key)) ?? fetch(request);
  })());
});

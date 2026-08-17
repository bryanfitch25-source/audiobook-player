const CACHE = 'the-pattern-v24';
const SHELL = [
  './', './index.html', './style.css', './app.js', './metadata.js', './computer.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

// Lets the page ask "which version are you actually serving" directly,
// rather than trusting that a reload picked up the latest one. Replies
// through the MessageChannel port the page sent, not a broadcast, so the
// page's one-shot listener for this specific query actually receives it.
self.addEventListener('message', (e) => {
  if (e.data === 'get-version' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ swVersion: CACHE });
  }
});

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // A service worker intercepts requests from any page it controls, even ones
  // aimed at a completely different path -- so without this exclusion, calls
  // to the PC server's /api/* (book listings, downloads) would get cached and
  // permanently frozen at whatever they returned the first time, immune to
  // reloads and to the caller's own `cache: "no-store"`. Library contents
  // change constantly; those calls always go straight to the network.
  //
  // Deliberately not calling e.respondWith() here at all, not even to relay a
  // plain fetch -- doing that still routes the entire response through this
  // worker's own JS context and process boundary before the page sees it.
  // For a multi-hundred-MB audiobook download, that extra hop was enough
  // memory/process overhead on its own to get the tab killed right as the
  // transfer finished. Not calling respondWith() lets the browser handle the
  // request completely natively, exactly as if no service worker existed.
  if (/\/api\//.test(new URL(e.request.url).pathname)) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const clone = res.clone();
        // Caching the ~32MB ffmpeg core is what makes offline conversion work,
        // but it is also the one put that can blow the quota. Never let it reject.
        caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
      }
      return res;
    }).catch(() => hit))
  );
});

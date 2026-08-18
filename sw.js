const CACHE = 'the-pattern-v28';
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

// Matches the single-file streaming endpoint a playing book's <audio>
// element points at, e.g. /<token>/api/books/winters-heart/file. Everything
// else under /api/ (book listings, imports) is excluded below and always
// goes straight to the network -- only this route has a prefetched buffer
// worth falling back to.
const STREAM_FILE_RE = /\/api\/books\/[^/]+\/file$/;

// Reads the byte range app.js's maintainStreamBuffer() prefetched ahead of
// playback out of Cache Storage, and reconstructs exactly the byte range the
// <audio> element is asking for from it. Used only when the live network
// request for that range has just failed -- e.g. the signal dropped -- so a
// buffered book keeps playing instead of stalling.
async function serveFromBuffer(request) {
  const url = new URL(request.url);
  const streamUrl = url.origin + url.pathname;
  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader) return null;
  const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!m) return null;
  const reqStart = Number(m[1]);
  let reqEnd = m[2] ? Number(m[2]) : null;

  const cache = await caches.open('stream-buf:' + streamUrl);
  const keys = await cache.keys();
  const chunks = [];
  for (const req of keys) {
    const res = await cache.match(req);
    if (!res) continue;
    const cr = res.headers.get('Content-Range'); // "bytes start-end/total"
    const cm = cr && /bytes (\d+)-(\d+)\/(\d+)/.exec(cr);
    if (!cm) continue;
    chunks.push({ start: Number(cm[1]), end: Number(cm[2]), total: Number(cm[3]), response: res });
  }
  if (!chunks.length) return null;
  chunks.sort((a, b) => a.start - b.start);
  const total = chunks[0].total;
  if (reqEnd === null) reqEnd = total - 1;

  // Walk the sorted chunks and confirm the whole requested range is covered
  // by contiguous, gap-free cached pieces -- a partial match would mean
  // handing the audio element a range with a hole in it.
  let cursor = reqStart;
  const parts = [];
  for (const c of chunks) {
    if (cursor > reqEnd) break;
    if (c.start > cursor) break; // gap right where we need bytes next
    if (c.end < cursor) continue;
    const sliceStart = cursor;
    const sliceEnd = Math.min(c.end, reqEnd);
    parts.push({ chunk: c, sliceStart, sliceEnd });
    cursor = sliceEnd + 1;
  }
  if (cursor <= reqEnd) return null; // not fully covered -- let it fail normally

  const blobParts = [];
  for (const p of parts) {
    const blob = await p.chunk.response.clone().blob();
    const offsetInChunk = p.sliceStart - p.chunk.start;
    const len = p.sliceEnd - p.sliceStart + 1;
    blobParts.push(blob.slice(offsetInChunk, offsetInChunk + len));
  }
  const bodyBlob = new Blob(blobParts);
  const contentType = chunks[0].response.headers.get('Content-Type') || 'application/octet-stream';

  return new Response(bodyBlob, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${reqStart}-${reqEnd}/${total}`,
      'Content-Length': String(bodyBlob.size),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function handleStreamFileFetch(request) {
  try {
    // This is a cross-origin request (the PC server is always a different
    // origin from wherever the app itself is served) made without the
    // <audio> element setting crossOrigin, so the response here is opaque:
    // res.ok is always false and res.status is always 0, regardless of
    // whether the real request actually succeeded. There is no way to
    // inspect it, only to pass it straight through -- so success or failure
    // is judged solely by whether fetch() itself threw, which is what a
    // genuine network failure (signal dropped, server unreachable) does.
    return await fetch(request);
  } catch (e) {
    const buffered = await serveFromBuffer(request);
    if (buffered) return buffered;
    throw e;
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const pathname = new URL(e.request.url).pathname;

  if (STREAM_FILE_RE.test(pathname)) {
    e.respondWith(handleStreamFileFetch(e.request));
    return;
  }

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
  if (/\/api\//.test(pathname)) {
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

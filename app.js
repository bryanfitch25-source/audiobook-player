/* The Pattern -- unified audiobook player. Local imports live in IndexedDB on
 * this device; PC books stream straight from the server with no on-device
 * copy unless explicitly kept offline. The catalog merges both into one list. */

// Bumped in lockstep with sw.js's CACHE constant. Shown in the UI so there is
// never any ambiguity, after a service-worker update, about whether the code
// actually running is the code that was just shipped.
const APP_VERSION = 'the-pattern-v30'; // must exactly match CACHE in sw.js

const DB_NAME = 'audiobook-player';
const DB_VERSION = 2;
let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const _db = req.result;
      if (!_db.objectStoreNames.contains('books')) {
        _db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains('chapterBlobs')) {
        _db.createObjectStore('chapterBlobs', { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains('diagLog')) {
        _db.createObjectStore('diagLog', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    // A transaction can abort with tx.error === null under memory/storage
    // pressure on at least one real device -- this was previously only
    // listening for onerror, so that case surfaced as a bare `null` with
    // zero diagnostic value. Listening for onabort too, and building a real
    // message from whatever's actually available (the request's own error,
    // the transaction's, or a fallback naming what almost certainly caused
    // it) turns that into something a diagnostic log can actually show.
    const fail = () => {
      const detail = (req.error && req.error.message) || (tx.error && tx.error.message)
        || 'transaction aborted with no error detail (commonly storage/memory pressure)';
      reject(new Error(detail));
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}
function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    const fail = () => {
      const detail = (req.error && req.error.message) || (tx.error && tx.error.message)
        || 'transaction aborted with no error detail';
      reject(new Error(detail));
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

/* Writes several values in one transaction rather than one each. On real
 * device data, per-chunk write time roughly tripled between the first five
 * 4MB chunks and the next five (3.3s -> 8.6s each) within a *single* import
 * on freshly-cleared storage -- not a fixed "this device is slow" cost, but
 * one that compounds as writing continues. That shape points at per-
 * transaction overhead (each one committing/syncing independently) rather
 * than per-byte cost, which batching several chunks into one transaction
 * directly reduces: 1/8th as many commits for the same data. */
function idbPutBatch(storeName, values) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const v of values) store.put(v);
    tx.oncomplete = () => resolve();
    const fail = () => {
      const detail = (tx.error && tx.error.message) || 'transaction aborted with no error detail';
      reject(new Error(detail));
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

/* Audiobooks run up to a couple of GB. Writing one that large into IndexedDB
 * as a single value crashes this app on at least one real device -- true
 * whether the source is a freshly-downloaded Blob or a plain File handed
 * straight from the OS file picker, so the failure is IndexedDB's structured
 * clone of one huge value, not anything about how the data was obtained.
 * The fix is to never ask it to do that: every chapterBlobs entry is written
 * as many chunks, several per transaction, instead of one value in one.
 * Reassembling them with new Blob([...chunks]) at playback time is cheap --
 * Blobs are handles, not copies, so combining several doesn't re-materialize
 * the audio in JS memory the way writing one giant value to IndexedDB
 * apparently does. */
const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNKS_PER_TRANSACTION = 8; // 32MB/transaction at the chunk size above

/* Streamed books have no on-device copy at all, so a brief signal drop --
 * walking into a building, an elevator, the tunnel hiccuping -- would
 * otherwise stall playback the instant the network request for the next
 * range fails. To ride that out, the app keeps prefetching ahead of the
 * playback position into the Cache Storage API (disk-backed, built for
 * exactly this kind of large binary response, unlike IndexedDB) while
 * online, and the service worker serves from that cache when the network
 * request for the live stream fails. Byte ranges rather than time ranges,
 * since that's what the server actually understands; the current byte
 * position is only an estimate from the book's overall average bitrate,
 * which is fine for deciding how far ahead to prefetch. The window itself is
 * a user setting (10/30/60 min), not fixed -- read from localStorage so it
 * survives a reload. */
const STREAM_BUFFER_CHUNK_BYTES = 1 * 1024 * 1024; // 1MB per prefetched piece
const STREAM_BUFFER_EVICT_MARGIN_BYTES = STREAM_BUFFER_CHUNK_BYTES * 2; // small cushion behind playback before dropping old chunks
const STREAM_BUFFER_MIN_INTERVAL_MS = 15000;
const BUFFER_MINUTES_KEY = 'stream-buffer-minutes';
let STREAM_BUFFER_AHEAD_SECONDS = (Number(localStorage.getItem(BUFFER_MINUTES_KEY)) || 30) * 60;
let streamBufferRunning = false;
let streamBufferLastRun = 0;

function setBufferMinutes(min) {
  STREAM_BUFFER_AHEAD_SECONDS = min * 60;
  localStorage.setItem(BUFFER_MINUTES_KEY, String(min));
}

function streamBufferCacheName(streamUrl) {
  return 'stream-buf:' + streamUrl;
}

async function maintainStreamBuffer(force) {
  if (!currentBook || !currentBook.streamUrl) return;
  if (!('caches' in window)) return;
  const now = Date.now();
  if (!force && (streamBufferRunning || now - streamBufferLastRun < STREAM_BUFFER_MIN_INTERVAL_MS)) return;
  const duration = isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : null;
  const sizeBytes = currentBook.sizeBytes || 0;
  if (!duration || !sizeBytes) return;

  streamBufferRunning = true;
  streamBufferLastRun = now;
  const streamUrl = currentBook.streamUrl;
  try {
    const bytesPerSecond = sizeBytes / duration;
    const currentByte = Math.max(0, Math.floor(audioEl.currentTime * bytesPerSecond));
    const targetByte = Math.min(sizeBytes, currentByte + Math.round(STREAM_BUFFER_AHEAD_SECONDS * bytesPerSecond));
    const startChunk = Math.floor(currentByte / STREAM_BUFFER_CHUNK_BYTES);
    const endChunk = Math.max(startChunk, Math.floor(Math.max(currentByte, targetByte - 1) / STREAM_BUFFER_CHUNK_BYTES));

    const cache = await caches.open(streamBufferCacheName(streamUrl));

    for (let i = startChunk; i <= endChunk; i++) {
      const chunkStart = i * STREAM_BUFFER_CHUNK_BYTES;
      if (chunkStart >= sizeBytes) break;
      const chunkEnd = Math.min(sizeBytes, chunkStart + STREAM_BUFFER_CHUNK_BYTES) - 1;
      const key = streamUrl + '?__buf=' + i;
      if (await cache.match(key)) continue;
      let res;
      try {
        res = await fetch(streamUrl, { headers: { Range: `bytes=${chunkStart}-${chunkEnd}` } });
      } catch (e) {
        break; // offline or unreachable -- stop this pass, the next tick will retry
      }
      if (res.status === 206 || res.ok) {
        // Cache.put() flatly refuses to store a 206 response (a hard
        // Cache Storage spec restriction, not a bug) -- re-wrap the same
        // bytes as a plain 200 so it can be stored, keeping the real
        // Content-Range header intact since that's what both this function's
        // own eviction pass and the service worker's reconstruction read to
        // know which bytes a stored chunk actually covers.
        const blob = await res.blob();
        const contentRange = res.headers.get('Content-Range') || `bytes ${chunkStart}-${chunkEnd}/${sizeBytes}`;
        const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
        const storable = new Response(blob, {
          status: 200,
          headers: { 'Content-Type': contentType, 'Content-Range': contentRange, 'Content-Length': String(blob.size) },
        });
        await cache.put(key, storable);
      } else break;
    }

    // Drop chunks well behind the playback position so a long book doesn't
    // keep accumulating everything already listened to.
    const evictBefore = currentByte - STREAM_BUFFER_EVICT_MARGIN_BYTES;
    if (evictBefore > 0) {
      for (const req of await cache.keys()) {
        const m = /[?&]__buf=(\d+)/.exec(req.url);
        if (!m) continue;
        const idx = Number(m[1]);
        const end = Math.min(sizeBytes, (idx + 1) * STREAM_BUFFER_CHUNK_BYTES) - 1;
        if (end < evictBefore) await cache.delete(req);
      }
    }
  } catch (e) {
    // Best-effort resilience feature -- a failure here must never disrupt playback.
  } finally {
    streamBufferRunning = false;
  }
}

async function clearStreamBuffer(streamUrl) {
  try { await caches.delete(streamBufferCacheName(streamUrl)); } catch (e) {}
}

async function idbPutBlobChunked(blobId, source, type, onChunk) {
  const total = source.size;
  const chunkCount = Math.max(1, Math.ceil(total / BLOB_CHUNK_BYTES));
  try {
    for (let batchStart = 0; batchStart < chunkCount; batchStart += CHUNKS_PER_TRANSACTION) {
      const batchEnd = Math.min(batchStart + CHUNKS_PER_TRANSACTION, chunkCount);
      const batch = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const start = i * BLOB_CHUNK_BYTES;
        const chunk = source.slice(start, Math.min(start + BLOB_CHUNK_BYTES, total));
        batch.push({ id: `${blobId}#${i}`, blob: chunk });
      }
      await idbPutBatch('chapterBlobs', batch);
      if (onChunk) onChunk(batchEnd, chunkCount);
    }
    await idbPut('chapterBlobs', { id: blobId, type, chunkCount, size: total, isChunked: true });
  } catch (e) {
    // Deliberately not attempting cleanup here. Opening fresh IndexedDB
    // transactions immediately after one just failed hit a real
    // WebKit-specific error on a real device ("delete range without an
    // in-progress transaction") -- and worse, that cleanup failure replaced
    // the actual error in what the user saw, hiding the one piece of
    // information most worth having right after a crash. Whatever chunks
    // this attempt wrote stay behind as orphans; cleanupOrphanedBlobChunks()
    // sweeps them on the next app launch instead, in a clean context with no
    // just-failed transaction to race against.
    throw e;
  }
}

async function idbGetReconstitutedBlob(blobId) {
  const meta = await idbGet('chapterBlobs', blobId);
  if (!meta) return null;

  // Books imported before chunked storage existed still have the whole blob
  // under the plain blobId key -- read those the old way rather than forcing
  // a re-import.
  if (!meta.isChunked) return { blob: meta.blob, type: meta.type || (meta.blob && meta.blob.type) };

  const parts = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const rec = await idbGet('chapterBlobs', `${blobId}#${i}`);
    if (!rec) return null; // a chunk went missing -- treat as unreadable rather than play a truncated file
    parts.push(rec.blob);
  }
  return { blob: new Blob(parts, { type: meta.type }), type: meta.type };
}

/* Shared diagnostic log, written from both import paths (local file picker
 * and the "keep offline" download) so a crash in either one is equally
 * visible. IndexedDB, not localStorage: a hard OS-level process kill can
 * lose a localStorage write even after it appeared to succeed, since the
 * browser doesn't always flush it to disk synchronously, but an IndexedDB
 * transaction's completion callback is a real durability guarantee. */
const DIAG_LOG_STORE = 'diagLog';
const DIAG_LOG_CAP = 500;

async function checkpoint(label) {
  try { await idbPut(DIAG_LOG_STORE, { label, at: Date.now() }); } catch (e) {}
}
async function readDiagLog() {
  try {
    const all = await idbGetAll(DIAG_LOG_STORE);
    all.sort((a, b) => a.id - b.id);
    return all;
  } catch (e) { return []; }
}
async function trimDiagLog() {
  try {
    const all = await readDiagLog();
    const excess = all.length - DIAG_LOG_CAP;
    if (excess <= 0) return;
    for (const entry of all.slice(0, excess)) await idbDelete(DIAG_LOG_STORE, entry.id);
  } catch (e) {}
}
async function clearDiagLogMarker() {
  await checkpoint('--- completed successfully ---');
  trimDiagLog(); // housekeeping, not on the critical path
}
async function lastCrashedCheckpoint() {
  const log = await readDiagLog();
  if (!log.length) return null;
  const last = log[log.length - 1];
  if (last.label === '--- completed successfully ---') return null;
  return last;
}

async function idbDeleteBlobChunked(blobId) {
  const meta = await idbGet('chapterBlobs', blobId);
  if (meta && meta.isChunked) {
    for (let i = 0; i < meta.chunkCount; i++) await idbDelete('chapterBlobs', `${blobId}#${i}`);
  }
  await idbDelete('chapterBlobs', blobId);
}

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let u = -1;
  do { bytes /= 1024; u++; } while (bytes >= 1024 && u < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[u];
}

// Each book is bound to one of the seven Ajahs, chosen from its title.
const AJAHS = [
  { name: 'Blue',   color: '#3f7fb8' },
  { name: 'Red',    color: '#a83c3c' },
  { name: 'Green',  color: '#3f8a5c' },
  { name: 'Brown',  color: '#8a6a3f' },
  { name: 'White',  color: '#cfcbbe' },
  { name: 'Yellow', color: '#cfa63a' },
  { name: 'Gray',   color: '#808793' },
];
function ajahFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AJAHS[h % AJAHS.length];
}

/* A chapter is { blobId, name, start, duration }. `start` is an offset into the
 * blob, so one big .m4b can hold many chapters that all share a single blobId,
 * while a folder of per-chapter mp3s gives each chapter its own blob at start 0.
 * Both cases play through the same code path. */
function normalizeBook(book) {
  if (!book || !Array.isArray(book.chapters)) return book;
  book.chapters = book.chapters.map((c) => ({
    blobId: c.blobId || c.id, // migrate books written before intra-file chapters
    name: c.name,
    start: c.start || 0,
    duration: c.duration || 0,
  }));
  return book;
}

/* Turns a PC catalog entry (from PCLink) into the same shape a local `books`
 * record has, so every rendering/playback function only ever has to know one
 * book shape regardless of where it came from. Not persisted to IndexedDB --
 * this is rebuilt fresh from the live catalog every time, which is what lets
 * "My Computer" and "Library" be the same list with no separate add step. */
function remoteToBookShape(rb) {
  const p = rb.progress || {};
  return {
    id: 'remote:' + rb.id,
    title: rb.title,
    author: rb.author || '',
    seriesNumber: rb.seriesNumber || null,
    chapters: (rb.chapters && rb.chapters.length)
      ? rb.chapters.map((c) => ({ name: c.name, start: c.start, duration: c.duration }))
      : [{ name: rb.title, start: 0, duration: rb.duration || 0 }],
    currentChapterIndex: p.currentChapterIndex || 0,
    currentTime: p.currentTime || 0,
    addedDate: rb.addedDate || 0,
    lastPlayed: p.updatedAt || rb.addedDate || 0,
    speed: 1,
    sizeBytes: rb.sizeBytes || 0,
    gainDb: rb.gainDb || 0,
    streamUrl: PCLink.streamUrlFor(rb.id),
    sourceServerId: rb.id,
    sourceServerUrl: PCLink.getBaseUrl(),
  };
}

// ---------- state ----------
let library = [];        // array of local book records (imports + offline copies)
let currentBook = null;  // book currently open in player
let currentBlobUrl = null;
let loadedBlobId = null; // which blob/stream is currently in the audio element
let sleepTimer = { deadline: null, mode: 'off', intervalId: null };
let saveProgressTimer = null;
let connStatusTimer = null;
let searchQuery = '';
let activeFilter = 'all';
let shelveMode = false;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const viewLibrary = $('view-library');
const viewPlayer = $('view-player');
const audioEl = $('audio-el');

const libraryList = $('library-list');
const libraryEmpty = $('library-empty');
const storageBar = $('storage-bar');
const storageFill = $('storage-fill');
const storageLabel = $('storage-label');

const modalAdd = $('modal-add');
const fileInput = $('file-input');
const pickedFilesEl = $('picked-files');
const bookTitleInput = $('book-title-input');
const bookAuthorInput = $('book-author-input');
const importProgress = $('import-progress');
const importFill = $('import-fill');
const importLabel = $('import-label');
const btnConfirmAdd = $('btn-confirm-add');

let pickedFiles = [];
let fileStatus = []; // parallel to pickedFiles: { state, duration }

// ---------- init ----------
init();

// Registered here (top-level, runs while this script is still being parsed,
// well before DOMContentLoaded fires) rather than inside init() -- computer.js
// hasn't run yet at this point in the script, so window.PCLink doesn't exist
// until DOMContentLoaded, same as the listener below waits for.
document.addEventListener('DOMContentLoaded', () => {
  if (window.PCLink) {
    PCLink.onChange(() => { renderLibrary(); updateConnStatus(); });
  }
});

async function init() {
  await openDb();
  await renderLibrary();
  await refreshStorageBar();
  wireEvents();
  registerServiceWorker();
  showView('library');
  cleanupOrphanedBlobChunks(); // fire-and-forget housekeeping, not on the critical path

  updateConnStatus();
  if (connStatusTimer) clearInterval(connStatusTimer);
  connStatusTimer = setInterval(updateConnStatus, 15000);
  window.addEventListener('online', updateConnStatus);
  window.addEventListener('offline', updateConnStatus);

  updateStreakUI();
}

/* Before idbPutBlobChunked cleaned up after itself on failure, a crashed or
 * errored import left every chunk it had managed to write behind, under a
 * blobId no book would ever reference again -- pure waste, and on a device
 * already struggling with storage, exactly the kind of thing worth not
 * leaving lying around. Sweeps for chunk records whose blobId isn't
 * referenced by any book and removes them. */
async function cleanupOrphanedBlobChunks() {
  try {
    const [allBooks, allBlobRecords] = await Promise.all([idbGetAll('books'), idbGetAll('chapterBlobs')]);
    const inUse = new Set();
    for (const b of allBooks) for (const c of (b.chapters || [])) if (c.blobId) inUse.add(c.blobId);

    let removed = 0;
    for (const rec of allBlobRecords) {
      const base = String(rec.id).split('#')[0];
      if (inUse.has(base)) continue;
      await idbDelete('chapterBlobs', rec.id);
      removed++;
    }
    if (removed) console.log(`Cleaned up ${removed} orphaned blob chunk(s) from failed imports.`);
  } catch (e) {}
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    checkVersionMatch();
    navigator.serviceWorker.addEventListener('controllerchange', checkVersionMatch);
  } else {
    showVersion(APP_VERSION, null);
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

function showVersion(pageVersion, swVersion) {
  const el = $('app-version');
  if (!el) return;
  const short = (v) => (v || '').replace(/^the-pattern-/, '');
  if (swVersion && swVersion !== pageVersion) {
    // The page's own JS and the service worker disagree about what's
    // current -- exactly the "did the update actually take" ambiguity that
    // "close and reopen" alone could never resolve. Surface it plainly
    // instead of leaving it invisible.
    el.textContent = `${short(pageVersion)} (worker still serving ${short(swVersion)} -- close and reopen the app fully)`;
  } else {
    el.textContent = short(pageVersion);
  }
}

async function checkVersionMatch() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const controller = navigator.serviceWorker.controller;
    if (!controller) { showVersion(APP_VERSION, null); return; }
    const swVersion = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data && e.data.swVersion);
      controller.postMessage('get-version', [channel.port2]);
      setTimeout(() => resolve(null), 2000);
    });
    showVersion(APP_VERSION, swVersion);
  } catch (e) {
    showVersion(APP_VERSION, null);
  }
}

// ---------- unified catalog ----------

/* Merges local IndexedDB books (plain imports + explicit offline copies)
 * with the live PC catalog (streamed, no local copy) and whatever import is
 * currently running on the PC -- one list, not two tabs. A PC book that's
 * been kept offline is shown using its local record (real chapters, real
 * blobIds) instead of a duplicate streaming entry. */
function buildCatalogEntries() {
  const localByServerId = new Map();
  for (const b of library) if (b.sourceServerId) localByServerId.set(b.sourceServerId, b);

  const entries = [];
  for (const b of library) {
    entries.push({ kind: b.offline ? 'offline' : 'local', displayBook: b });
  }

  if (window.PCLink && PCLink.isConnected()) {
    for (const rb of PCLink.getCatalog()) {
      if (localByServerId.has(rb.id)) continue;
      entries.push({ kind: 'stream', displayBook: remoteToBookShape(rb) });
    }
    const imp = PCLink.getCurrentImport();
    if (imp && imp.status === 'running' && !PCLink.getCatalog().some((b) => b.title === imp.title)) {
      entries.push({ kind: 'importing', imp });
    }
  }
  return entries;
}

function pctDone(book) {
  const totalDur = book.chapters.reduce((s, c) => s + (c.duration || 0), 0);
  const elapsed = book.chapters.slice(0, book.currentChapterIndex).reduce((s, c) => s + (c.duration || 0), 0) + (book.currentTime || 0);
  return totalDur > 0 ? Math.min(100, (elapsed / totalDur) * 100) : 0;
}

function matchesSearch(book) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (book.title || '').toLowerCase().includes(q) || (book.author || '').toLowerCase().includes(q);
}

async function renderLibrary() {
  library = (await idbGetAll('books')).map(normalizeBook);
  let entries = buildCatalogEntries();

  entries = entries.filter((e) => e.kind === 'importing' || matchesSearch(e.displayBook));
  if (activeFilter === 'unfinished') {
    entries = entries.filter((e) => e.kind === 'importing' || pctDone(e.displayBook) < 99.5);
  }
  if (activeFilter === 'newest') {
    entries.sort((a, b) => (b.kind === 'importing' ? 1 : (b.displayBook.addedDate || 0)) - (a.kind === 'importing' ? 1 : (a.displayBook.addedDate || 0)));
  } else {
    entries.sort((a, b) => {
      if (a.kind === 'importing') return -1;
      if (b.kind === 'importing') return 1;
      return (b.displayBook.lastPlayed || b.displayBook.addedDate || 0) - (a.displayBook.lastPlayed || a.displayBook.addedDate || 0);
    });
  }

  libraryList.innerHTML = '';
  libraryEmpty.classList.toggle('hidden', entries.length > 0);
  updateEmptyStateText();

  if (shelveMode) renderShelved(entries);
  else for (const entry of entries) libraryList.appendChild(renderBookRow(entry));

  updateMiniPlayer();
}

function updateEmptyStateText() {
  const connected = window.PCLink && PCLink.isConnected();
  $('library-empty-text').textContent = connected ? 'No books yet.' : 'The Pattern holds no threads yet.';
  $('library-empty-sub').textContent = connected
    ? 'Import a book on your PC to see it appear here.'
    : 'Touch the Wheel above to bind a book, or connect to your PC in Settings.';
}

// Series shelves group by teller (author), since that's the closest thing to
// a series identity the data actually carries -- every book in a series was
// imported with the same author, even without a dedicated series-name field.
function renderShelved(entries) {
  const shelves = new Map();
  const standalone = [];
  for (const e of entries) {
    if (e.kind !== 'importing' && e.displayBook.seriesNumber && e.displayBook.author) {
      const key = e.displayBook.author;
      if (!shelves.has(key)) shelves.set(key, []);
      shelves.get(key).push(e);
    } else {
      standalone.push(e);
    }
  }
  for (const [author, list] of shelves) {
    list.sort((a, b) => (a.displayBook.seriesNumber || 0) - (b.displayBook.seriesNumber || 0));
    const finished = list.filter((e) => pctDone(e.displayBook) >= 99.5).length;
    const header = document.createElement('div');
    header.className = 'shelf-header';
    header.innerHTML = `<span>${escapeHtml(author)}</span><span class="shelf-count">${finished} of ${list.length}</span>`;
    libraryList.appendChild(header);
    const row = document.createElement('div');
    row.className = 'shelf-row';
    for (const e of list) row.appendChild(renderBookRow(e, true));
    libraryList.appendChild(row);
  }
  for (const e of standalone) libraryList.appendChild(renderBookRow(e));
}

function renderBookRow(entry, compact) {
  const li = document.createElement('div');
  li.className = 'book-row' + (compact ? ' compact' : '');

  if (entry.kind === 'importing') {
    li.classList.add('importing-row');
    const pct = Math.round((entry.imp.percent || 0) * 100);
    li.innerHTML = `
      <div class="book-cover importing-cover">&#8635;</div>
      <div class="book-meta">
        <div class="book-title">${escapeHtml(entry.imp.title || 'Importing')}</div>
        <div class="book-sub">${escapeHtml(entry.imp.label || 'Importing...')} &middot; ${pct}%</div>
      </div>`;
    return li;
  }

  const book = entry.displayBook;
  const ajah = ajahFor(book.title || book.id);
  li.style.setProperty('--ajah', ajah.color);
  const totalDur = book.chapters.reduce((s, c) => s + (c.duration || 0), 0);
  const elapsed = book.chapters.slice(0, book.currentChapterIndex).reduce((s, c) => s + (c.duration || 0), 0) + (book.currentTime || 0);
  const pct = pctDone(book);
  const remaining = Math.max(0, totalDur - elapsed);
  const nCh = book.chapters.length;
  const badge = book.seriesNumber ? `<div class="series-badge">${escapeHtml(String(book.seriesNumber))}</div>` : '';
  const tag = entry.kind === 'stream' ? '<span class="stream-tag">Streaming</span>'
    : entry.kind === 'offline' ? '<span class="stream-tag offline-tag">Offline copy</span>' : '';

  li.innerHTML = `
    <div class="book-cover" style="background:linear-gradient(150deg, ${ajah.color}, rgba(0,0,0,0.75))">${badge}${escapeHtml((book.title || '?')[0].toUpperCase())}</div>
    <div class="book-meta">
      <div class="book-title">${escapeHtml(book.title)}${tag}</div>
      <div class="book-author">${escapeHtml(book.author || `${nCh} chapter${nCh === 1 ? '' : 's'}`)}</div>
      <div class="book-progress-track"><div class="book-progress-fill" style="width:${pct}%"></div></div>
      <div class="book-sub">${pct >= 99.5 ? 'The Wheel turns' : fmtTime(remaining) + ' remaining'}</div>
    </div>
  `;
  li.addEventListener('click', () => {
    if (entry.kind === 'stream') openPlayerWithBook(book);
    else openPlayer(book.id);
  });

  // Offline copies are the one thing worth freeing up space on without
  // opening the player first -- a quick remove right on the row.
  if (entry.kind === 'offline') {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'row-remove-offline';
    removeBtn.setAttribute('aria-label', 'Remove offline copy');
    removeBtn.innerHTML = '&#10005;';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeOfflineCopy(book);
    });
    li.appendChild(removeBtn);
  }

  return li;
}

async function refreshStorageBar() {
  if (!navigator.storage || !navigator.storage.estimate) { storageBar.classList.add('hidden'); return; }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota) { storageBar.classList.add('hidden'); return; }
    const pct = Math.min(100, (usage / quota) * 100);
    storageFill.style.width = pct + '%';
    storageLabel.textContent = `${fmtBytes(usage)} of ${fmtBytes(quota)} woven`;
    storageBar.classList.remove('hidden');
  } catch (e) {
    storageBar.classList.add('hidden');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- connection / buffer status ----------
function updateConnStatus() {
  const barLib = $('conn-status');
  const connected = window.PCLink && PCLink.isConnected();
  if (!connected) {
    barLib.classList.add('hidden');
    $('player-conn-status').classList.add('hidden');
    return;
  }
  const offline = !navigator.onLine;
  barLib.textContent = offline ? 'Signal lost -- streamed books will pause when their buffer runs out' : 'Connected to your PC';
  barLib.className = 'conn-status ' + (offline ? 'warn' : 'ok');
  barLib.classList.remove('hidden');

  if (currentBook && currentBook.streamUrl && !currentBook.offline && viewPlayer.classList.contains('active')) {
    updatePlayerConnStatus();
  } else {
    $('player-conn-status').classList.add('hidden');
  }
}

async function updatePlayerConnStatus() {
  const el = $('player-conn-status');
  if (!currentBook || !currentBook.streamUrl || currentBook.offline) { el.classList.add('hidden'); return; }
  let minutesBuffered = 0;
  try {
    if ('caches' in window) {
      const cache = await caches.open(streamBufferCacheName(currentBook.streamUrl));
      const keys = await cache.keys();
      const bytesPerSecond = (currentBook.sizeBytes || 0) / (audioEl.duration || 1);
      if (bytesPerSecond > 0) minutesBuffered = Math.round((keys.length * STREAM_BUFFER_CHUNK_BYTES) / bytesPerSecond / 60);
    }
  } catch (e) {}
  const offline = !navigator.onLine;
  el.textContent = offline
    ? `Signal lost -- playing from buffer (~${minutesBuffered}m banked)`
    : `Streaming -- ~${minutesBuffered}m buffered ahead`;
  el.className = 'conn-status inline ' + (offline ? 'warn' : 'ok');
  el.classList.remove('hidden');
}

// ---------- listening streak ----------
/* A day counts the moment real playback progress is observed, not just
 * opening the app -- recorded from the same timeupdate tick everything else
 * already watches, throttled so it only actually checks once every 30s
 * rather than on every one of the several-per-second timeupdate events.
 * Stored in localStorage as a plain sorted array of "YYYY-MM-DD" strings;
 * a book a day for over a year is still a tiny amount of data. */
const STREAK_KEY = 'listen-streak-days';
const STREAK_CAP_DAYS = 730;
let lastStreakCheck = 0;

const STREAK_MILESTONES = {
  3: "Three days unbroken. The Wheel takes notice.",
  7: "A full turning of the week. The Pattern holds firm.",
  14: "Two weeks woven without a gap in the thread.",
  30: "A full moon's turning -- thirty days unbroken.",
  50: "Fifty days. Even the Aes Sedai would call this dedication.",
  100: "One hundred days. The Wheel weaves as you will.",
  200: "Two hundred days unbroken -- a ta'veren's thread.",
  365: "A full Age has turned. Unbroken, one year.",
};

function dateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayStr() { return dateStr(new Date()); }
function dateFromStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(a, b) {
  return Math.round((dateFromStr(b) - dateFromStr(a)) / 86400000);
}

function loadStreakDays() {
  try { return JSON.parse(localStorage.getItem(STREAK_KEY)) || []; } catch (e) { return []; }
}
function saveStreakDays(days) {
  if (days.length > STREAK_CAP_DAYS) days = days.slice(days.length - STREAK_CAP_DAYS);
  localStorage.setItem(STREAK_KEY, JSON.stringify(days));
}

function computeStreak(days) {
  if (!days.length) return { current: 0, longest: 0, total: 0 };
  const set = new Set(days);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

  let current = 0;
  let cursor = set.has(dateStr(today)) ? today : (set.has(dateStr(yesterday)) ? yesterday : null);
  if (cursor) {
    cursor = new Date(cursor);
    while (set.has(dateStr(cursor))) {
      current++;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  let longest = 0, run = 0, prev = null;
  for (const d of days) {
    run = (prev && daysBetween(prev, d) === 1) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  return { current, longest, total: days.length };
}

function recordListenActivity() {
  const today = todayStr();
  const days = loadStreakDays();
  if (days.includes(today)) return;
  days.push(today);
  days.sort();
  saveStreakDays(days);
  updateStreakUI();
  const milestone = STREAK_MILESTONES[computeStreak(days).current];
  if (milestone) showStreakToast(milestone);
}

function maybeRecordListenActivity() {
  const now = Date.now();
  if (now - lastStreakCheck < 30000) return;
  lastStreakCheck = now;
  recordListenActivity();
}

function updateStreakUI() {
  const pill = $('btn-streak');
  if (!pill) return;
  const days = loadStreakDays();
  const { current } = computeStreak(days);
  pill.classList.toggle('hidden', days.length === 0);
  pill.classList.toggle('streak-active', current > 0);
  $('streak-count').textContent = String(current);
}

function flavorForStreak(n) {
  const keys = Object.keys(STREAK_MILESTONES).map(Number).sort((a, b) => b - a);
  for (const k of keys) if (n >= k) return STREAK_MILESTONES[k];
  return null;
}

function renderStreakHeatmap(days) {
  const set = new Set(days);
  const el = $('streak-heatmap');
  el.innerHTML = '';
  const today = new Date();
  for (let i = 34; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const cell = document.createElement('div');
    cell.className = 'heat-cell' + (set.has(dateStr(d)) ? ' active' : '');
    cell.title = dateStr(d);
    el.appendChild(cell);
  }
}

function openStreakModal() {
  const days = loadStreakDays();
  const { current, longest, total } = computeStreak(days);
  $('streak-current').textContent = current;
  $('streak-longest').textContent = longest;
  $('streak-total').textContent = total;
  $('streak-flavor').textContent = flavorForStreak(current)
    || (current > 0 ? 'The thread holds. Keep the Wheel turning.' : 'Listen today to begin a new thread.');
  renderStreakHeatmap(days);
  $('modal-streak').classList.remove('hidden');
}

function showStreakToast(text) {
  const t = document.createElement('div');
  t.className = 'streak-toast';
  t.textContent = text;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, 4000);
}

// ---------- navigation ----------
function showView(name) {
  viewLibrary.classList.toggle('active', name === 'library');
  viewPlayer.classList.toggle('active', name === 'player');
  updateMiniPlayer();
  updateConnStatus();
}

// ---------- add book flow ----------
function openAddModal() {
  pickedFiles = [];
  fileStatus = [];
  fileInput.value = '';
  bookTitleInput.value = '';
  bookAuthorInput.value = '';
  pickedFilesEl.innerHTML = '';
  $('probe-status').classList.add('hidden');
  $('convert-notice').classList.add('hidden');
  importProgress.classList.add('hidden');
  btnConfirmAdd.textContent = 'Bind';
  btnConfirmAdd.disabled = true;
  modalAdd.classList.remove('hidden');
}
function closeAddModal() {
  modalAdd.classList.add('hidden');
}

function naturalSort(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

async function handleFilesPicked(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  pickedFiles = files.sort(naturalSort);
  fileStatus = pickedFiles.map(() => ({ state: 'checking', duration: 0 }));

  if (!bookTitleInput.value) bookTitleInput.value = guessTitle(pickedFiles);
  $('probe-status').classList.remove('hidden');
  $('probe-status').textContent = `Reading ${pickedFiles.length} thread${pickedFiles.length === 1 ? '' : 's'}...`;
  btnConfirmAdd.disabled = true;
  renderPickedFiles();

  for (let i = 0; i < pickedFiles.length; i++) {
    const f = pickedFiles[i];
    if (isDrm(f)) {
      fileStatus[i] = { state: 'drm', duration: 0, marks: [] };
    } else {
      const res = await probeFile(f);
      // Read embedded chapter marks from the original file. Conversion preserves
      // the timeline, so marks stay valid even if the audio is transcoded later.
      let marks = [];
      try { marks = await ChapterMeta.extract(f); } catch (e) { marks = []; }
      fileStatus[i] = res.playable
        ? { state: 'native', duration: res.duration, marks }
        : { state: 'convert', duration: 0, marks };
    }
    renderPickedFiles();
  }

  $('probe-status').classList.add('hidden');
  updateConvertNotice();
}

function renderPickedFiles() {
  pickedFilesEl.innerHTML = '';
  pickedFiles.forEach((f, i) => {
    const st = fileStatus[i] || { state: 'checking' };
    const badge = {
      checking: ['checking', 'Checking'],
      native: ['ok', 'Ready'],
      convert: ['warn', 'Convert'],
      drm: ['bad', 'DRM'],
      done: ['ok', 'Added'],
      failed: ['bad', 'Failed'],
    }[st.state] || ['checking', ''];
    const nMarks = (st.marks || []).length;
    const detail = nMarks > 1 ? `${nMarks} chapters` : fmtBytes(f.size);
    const row = document.createElement('div');
    row.className = 'picked-file-row';
    row.innerHTML = `<span class="pf-idx">${i + 1}.</span>` +
      `<span class="pf-name">${escapeHtml(f.name)}</span>` +
      `<span class="pf-badge ${badge[0]}">${badge[1]}</span>` +
      `<span class="pf-size">${detail}</span>`;
    pickedFilesEl.appendChild(row);
  });
}

function updateConvertNotice() {
  const notice = $('convert-notice');
  const toConvert = fileStatus.filter((s) => s.state === 'convert').length;
  const drm = fileStatus.filter((s) => s.state === 'drm').length;
  const usable = fileStatus.filter((s) => s.state === 'native' || s.state === 'convert').length;

  const parts = [];
  if (drm > 0) {
    parts.push(`${drm} file${drm === 1 ? ' is' : 's are'} DRM-protected (Audible) and cannot be played. ${drm === 1 ? 'It' : 'They'} will be skipped.`);
  }
  if (toConvert > 0) {
    parts.push(toConvert === 1
      ? '1 file is in a format this device cannot play natively. It will be converted to AAC on import, which downloads a converter once (about 32MB) and needs a network connection.'
      : `${toConvert} files are in formats this device cannot play natively. They will be converted to AAC on import, which downloads a converter once (about 32MB) and needs a network connection.`);
  }

  notice.innerHTML = parts.map((p) => `<div>${p}</div>`).join('');
  notice.classList.toggle('hidden', parts.length === 0);
  btnConfirmAdd.textContent = toConvert > 0 ? 'Convert & Bind' : 'Bind';
  btnConfirmAdd.disabled = usable === 0 || !bookTitleInput.value.trim();
}

function guessTitle(files) {
  if (files.length === 1) return files[0].name.replace(/\.[^.]+$/, '');
  const names = files.map((f) => f.name.replace(/\.[^.]+$/, ''));
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[\s\-_,.:0-9]+$/, '').trim();
  return prefix.length >= 3 ? prefix : names[0];
}

/* ---------- format support ----------
 * The only trustworthy test of whether this device can play a file is to hand it
 * to an <audio> element and see if metadata loads. canPlayType() reports "maybe"
 * for plenty of things Safari then refuses to decode, so we probe for real.
 * Anything that fails the probe gets transcoded to AAC once, at import time. */

// Containers/codecs universally supported on iOS -- for these there is no
// real question of "will this play," so a large one is trusted outright
// rather than probed.
const TRUSTED_EXTS = new Set(['m4a', 'm4b', 'mp3', 'mp2', 'aac', 'wav', 'aiff', 'aif', 'caf', 'flac']);
// Handing a very large file to an <audio> element just to check whether it
// plays turned out to be unsafe on at least one real device -- not merely
// slow (a generous timeout would fix that) but capable of failing outright
// or crashing the tab on nothing more than a 700MB blob URL. A false
// negative here is far more costly than skipping the check: it routes into
// on-device conversion, which needs a real ffmpeg WebAssembly instance and
// has crashed outright even on a modest input. So above this size, a
// trusted container is never handed to the probe at all -- duration is
// simply unknown until first real playback, which is a normal, minor
// wrinkle (see the self-healing in loadChapter), not a crash.
const SKIP_PROBE_ABOVE_BYTES = 60 * 1024 * 1024;

function probeFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const trusted = TRUSTED_EXTS.has(ext);

  if (trusted && file.size > SKIP_PROBE_ABOVE_BYTES) {
    return Promise.resolve({ playable: true, duration: 0 });
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('audio');
    a.preload = 'metadata';
    let settled = false;
    const finish = (playable, duration) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve({ playable, duration: playable ? duration : 0 });
    };
    // Below the size threshold, a timeout is a genuine ambiguous case, not
    // an automatic pass -- trust the container, don't just guess playable.
    const timer = setTimeout(() => finish(trusted, 0), 45000);
    a.onloadedmetadata = () => finish(isFinite(a.duration) && a.duration > 0, a.duration);
    a.onerror = () => finish(false, 0);
    a.src = url;
  });
}

// DRM containers can never be decoded in a browser, so flag them before wasting a probe.
const DRM_EXTS = ['aa', 'aax'];
function isDrm(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return DRM_EXTS.includes(ext);
}

/* ffmpeg.wasm is vendored under vendor/ffmpeg rather than loaded from a CDN, for
 * two reasons. Browsers refuse to construct a Worker from a cross-origin script,
 * which rules out running it straight off a CDN. And ffmpeg 0.12.10's own escape
 * hatch is broken: passing classWorkerURL makes it spawn the worker with
 * {type:"module"}, and module workers have no importScripts, so loading the core
 * always fails. Left alone, it resolves its worker chunk relative to ffmpeg.js,
 * which lands on our own origin as a classic worker and works. So: same-origin
 * files, and do not pass classWorkerURL. Bonus: conversion works offline. */
const FFMPEG_SOURCE = {
  ffmpeg: 'vendor/ffmpeg/ffmpeg.js',
  core: 'vendor/ffmpeg/ffmpeg-core.js',
  wasm: 'vendor/ffmpeg/ffmpeg-core.wasm',
};

let ffmpegPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing && existing.dataset.loaded === '1') { resolve(); return; }
    if (existing) existing.remove(); // previous attempt failed, start clean
    const s = document.createElement('script');
    s.dataset.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
    s.src = src;
    document.head.appendChild(s);
  });
}

// The single helper we used to pull in @ffmpeg/util for. Fetching the core and
// handing it to ffmpeg as a blob URL sidesteps cross-origin worker restrictions.
async function toBlobURL(url, mimeType, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onBytes) {
    return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: mimeType }));
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received, total);
  }
  return URL.createObjectURL(new Blob(chunks, { type: mimeType }));
}

async function getFFmpeg(onStatus) {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    try {
      const src = FFMPEG_SOURCE;
      if (onStatus) onStatus('Loading converter...');
      await loadScript(src.ffmpeg);
      const { FFmpeg } = window.FFmpegWASM;
      const ffmpeg = new FFmpeg();

      // coreURL must stay a real URL: the worker pulls it in with importScripts,
      // which rejects a blob here. The wasm is fetched, so a blob is fine and
      // lets us report download progress on the one large file.
      const wasmURL = await toBlobURL(src.wasm, 'application/wasm', (got, total) => {
        if (!onStatus) return;
        onStatus(total
          ? `Loading converter: ${fmtBytes(got)} of ${fmtBytes(total)}`
          : `Loading converter: ${fmtBytes(got)}`);
      });

      await ffmpeg.load({ coreURL: new URL(src.core, location.href).href, wasmURL });
      return ffmpeg;
    } catch (e) {
      ffmpegPromise = null; // let a later import retry
      const msg = (e && e.message) || String(e) || 'unknown error';
      throw new Error('Converter unavailable (' + msg + ')');
    }
  })();
  return ffmpegPromise;
}

/* Transcode to AAC in an MP4 container, which every iOS device decodes natively.
 * Mono 64k is transparent for spoken word and keeps a long book small. */
async function convertToAac(file, onStatus, onProgress) {
  const ffmpeg = await getFFmpeg(onStatus);
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const inName = 'in.' + ext;
  const outName = 'out.m4a';

  const handleProgress = ({ progress }) => {
    if (onProgress && isFinite(progress)) onProgress(Math.max(0, Math.min(1, progress)));
  };
  ffmpeg.on('progress', handleProgress);

  try {
    await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    await ffmpeg.exec(['-i', inName, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', outName]);
    const data = await ffmpeg.readFile(outName);
    if (!data || !data.length) throw new Error('Conversion produced no audio');
    const blob = new Blob([data.buffer], { type: 'audio/mp4' });
    try { await ffmpeg.deleteFile(inName); await ffmpeg.deleteFile(outName); } catch (e) {}
    return blob;
  } finally {
    try { ffmpeg.off('progress', handleProgress); } catch (e) {}
  }
}

async function confirmAddBook() {
  if (!pickedFiles.length) return;
  const title = bookTitleInput.value.trim() || 'Untitled Audiobook';
  const author = bookAuthorInput.value.trim();
  btnConfirmAdd.disabled = true;
  importProgress.classList.remove('hidden');

  try {
    await confirmAddBookInner(title, author);
  } catch (e) {
    await checkpoint('caught error during local import: ' + (e && e.message ? e.message : String(e)));
    importProgress.classList.add('hidden');
    btnConfirmAdd.disabled = false;
    alert('Import failed: ' + (e && e.message ? e.message : String(e)));
  }
}

async function confirmAddBookInner(title, author) {
  const bookId = uid();
  const chapters = [];
  const failures = [];
  const total = pickedFiles.length;

  for (let i = 0; i < total; i++) {
    const file = pickedFiles[i];
    const st = fileStatus[i] || { state: 'native' };
    const base = i / total;
    const step = 1 / total;

    if (st.state === 'drm') { failures.push(`${file.name}: DRM-protected`); continue; }

    await checkpoint(`local import: starting file ${i + 1}/${total}: "${file.name}" (${fmtBytes(file.size)}, state=${st.state})`);
    importLabel.textContent = `${i + 1} of ${total}: ${file.name}`;
    importFill.style.width = Math.round(base * 100) + '%';

    let blob = file;
    let duration = st.duration;

    if (st.state === 'convert') {
      try {
        blob = await convertToAac(
          file,
          (msg) => { importLabel.textContent = msg; },
          (p) => {
            importLabel.textContent = `Converting ${i + 1} of ${total}: ${file.name} (${Math.round(p * 100)}%)`;
            importFill.style.width = Math.round((base + step * p) * 100) + '%';
          }
        );
        const reprobe = await probeFile(new File([blob], 'converted.m4a', { type: 'audio/mp4' }));
        if (!reprobe.playable) throw new Error('Converted file still will not play');
        duration = reprobe.duration;
        fileStatus[i] = { state: 'done', duration };
      } catch (err) {
        fileStatus[i] = { state: 'failed', duration: 0 };
        failures.push(`${file.name}: ${err && err.message ? err.message : 'conversion failed'}`);
        renderPickedFiles();
        continue;
      }
    }

    await checkpoint(`local import: writing "${file.name}" (${fmtBytes(blob.size)}) in chunks`);
    const blobId = uid();
    await idbPutBlobChunked(blobId, blob, blob.type || 'audio/mpeg', (done, count) => {
      checkpoint(`local import: wrote chunk ${done}/${count} of "${file.name}" (${fmtBytes(done * BLOB_CHUNK_BYTES)})`);
    });
    await checkpoint(`local import: finished writing "${file.name}"`);

    // Embedded marks turn one file into many chapters that share a single blob.
    const marks = st.marks || [];
    const fromMarks = [];
    if (marks.length > 1 && duration > 0) {
      marks.forEach((m, mi) => {
        const s = Math.max(0, Math.min(m.start, duration));
        const e = mi + 1 < marks.length ? Math.min(marks[mi + 1].start, duration) : duration;
        const len = e - s;
        if (len < 1) return;
        fromMarks.push({ blobId, name: m.name || `Chapter ${mi + 1}`, start: s, duration: len });
      });
    }

    if (fromMarks.length > 1) {
      chapters.push(...fromMarks);
    } else {
      chapters.push({ blobId, name: file.name.replace(/\.[^.]+$/, ''), start: 0, duration });
    }

    importFill.style.width = Math.round((base + step) * 100) + '%';
    renderPickedFiles();
  }

  if (!chapters.length) {
    importProgress.classList.add('hidden');
    btnConfirmAdd.disabled = false;
    alert('Nothing could be imported.\n\n' + failures.join('\n'));
    return;
  }

  const book = {
    id: bookId,
    title,
    author,
    chapters,
    currentChapterIndex: 0,
    currentTime: 0,
    speed: 1,
    addedDate: Date.now(),
    lastPlayed: Date.now(),
  };
  await idbPut('books', book);
  clearDiagLogMarker();

  importProgress.classList.add('hidden');
  closeAddModal();
  await renderLibrary();
  await refreshStorageBar();
  if (failures.length) {
    alert(`Added "${title}" with ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}.\n\nSkipped:\n` + failures.join('\n'));
  }
}

// ---------- keep offline (opt-in copy of a streamed book) ----------
async function keepOffline() {
  if (!currentBook || !currentBook.streamUrl || currentBook.offline) return;
  const btn = $('btn-keep-offline');
  const original = currentBook;
  btn.disabled = true;
  try {
    await checkpoint(`keep offline: fetching "${original.title}"`);
    const res = await fetch(original.streamUrl);
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const total = Number(res.headers.get('content-length')) || original.sizeBytes || 0;

    // Same bounded-memory flush pattern the old download path used: hold
    // only a few MB of raw chunks in JS at a time, not the whole file.
    const FLUSH_BYTES = 8 * 1024 * 1024;
    const reader = res.body.getReader();
    const parts = [];
    let buffer = [];
    let bufferedBytes = 0;
    let received = 0;
    const flush = () => {
      if (!buffer.length) return;
      parts.push(new Blob(buffer, { type: contentType }));
      buffer = [];
      bufferedBytes = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer.push(value);
      bufferedBytes += value.length;
      received += value.length;
      if (bufferedBytes >= FLUSH_BYTES) flush();
      const pct = total ? Math.round((received / total) * 100) : 0;
      btn.textContent = `Keeping offline... ${pct}%`;
    }
    flush();
    const blob = new Blob(parts, { type: contentType });
    parts.length = 0;

    await checkpoint(`keep offline: writing "${original.title}" to IndexedDB in chunks (${fmtBytes(blob.size)})`);
    const blobId = uid();
    await idbPutBlobChunked(blobId, blob, contentType, (done, count) => {
      btn.textContent = `Saving... ${Math.round((done / count) * 100)}%`;
    });

    const record = {
      id: uid(),
      title: original.title,
      author: original.author,
      seriesNumber: original.seriesNumber,
      chapters: original.chapters.map((c) => ({ blobId, name: c.name, start: c.start, duration: c.duration })),
      currentChapterIndex: original.currentChapterIndex,
      currentTime: original.currentTime,
      speed: original.speed || 1,
      addedDate: Date.now(),
      lastPlayed: Date.now(),
      offline: true,
      streamUrl: original.streamUrl,
      gainDb: original.gainDb || 0,
      sourceServerId: original.sourceServerId,
      sourceServerUrl: original.sourceServerUrl,
    };
    await idbPut('books', record);
    clearDiagLogMarker();

    currentBook = normalizeBook(record);
    loadedBlobId = null; // force loadChapter to re-source from the new local blob next time it plays
    btn.classList.add('hidden');
    $('btn-delete-book').classList.remove('hidden');
    updateConnStatus();
    await renderLibrary();
    await refreshStorageBar();
  } catch (e) {
    await checkpoint('keep offline: failed: ' + (e && e.message ? e.message : String(e)));
    alert('Could not save this book offline: ' + (e && e.message ? e.message : String(e)));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Keep this book offline';
  }
}

// ---------- player ----------
async function openPlayer(bookId) {
  const book = normalizeBook(await idbGet('books', bookId));
  if (!book) return;
  await openPlayerWithBook(book);
}

async function openPlayerWithBook(book) {
  currentBook = book;
  $('player-title').textContent = book.title;
  const ajah = ajahFor(book.title || book.id);
  $('cover-art').style.background = `linear-gradient(150deg, ${ajah.color}, rgba(0,0,0,0.85))`;
  $('cover-initial').textContent = (book.title || '?')[0].toUpperCase();
  const existingBadge = $('cover-art').querySelector('.series-badge');
  if (existingBadge) existingBadge.remove();
  if (book.seriesNumber) {
    const badgeEl = document.createElement('div');
    badgeEl.className = 'series-badge';
    badgeEl.textContent = String(book.seriesNumber);
    $('cover-art').appendChild(badgeEl);
  }
  $('speed-select').value = String(book.speed || 1);

  const isPureStream = !!(book.streamUrl && !book.offline);
  $('btn-delete-book').classList.toggle('hidden', isPureStream);
  $('btn-keep-offline').classList.toggle('hidden', !isPureStream);
  $('btn-keep-offline').textContent = 'Keep this book offline';

  renderChapterList();
  showView('player');
  await loadChapter(book.currentChapterIndex, book.currentTime, false);
  clearSleepTimer();
  updateConnStatus();
}

function renderChapterList() {
  const list = $('chapter-list');
  list.innerHTML = '';
  currentBook.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.className = 'chapter-row' + (i === currentBook.currentChapterIndex ? ' active' : '');
    li.innerHTML = `<span class="chapter-idx">${i + 1}</span><span class="chapter-title">${escapeHtml(ch.name)}</span><span class="chapter-dur">${fmtTime(ch.duration)}</span>`;
    li.addEventListener('click', () => loadChapter(i, 0, true));
    list.appendChild(li);
  });
}

function curChapter() {
  if (!currentBook) return null;
  return currentBook.chapters[currentBook.currentChapterIndex] || null;
}
function chapterElapsed() {
  const ch = curChapter();
  if (!ch) return 0;
  return Math.max(0, audioEl.currentTime - (ch.start || 0));
}
function updateChapterHeading() {
  const ch = curChapter();
  if (!ch) return;
  $('chapter-name').textContent = `${currentBook.currentChapterIndex + 1}. ${ch.name}`;
}

// Cross-device resume: a pure-stream book's position lives on the server,
// not in this device's IndexedDB -- an offline copy or local import still
// persists locally exactly as before.
function persistBookState() {
  if (!currentBook) return;
  if (currentBook.streamUrl && !currentBook.offline) {
    if (window.PCLink) PCLink.pushProgress(currentBook.sourceServerId, currentBook.currentTime, currentBook.currentChapterIndex);
  } else {
    idbPut('books', currentBook);
  }
}

async function loadChapter(index, offset, autoplay) {
  if (!currentBook) return;
  if (index < 0 || index >= currentBook.chapters.length) return;
  const ch = currentBook.chapters[index];
  // A duration of 0 means it's not known yet (see the probeFile timeout
  // fallback) rather than an actually-empty chapter -- don't clamp the
  // resume offset down to 0 in that case, or resume position is silently
  // lost until the real duration is learned from an actual playback.
  const rel = ch.duration > 0 ? Math.max(0, Math.min(offset || 0, ch.duration)) : Math.max(0, offset || 0);
  const abs = (ch.start || 0) + rel;

  currentBook.currentChapterIndex = index;
  currentBook.currentTime = rel;
  currentBook.lastPlayed = Date.now();
  persistBookState();

  updateChapterHeading();
  renderChapterList();
  updateMediaSessionMetadata();

  const useStream = currentBook.streamUrl && !currentBook.offline;
  // A streamed book has one network URL backing every chapter, in place of
  // a blobId backing an on-device blob -- same "which source is currently
  // loaded" check either way, just a different kind of key.
  const srcKey = useStream ? currentBook.streamUrl : ch.blobId;

  // Chapters inside the same file need only a seek, not a reload.
  if (srcKey === loadedBlobId && audioEl.readyState > 0) {
    audioEl.currentTime = abs;
    if (autoplay && audioEl.paused) audioEl.play().catch(() => {});
    updatePlayPauseIcon();
    return;
  }

  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }

  if (useStream) {
    // Streamed books play straight off the PC server's URL -- the browser's
    // own HTTP client handles Range requests for seeking natively, no local
    // storage write involved at all.
    loadedBlobId = srcKey;
    audioEl.src = currentBook.streamUrl;
  } else {
    const rec = await idbGetReconstitutedBlob(ch.blobId);
    if (!rec) return;
    currentBlobUrl = URL.createObjectURL(rec.blob);
    loadedBlobId = ch.blobId;
    audioEl.src = currentBlobUrl;
  }
  audioEl.playbackRate = currentBook.speed || 1;

  const onReady = () => {
    audioEl.removeEventListener('loadedmetadata', onReady);
    // Self-heal an unknown duration now that the real one is available --
    // this is the only moment it can be learned for a file whose import-time
    // probe timed out on a large file rather than getting a real answer.
    if (!(ch.duration > 0) && isFinite(audioEl.duration) && audioEl.duration > 0) {
      ch.duration = audioEl.duration;
      persistBookState();
      renderChapterList();
    }
    audioEl.currentTime = Math.min(abs, audioEl.duration || abs);
    if (autoplay) audioEl.play().catch(() => {});
    updatePlayPauseIcon();
    if (useStream) maintainStreamBuffer(true);
    updateConnStatus();
  };
  audioEl.addEventListener('loadedmetadata', onReady);
}

/* Playing straight through a multi-chapter file never fires `ended`, so chapter
 * changes have to be noticed by watching the clock. */
function checkChapterBoundary() {
  const ch = curChapter();
  if (!ch || scrubbing) return;
  const idx = currentBook.currentChapterIndex;
  const end = (ch.start || 0) + ch.duration;
  if (audioEl.currentTime < end - 0.15) return;

  const next = idx + 1;
  if (next >= currentBook.chapters.length) return;
  if (currentBook.chapters[next].blobId !== ch.blobId) return; // `ended` handles it

  if (sleepTimer.mode === 'eoc') {
    pauseAudio();
    clearSleepTimer();
    saveProgress();
    return;
  }
  currentBook.currentChapterIndex = next;
  updateChapterHeading();
  renderChapterList();
  updateMediaSessionMetadata();
}

function updatePlayPauseIcon() {
  const icon = audioEl.paused ? '&#9654;' : '&#10074;&#10074;';
  $('btn-playpause').innerHTML = icon;
  $('btn-mini-playpause').innerHTML = icon;
}

/* A phone call, Siri, an alarm, or another app grabbing audio focus all pause
 * this element the same way -- the browser just calls pause() on it, with no
 * event that distinguishes "the OS took audio focus away" from "the user
 * tapped pause". The only way to tell them apart is to mark our own
 * deliberate pauses right before making them; anything else that arrives as
 * a `pause` event is an interruption, and worth trying to resume from once
 * it clears, the way a real audiobook app would. */
let intentionalPause = false;
let pausedByInterruption = false;
let resumeAttempts = 0;

function pauseAudio() {
  intentionalPause = true;
  pausedByInterruption = false;
  audioEl.pause();
}

function scheduleResumeAttempt() {
  if (!pausedByInterruption || resumeAttempts >= 6) return;
  resumeAttempts++;
  setTimeout(() => {
    if (!pausedByInterruption || !audioEl.paused) return;
    audioEl.play().catch(() => scheduleResumeAttempt());
  }, Math.min(resumeAttempts * 1500, 8000));
}

function togglePlayPause() {
  if (audioEl.paused) audioEl.play().catch(() => {});
  else pauseAudio();
}

function skipSeconds(delta) {
  if (!currentBook) return;
  const ch = curChapter();
  if (!ch) return;
  const idx = currentBook.currentChapterIndex;
  const rel = chapterElapsed() + delta;
  const wasPlaying = !audioEl.paused;

  if (rel > ch.duration && idx < currentBook.chapters.length - 1) {
    loadChapter(idx + 1, rel - ch.duration, wasPlaying);
    return;
  }
  if (rel < 0 && idx > 0) {
    const prev = currentBook.chapters[idx - 1];
    loadChapter(idx - 1, Math.max(0, (prev.duration || 0) + rel), wasPlaying);
    return;
  }
  audioEl.currentTime = (ch.start || 0) + Math.max(0, Math.min(ch.duration, rel));
}

function nextChapter(forcePlay) {
  if (!currentBook) return;
  const shouldPlay = forcePlay === undefined ? !audioEl.paused : forcePlay;
  const next = currentBook.currentChapterIndex + 1;
  if (next < currentBook.chapters.length) loadChapter(next, 0, shouldPlay);
}
function prevChapter() {
  if (!currentBook) return;
  const ch = curChapter();
  if (!ch) return;
  const wasPlaying = !audioEl.paused;
  if (chapterElapsed() > 3) { audioEl.currentTime = ch.start || 0; return; }
  const prev = currentBook.currentChapterIndex - 1;
  if (prev >= 0) loadChapter(prev, 0, wasPlaying);
  else audioEl.currentTime = ch.start || 0;
}

function saveProgress() {
  if (!currentBook) return;
  if (audioEl.readyState === 0) return; // mid src-swap: currentTime is not yet meaningful
  currentBook.currentTime = chapterElapsed();
  currentBook.lastPlayed = Date.now();
  persistBookState();
}

/* Shared by the player's delete button, the player's "keep offline" undo
 * path, and the quick remove action directly on a library row -- one place
 * that actually clears the blob chunks and the book record, regardless of
 * which UI triggered it or whether the book being removed is the one
 * currently open in the player. */
async function removeBookRecordFromDevice(book) {
  if (book.streamUrl) await clearStreamBuffer(book.streamUrl);
  const blobIds = Array.from(new Set(book.chapters.map((c) => c.blobId))).filter(Boolean);
  for (const id of blobIds) await idbDeleteBlobChunked(id);
  await idbDelete('books', book.id);

  if (currentBook && currentBook.id === book.id) {
    pauseAudio();
    audioEl.removeAttribute('src');
    if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
    loadedBlobId = null;
    currentBook = null;
    if (viewPlayer.classList.contains('active')) showView('library');
  }
}

// Removing an offline copy just goes back to streaming -- the book itself
// isn't gone, it reappears as a "Streaming" catalog entry on the next render
// since it's still in the PC's live catalog.
async function removeOfflineCopy(book) {
  if (!confirm(`Remove the offline copy of "${book.title}"? It stays on the PC and keeps streaming -- this only frees the space on this device.`)) return;
  await removeBookRecordFromDevice(book);
  await renderLibrary();
  await refreshStorageBar();
}

async function deleteCurrentBook() {
  if (!currentBook) return;
  if (currentBook.streamUrl && !currentBook.offline) return; // no delete action for pure-stream entries; button is hidden

  if (currentBook.offline) { await removeOfflineCopy(currentBook); return; }

  if (!confirm(`Unravel "${currentBook.title}"? This removes it and all its audio from this device.`)) return;
  await removeBookRecordFromDevice(currentBook);
  await renderLibrary();
  await refreshStorageBar();
}

// ---------- scrub bar ----------
let scrubbing = false;
function updateScrub() {
  const ch = curChapter();
  if (scrubbing || !ch || !ch.duration) return;
  const rel = chapterElapsed();
  $('scrub').value = String((rel / ch.duration) * 1000);
  $('time-current').textContent = fmtTime(rel);
  $('time-remaining').textContent = '-' + fmtTime(ch.duration - rel);
}

// ---------- mini player dock ----------
function updateMiniPlayer() {
  const dock = $('mini-player');
  if (!currentBook || viewPlayer.classList.contains('active')) { dock.classList.add('hidden'); return; }
  dock.classList.remove('hidden');
  $('mini-title').textContent = currentBook.title;
  const ch = curChapter();
  $('mini-sub').textContent = ch ? ch.name : '';
  const ajah = ajahFor(currentBook.title || currentBook.id);
  const cover = $('mini-cover');
  cover.textContent = (currentBook.title || '?')[0].toUpperCase();
  cover.style.background = ajah.color;
  $('btn-mini-playpause').innerHTML = audioEl.paused ? '&#9654;' : '&#10074;&#10074;';
  const totalDur = currentBook.chapters.reduce((s, c) => s + (c.duration || 0), 0);
  const elapsed = currentBook.chapters.slice(0, currentBook.currentChapterIndex).reduce((s, c) => s + (c.duration || 0), 0) + chapterElapsed();
  const pct = totalDur > 0 ? Math.min(100, (elapsed / totalDur) * 100) : 0;
  $('mini-progress-fill').style.width = pct + '%';
}

// ---------- sleep timer ----------
function clearSleepTimer() {
  sleepTimer.mode = 'off';
  sleepTimer.deadline = null;
  if (sleepTimer.intervalId) clearInterval(sleepTimer.intervalId);
  sleepTimer.intervalId = null;
  $('sleep-status').classList.add('hidden');
  $('sleep-select').value = '0';
}

function setSleepTimer(value) {
  if (sleepTimer.intervalId) clearInterval(sleepTimer.intervalId);
  if (value === '0') { clearSleepTimer(); return; }
  if (value === 'eoc') {
    sleepTimer.mode = 'eoc';
    $('sleep-status').textContent = 'Crossing into the Dream at the end of this chapter';
    $('sleep-status').classList.remove('hidden');
    return;
  }
  const minutes = parseFloat(value);
  sleepTimer.mode = 'timed';
  sleepTimer.deadline = Date.now() + minutes * 60000;
  const tick = () => {
    const remaining = Math.max(0, sleepTimer.deadline - Date.now());
    if (remaining <= 0) {
      pauseAudio();
      clearInterval(sleepTimer.intervalId);
      clearSleepTimer();
      return;
    }
    $('sleep-status').textContent = `Crossing into the Dream in ${fmtTime(remaining / 1000)}`;
    $('sleep-status').classList.remove('hidden');
  };
  tick();
  sleepTimer.intervalId = setInterval(tick, 1000);
}

// ---------- media session (lock screen controls) ----------
function updateMediaSessionMetadata() {
  if (!('mediaSession' in navigator) || !currentBook) return;
  const ch = currentBook.chapters[currentBook.currentChapterIndex];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ch ? ch.name : currentBook.title,
    artist: currentBook.author || currentBook.title,
    album: currentBook.title,
  });
  navigator.mediaSession.setActionHandler('play', () => audioEl.play().catch(() => {}));
  navigator.mediaSession.setActionHandler('pause', () => pauseAudio());
  navigator.mediaSession.setActionHandler('seekbackward', () => skipSeconds(-15));
  navigator.mediaSession.setActionHandler('seekforward', () => skipSeconds(30));
  navigator.mediaSession.setActionHandler('previoustrack', () => prevChapter());
  navigator.mediaSession.setActionHandler('nexttrack', () => nextChapter());
  try {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) audioEl.currentTime = details.seekTime;
    });
  } catch (e) {}
}

// ---------- events ----------
function wireEvents() {
  $('btn-add').addEventListener('click', openAddModal);
  $('btn-cancel-add').addEventListener('click', closeAddModal);
  $('btn-confirm-add').addEventListener('click', confirmAddBook);
  fileInput.addEventListener('change', handleFilesPicked);
  bookTitleInput.addEventListener('input', () => {
    if (fileStatus.length) updateConvertNotice();
    else btnConfirmAdd.disabled = true;
  });

  $('btn-back').addEventListener('click', () => {
    pauseAudio();
    saveProgress();
    showView('library');
    renderLibrary();
    refreshStorageBar();
  });
  $('btn-delete-book').addEventListener('click', deleteCurrentBook);
  $('btn-keep-offline').addEventListener('click', keepOffline);

  $('btn-playpause').addEventListener('click', togglePlayPause);
  $('btn-mini-playpause').addEventListener('click', (e) => { e.stopPropagation(); togglePlayPause(); });
  $('mini-player').addEventListener('click', () => { if (currentBook) showView('player'); });
  $('btn-back-15').addEventListener('click', () => skipSeconds(-15));
  $('btn-fwd-30').addEventListener('click', () => skipSeconds(30));
  $('btn-next-chapter').addEventListener('click', nextChapter);
  $('btn-prev-chapter').addEventListener('click', prevChapter);

  $('speed-select').addEventListener('change', (e) => {
    const speed = parseFloat(e.target.value);
    audioEl.playbackRate = speed;
    if (currentBook) { currentBook.speed = speed; persistBookState(); }
  });

  $('sleep-select').addEventListener('change', (e) => setSleepTimer(e.target.value));

  const scrub = $('scrub');
  scrub.addEventListener('input', () => {
    scrubbing = true;
    const ch = curChapter();
    if (ch && ch.duration) {
      const t = (parseFloat(scrub.value) / 1000) * ch.duration;
      $('time-current').textContent = fmtTime(t);
      $('time-remaining').textContent = '-' + fmtTime(ch.duration - t);
    }
  });
  scrub.addEventListener('change', () => {
    const ch = curChapter();
    if (ch && ch.duration) {
      audioEl.currentTime = (ch.start || 0) + (parseFloat(scrub.value) / 1000) * ch.duration;
    }
    scrubbing = false;
  });

  audioEl.addEventListener('timeupdate', () => { checkChapterBoundary(); updateScrub(); updateMiniPlayer(); maintainStreamBuffer(false); maybeRecordListenActivity(); });
  audioEl.addEventListener('play', () => {
    updatePlayPauseIcon();
    updateMiniPlayer();
    pausedByInterruption = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    maintainStreamBuffer(false);
  });
  audioEl.addEventListener('pause', () => {
    updatePlayPauseIcon();
    updateMiniPlayer();
    saveProgress();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    if (!intentionalPause) {
      pausedByInterruption = true;
      resumeAttempts = 0;
      scheduleResumeAttempt();
    }
    intentionalPause = false;
  });
  audioEl.addEventListener('ended', () => {
    if (sleepTimer.mode === 'eoc') {
      clearSleepTimer();
      saveProgress();
      return;
    }
    const isLast = currentBook && currentBook.currentChapterIndex >= currentBook.chapters.length - 1;
    if (isLast) { saveProgress(); return; }
    nextChapter(true);
  });

  if (saveProgressTimer) clearInterval(saveProgressTimer);
  saveProgressTimer = setInterval(() => { if (!audioEl.paused) saveProgress(); }, 10000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveProgress(); return; }
    // Coming back to the foreground is exactly when an interruption (a call
    // ending, dismissing Siri) typically clears -- worth an immediate retry
    // rather than waiting out whatever backoff delay was already in flight.
    if (pausedByInterruption && audioEl.paused) {
      resumeAttempts = 0;
      scheduleResumeAttempt();
    }
  });
  window.addEventListener('beforeunload', () => saveProgress());

  // ---------- search / filter / shelve ----------
  $('btn-search-toggle').addEventListener('click', () => $('search-bar').classList.toggle('hidden'));
  $('search-input').addEventListener('input', (e) => { searchQuery = e.target.value; renderLibrary(); });
  document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-filter]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      renderLibrary();
    });
  });
  const shelveChip = document.querySelector('.chip[data-shelve]');
  if (shelveChip) {
    shelveChip.addEventListener('click', () => {
      shelveMode = !shelveMode;
      shelveChip.classList.toggle('active', shelveMode);
      renderLibrary();
    });
  }

  // ---------- settings sheet ----------
  $('btn-settings').addEventListener('click', () => $('modal-settings').classList.remove('hidden'));
  $('btn-close-settings').addEventListener('click', () => $('modal-settings').classList.add('hidden'));
  const bufferSelect = $('buffer-window-select');
  bufferSelect.value = String(STREAM_BUFFER_AHEAD_SECONDS / 60);
  bufferSelect.addEventListener('change', (e) => setBufferMinutes(Number(e.target.value)));

  // ---------- listening streak ----------
  $('btn-streak').addEventListener('click', openStreakModal);
  $('btn-close-streak').addEventListener('click', () => $('modal-streak').classList.add('hidden'));
}

/* Local-storage audiobook player. All audio data lives in IndexedDB on this device. */

const DB_NAME = 'audiobook-player';
const DB_VERSION = 1;
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
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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

// ---------- state ----------
let library = [];        // array of book metadata objects
let currentBook = null;  // book currently open in player
let currentBlobUrl = null;
let loadedBlobId = null; // which blob is currently in the audio element
let sleepTimer = { deadline: null, mode: 'off', intervalId: null };
let saveProgressTimer = null;

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

async function init() {
  await openDb();
  await refreshLibrary();
  await refreshStorageBar();
  wireEvents();
  registerServiceWorker();
  showView('library');
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

// ---------- library rendering ----------
async function refreshLibrary() {
  library = (await idbGetAll('books')).map(normalizeBook);
  library.sort((a, b) => (b.lastPlayed || b.addedDate) - (a.lastPlayed || a.addedDate));
  libraryList.innerHTML = '';
  libraryEmpty.classList.toggle('hidden', library.length > 0);
  for (const book of library) {
    libraryList.appendChild(renderBookRow(book));
  }
}

function renderBookRow(book) {
  const li = document.createElement('li');
  li.className = 'book-row';
  const ajah = ajahFor(book.title || book.id);
  li.style.setProperty('--ajah', ajah.color);
  const totalDur = book.chapters.reduce((s, c) => s + (c.duration || 0), 0);
  const elapsed = book.chapters.slice(0, book.currentChapterIndex).reduce((s, c) => s + (c.duration || 0), 0) + (book.currentTime || 0);
  const pct = totalDur > 0 ? Math.min(100, (elapsed / totalDur) * 100) : 0;
  const remaining = Math.max(0, totalDur - elapsed);
  const nCh = book.chapters.length;

  li.innerHTML = `
    <div class="book-cover" style="background:linear-gradient(150deg, ${ajah.color}, rgba(0,0,0,0.75))">${escapeHtml((book.title || '?')[0].toUpperCase())}</div>
    <div class="book-meta">
      <div class="book-title">${escapeHtml(book.title)}</div>
      <div class="book-author">${escapeHtml(book.author || `${nCh} chapter${nCh === 1 ? '' : 's'}`)}</div>
      <div class="book-progress-track"><div class="book-progress-fill" style="width:${pct}%"></div></div>
      <div class="book-sub">${pct >= 99.5 ? 'The Wheel turns' : fmtTime(remaining) + ' remaining'}</div>
    </div>
  `;
  li.addEventListener('click', () => openPlayer(book.id));
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

// ---------- navigation ----------
function showView(name) {
  viewLibrary.classList.toggle('active', name === 'library');
  viewPlayer.classList.toggle('active', name === 'player');
  $('view-computer').classList.toggle('active', name === 'computer');

  const tabbar = $('tabbar');
  tabbar.classList.toggle('visible', name !== 'player');
  $('tab-library').classList.toggle('active', name === 'library');
  $('tab-computer').classList.toggle('active', name === 'computer');

  if (name === 'computer' && window.ComputerTab) window.ComputerTab.onShow();
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

function probeFile(file) {
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
    const timer = setTimeout(() => finish(false, 0), 15000);
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

    const blobId = uid();
    await idbPut('chapterBlobs', { id: blobId, blob, type: blob.type || 'audio/mpeg' });

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

  importProgress.classList.add('hidden');
  closeAddModal();
  await refreshLibrary();
  await refreshStorageBar();
  if (failures.length) {
    alert(`Added "${title}" with ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}.\n\nSkipped:\n` + failures.join('\n'));
  }
}

// ---------- player ----------
async function openPlayer(bookId) {
  const book = normalizeBook(await idbGet('books', bookId));
  if (!book) return;
  currentBook = book;
  $('player-title').textContent = book.title;
  const ajah = ajahFor(book.title || book.id);
  $('cover-art').style.background = `linear-gradient(150deg, ${ajah.color}, rgba(0,0,0,0.85))`;
  $('cover-initial').textContent = (book.title || '?')[0].toUpperCase();
  $('speed-select').value = String(book.speed || 1);
  renderChapterList();
  showView('player');
  await loadChapter(book.currentChapterIndex, book.currentTime, false);
  clearSleepTimer();
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

async function loadChapter(index, offset, autoplay) {
  if (!currentBook) return;
  if (index < 0 || index >= currentBook.chapters.length) return;
  const ch = currentBook.chapters[index];
  const rel = Math.max(0, Math.min(offset || 0, ch.duration || 0));
  const abs = (ch.start || 0) + rel;

  currentBook.currentChapterIndex = index;
  currentBook.currentTime = rel;
  currentBook.lastPlayed = Date.now();
  idbPut('books', currentBook);

  updateChapterHeading();
  renderChapterList();
  updateMediaSessionMetadata();

  // Chapters inside the same file need only a seek, not a reload.
  if (ch.blobId === loadedBlobId && audioEl.readyState > 0) {
    audioEl.currentTime = abs;
    if (autoplay && audioEl.paused) audioEl.play().catch(() => {});
    updatePlayPauseIcon();
    return;
  }

  const rec = await idbGet('chapterBlobs', ch.blobId);
  if (!rec) return;

  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(rec.blob);
  loadedBlobId = ch.blobId;
  audioEl.src = currentBlobUrl;
  audioEl.playbackRate = currentBook.speed || 1;

  const onReady = () => {
    audioEl.removeEventListener('loadedmetadata', onReady);
    audioEl.currentTime = Math.min(abs, audioEl.duration || abs);
    if (autoplay) audioEl.play().catch(() => {});
    updatePlayPauseIcon();
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
    audioEl.pause();
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
  $('btn-playpause').innerHTML = audioEl.paused ? '&#9654;' : '&#10074;&#10074;';
}

function togglePlayPause() {
  if (audioEl.paused) audioEl.play().catch(() => {});
  else audioEl.pause();
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
  idbPut('books', currentBook);
}

async function deleteCurrentBook() {
  if (!currentBook) return;
  if (!confirm(`Unravel "${currentBook.title}"? This removes it and all its audio from this device.`)) return;
  const blobIds = Array.from(new Set(currentBook.chapters.map((c) => c.blobId)));
  for (const id of blobIds) {
    await idbDelete('chapterBlobs', id);
  }
  await idbDelete('books', currentBook.id);
  audioEl.pause();
  audioEl.removeAttribute('src');
  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
  loadedBlobId = null;
  currentBook = null;
  showView('library');
  await refreshLibrary();
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
      audioEl.pause();
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
  navigator.mediaSession.setActionHandler('pause', () => audioEl.pause());
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
    audioEl.pause();
    saveProgress();
    showView('library');
    refreshLibrary();
    refreshStorageBar();
  });
  $('btn-delete-book').addEventListener('click', deleteCurrentBook);

  $('tab-library').addEventListener('click', () => { showView('library'); refreshLibrary(); refreshStorageBar(); });
  $('tab-computer').addEventListener('click', () => showView('computer'));

  $('btn-playpause').addEventListener('click', togglePlayPause);
  $('btn-back-15').addEventListener('click', () => skipSeconds(-15));
  $('btn-fwd-30').addEventListener('click', () => skipSeconds(30));
  $('btn-next-chapter').addEventListener('click', nextChapter);
  $('btn-prev-chapter').addEventListener('click', prevChapter);

  $('speed-select').addEventListener('change', (e) => {
    const speed = parseFloat(e.target.value);
    audioEl.playbackRate = speed;
    if (currentBook) { currentBook.speed = speed; idbPut('books', currentBook); }
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

  audioEl.addEventListener('timeupdate', () => { checkChapterBoundary(); updateScrub(); });
  audioEl.addEventListener('play', () => { updatePlayPauseIcon(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  audioEl.addEventListener('pause', () => { updatePlayPauseIcon(); saveProgress(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
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

  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
  window.addEventListener('beforeunload', () => saveProgress());
}

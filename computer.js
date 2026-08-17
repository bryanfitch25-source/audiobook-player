/* The "My Computer" tab: talks to the PC-side library server over the
 * Cloudflare tunnel, lists what's stored there, and plays a book straight
 * off the server -- no download, no on-device copy. A lightweight library
 * record (title/author/chapters/streamUrl) is saved so resume position and
 * progress persist the same way a fully local book's does, but the actual
 * audio bytes are never written to this device; the <audio> element just
 * points at the PC's URL and the browser's own HTTP client handles Range
 * requests for seeking. This replaced an earlier download-into-IndexedDB
 * design that reliably crashed on large (500MB+) real audiobooks -- writing
 * a file that size into IndexedDB in chunks got slower per-chunk as the
 * write went on and eventually took the tab down before finishing, a
 * WebKit-side limitation no amount of chunk/batch tuning fully fixed.
 * Streaming sidesteps the problem: no giant on-device write ever happens. */

const ComputerTab = (() => {
  const STORAGE_KEY = 'pc-server-url';
  let baseUrl = null;
  let inFlight = new Set(); // book ids currently downloading, to guard double-taps

  // checkpoint / readDiagLog / clearDiagLogMarker / lastCrashedCheckpoint now
  // live in app.js as globals, shared with the local file-picker import path
  // so a crash in either one shows up in the same log.

  /* This used to trigger a file download via a[download].click(). That
   * mechanism has real, documented gesture-timing requirements on iOS
   * Safari/Chrome, and even after accounting for them it was still failing
   * silently for reasons that couldn't be pinned down remotely. Rendering
   * the report as plain visible text sidesteps the whole category of
   * problem: there's no download API involved at all, so nothing about
   * gesture timing, save dialogs, or Files integration can silently fail.
   * The user can read it, screenshot it, or select and copy it by hand. */
  async function buildDiagnosticReportText() {
    const log = await readDiagLog();
    const lines = [];
    lines.push('Audiobook player diagnostic report');
    lines.push('Generated: ' + new Date().toString());
    lines.push('User agent: ' + navigator.userAgent);
    lines.push('Connected server: ' + (baseUrl || '(not connected)'));

    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        lines.push(`Storage: ${Math.round((est.usage || 0) / 1e6)} MB used of ${Math.round((est.quota || 0) / 1e6)} MB quota`);
      }
    } catch (e) {}
    try {
      if (navigator.storage && navigator.storage.persisted) {
        lines.push('Persistent storage granted: ' + (await navigator.storage.persisted()));
      }
    } catch (e) {}

    lines.push('');
    lines.push(`--- Step log (${log.length} entries) ---`);
    if (!log.length) lines.push('(empty -- no download has been attempted since this was added)');
    let prevAt = null;
    for (const entry of log) {
      const t = new Date(entry.at).toISOString();
      const delta = prevAt ? `+${((entry.at - prevAt) / 1000).toFixed(1)}s` : '';
      lines.push(`${t}  ${delta.padEnd(8)}  ${entry.label}`);
      prevAt = entry.at;
    }

    return lines.join('\n');
  }

  function loadUrl() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored || null;
  }

  function normalizeUrl(raw) {
    let u = raw.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!u.endsWith('/')) u += '/';
    return u;
  }

  function el(id) { return document.getElementById(id); }

  async function onShow() {
    await showCrashReportIfAny();
    baseUrl = loadUrl();
    if (!baseUrl) {
      showConnectPanel(false);
    } else {
      showContent();
      await refreshList();
    }
  }

  async function showCrashReportIfAny() {
    const crashed = await lastCrashedCheckpoint();
    const box = el('computer-crash-report');
    if (!box) return;
    if (!crashed) { box.classList.add('hidden'); return; }
    const seconds = Math.round((Date.now() - crashed.at) / 1000);
    box.textContent = `Something went wrong last time. Last known step: "${crashed.label}" (${seconds}s before this reopen). Tap "Show Diagnostic Log" below to see the full log.`;
    box.classList.remove('hidden');
  }

  function showConnectPanel(cancelable) {
    el('computer-connect').classList.remove('hidden');
    el('computer-content').classList.add('hidden');
    el('computer-url-input').value = baseUrl || '';
    el('btn-computer-cancel').classList.toggle('hidden', !cancelable);
    el('computer-connect-error').classList.add('hidden');
  }

  function showContent() {
    el('computer-connect').classList.add('hidden');
    el('computer-content').classList.remove('hidden');
  }

  async function testConnection(url) {
    const res = await fetch(url + 'api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Server responded with ' + res.status);
    const data = await res.json();
    if (!data || data.ok !== true) throw new Error('Unexpected response from server');
  }

  async function saveConnection() {
    const raw = el('computer-url-input').value;
    if (!raw.trim()) return;
    const url = normalizeUrl(raw);
    const errEl = el('computer-connect-error');
    errEl.classList.add('hidden');
    const btn = el('btn-computer-save');
    btn.disabled = true;
    btn.textContent = 'Connecting...';
    try {
      await testConnection(url);
      localStorage.setItem(STORAGE_KEY, url);
      baseUrl = url;
      showContent();
      await refreshList();
    } catch (e) {
      errEl.textContent = "Couldn't reach that address. Check it was copied in full and your PC is on.";
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  function fmtBytesLocal(n) {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(1) + ' ' + u[i];
  }

  async function localBookByServerId(serverId) {
    const all = await idbGetAll('books');
    return all.find((b) => b.sourceServerId === serverId && b.sourceServerUrl === baseUrl) || null;
  }

  async function refreshList() {
    const statusEl = el('computer-status');
    const listEl = el('computer-list');
    const emptyEl = el('computer-empty');
    statusEl.textContent = 'Reading the PC library...';
    statusEl.classList.remove('hidden');
    listEl.innerHTML = '';

    let books;
    try {
      const res = await fetch(baseUrl + 'api/books', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      books = await res.json();
    } catch (e) {
      statusEl.textContent = "Couldn't reach the PC. Check it's on and connected.";
      return;
    }

    statusEl.classList.add('hidden');
    emptyEl.classList.toggle('hidden', books.length > 0);

    for (const book of books) {
      const local = await localBookByServerId(book.id);
      listEl.appendChild(renderRow(book, local));
    }
  }

  function renderRow(book, local) {
    const li = document.createElement('li');
    li.className = 'book-row';
    const ajah = typeof ajahFor === 'function' ? ajahFor(book.title || book.id) : { color: '#c9a34e' };
    li.style.setProperty('--ajah', ajah.color);

    const sub = `${escapeHtml(book.author || '')} ${book.author ? '&middot;' : ''} ${fmtTime(book.duration)} &middot; ${fmtBytesLocal(book.sizeBytes)}`;
    const badge = book.seriesNumber ? `<div class="series-badge">${escapeHtml(String(book.seriesNumber))}</div>` : '';

    li.innerHTML = `
      <div class="book-cover" style="background:linear-gradient(150deg, ${ajah.color}, rgba(0,0,0,0.75))">${badge}${escapeHtml((book.title || '?')[0].toUpperCase())}</div>
      <div class="book-meta">
        <div class="book-title">${escapeHtml(book.title)}</div>
        <div class="book-author">${sub}</div>
      </div>
    `;

    const action = document.createElement('div');
    const btn = document.createElement('button');
    btn.className = 'btn-download';
    btn.textContent = 'Play';
    btn.addEventListener('click', () => openRemoteBook(book, local, btn));
    action.appendChild(btn);
    li.appendChild(action);
    return li;
  }

  /* Tapping a PC book either opens it straight away (if it's already in the
   * library from a previous tap) or first writes the small metadata record
   * that lets it appear there, then opens it. Either way nothing but text
   * (title/author/chapter list/URL) ever touches this device's storage. */
  async function openRemoteBook(book, local, btn) {
    if (inFlight.has(book.id)) return;
    inFlight.add(book.id);
    btn.disabled = true;
    try {
      const bookId = local ? local.id : await createRemoteBookRecord(book);
      await openPlayer(bookId);
      clearDiagLogMarker();
    } catch (e) {
      await checkpoint('caught error opening remote book: ' + (e && e.message ? e.message : String(e)));
      alert('Could not open this book: ' + (e && e.message ? e.message : String(e)));
    } finally {
      btn.disabled = false;
      inFlight.delete(book.id);
    }
  }

  async function createRemoteBookRecord(book) {
    const streamUrl = baseUrl + 'api/books/' + encodeURIComponent(book.id) + '/file';
    const bookId = uid();
    const record = {
      id: bookId,
      title: book.title,
      author: book.author || '',
      seriesNumber: book.seriesNumber || null,
      streamUrl,
      chapters: (book.chapters && book.chapters.length)
        ? book.chapters.map((c) => ({ name: c.name, start: c.start, duration: c.duration }))
        : [{ name: book.title, start: 0, duration: book.duration || 0 }],
      currentChapterIndex: 0,
      currentTime: 0,
      speed: 1,
      addedDate: Date.now(),
      lastPlayed: Date.now(),
      sourceServerId: book.id,
      sourceServerUrl: baseUrl,
    };
    await idbPut('books', record);
    return bookId;
  }

  function wire() {
    el('btn-computer-save').addEventListener('click', saveConnection);
    el('btn-computer-settings').addEventListener('click', () => showConnectPanel(!!baseUrl));
    el('btn-computer-cancel').addEventListener('click', () => showContent());
    el('computer-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveConnection(); });
    const exportBtn = el('btn-computer-export-log');
    const exportBox = el('computer-log-box');
    const copyBtn = el('btn-computer-copy-log');
    if (exportBtn && exportBox) {
      exportBtn.addEventListener('click', () => {
        const wasVisible = !exportBox.classList.contains('hidden');
        if (wasVisible) {
          exportBox.classList.add('hidden');
          exportBtn.textContent = 'Show Diagnostic Log';
          if (copyBtn) copyBtn.classList.add('hidden');
          return;
        }
        exportBtn.disabled = true;
        exportBtn.textContent = 'Loading...';
        buildDiagnosticReportText().then((text) => {
          exportBox.textContent = text;
          exportBox.classList.remove('hidden');
          exportBtn.disabled = false;
          exportBtn.textContent = 'Hide Diagnostic Log';
          if (copyBtn) copyBtn.classList.remove('hidden');
          exportBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }).catch((err) => {
          exportBtn.disabled = false;
          exportBtn.textContent = 'Show Diagnostic Log';
          exportBox.textContent = 'Could not build the report: ' + (err && err.message ? err.message : String(err));
          exportBox.classList.remove('hidden');
        });
      });
    }
    if (copyBtn && exportBox) {
      copyBtn.addEventListener('click', () => {
        const text = exportBox.textContent || '';
        const done = () => { copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); };
        const failed = () => { copyBtn.textContent = 'Select text manually'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => {
            // Fallback for contexts where the async Clipboard API is blocked --
            // the legacy synchronous copy command via a selected range still
            // works as a direct result of this same tap.
            try {
              const range = document.createRange();
              range.selectNodeContents(exportBox);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              const ok = document.execCommand('copy');
              sel.removeAllRanges();
              ok ? done() : failed();
            } catch (e) { failed(); }
          });
        } else {
          failed();
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', wire);

  return { onShow };
})();

window.ComputerTab = ComputerTab;

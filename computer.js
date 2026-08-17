/* The "My Computer" tab: talks to the PC-side library server over the
 * Cloudflare tunnel, lists what's stored there, and downloads a book straight
 * into this device's own IndexedDB library using the same storage shape as a
 * manually-picked file. The server already ran everything through ffprobe
 * during import, so its title/author/chapters are trusted as-is rather than
 * re-parsed on the phone -- one correct source, not two that could disagree. */

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
    box.textContent = `Last download stopped without finishing. Last known step: "${crashed.label}" (${seconds}s before this reopen). Tap "Save Diagnostic Report" below to save the full log as a file.`;
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
    if (local) {
      action.className = 'dl-done';
      action.textContent = 'In library';
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn-download';
      btn.textContent = 'Download';
      btn.addEventListener('click', () => downloadBook(book, btn, action));
      action.appendChild(btn);
    }
    li.appendChild(action);
    return li;
  }

  /* Keeps the screen from auto-locking for the duration of a download.
   * Supported on iOS 16.4+ in both Safari and Chrome (same WebKit engine).
   * This only stops the *automatic* timeout-based lock -- it cannot stop a
   * manual press of the power button or the user switching apps. iOS
   * suspends a page's JavaScript entirely the moment it's backgrounded or
   * the screen is manually locked, and no web API can override that; a
   * download in progress at that moment will not resume on its own. There's
   * no way around this from inside a web app on iOS -- keeping the app open
   * and the screen on manually is the only thing that reliably works. */
  async function withWakeLock(fn) {
    let lock = null;
    const acquire = async () => {
      try {
        if ('wakeLock' in navigator) lock = await navigator.wakeLock.request('screen');
      } catch (e) { /* denied or unsupported -- proceed without it */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible' && !lock) acquire(); };
    await acquire();
    document.addEventListener('visibilitychange', onVisible);
    try {
      return await fn();
    } finally {
      document.removeEventListener('visibilitychange', onVisible);
      if (lock) lock.release().catch(() => {});
    }
  }

  async function downloadBook(book, btn, actionContainer) {
    if (inFlight.has(book.id)) return;
    inFlight.add(book.id);
    btn.disabled = true;

    const progressEl = document.createElement('span');
    progressEl.className = 'dl-progress';
    progressEl.textContent = '0%';
    actionContainer.appendChild(progressEl);

    try {
      await withWakeLock(() => downloadBookInner(book, progressEl));
      clearDiagLogMarker();
      progressEl.remove();
      actionContainer.innerHTML = '';
      const doneLabel = document.createElement('span');
      doneLabel.className = 'dl-done';
      doneLabel.textContent = 'In library';
      actionContainer.appendChild(doneLabel);
      if (typeof refreshStorageBar === 'function') refreshStorageBar();
    } catch (e) {
      await checkpoint('caught error: ' + (e && e.message ? e.message : String(e)));
      progressEl.textContent = 'Failed' + (e && e.message ? ': ' + e.message : '');
      btn.disabled = false;
      setTimeout(() => progressEl.remove(), 4000);
    } finally {
      inFlight.delete(book.id);
    }
  }

  async function downloadBookInner(book, progressEl) {
      await checkpoint(`fetching "${book.title}"`);
      const res = await fetch(baseUrl + 'api/books/' + encodeURIComponent(book.id) + '/file');
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || book.sizeBytes || 0;
      const contentType = res.headers.get('content-type') || 'application/octet-stream';

      // Audiobooks run hundreds of MB to a few GB. Holding every chunk as a
      // separate JS-visible Uint8Array for the whole download -- easily
      // thousands of them by the end -- is enough to get a mobile tab killed
      // for memory pressure partway through, which looks exactly like "hits
      // 100%, silently reloads, nothing was saved." Flushing chunks into an
      // intermediate Blob every few MB lets the browser release that raw
      // memory as it goes, so the resident set stays bounded regardless of
      // how large the book is.
      const FLUSH_BYTES = 8 * 1024 * 1024;
      const reader = res.body.getReader();
      const parts = [];
      let buffer = [];
      let bufferedBytes = 0;
      let received = 0;

      // Checkpointing every single chunk (there can be thousands) would mean
      // thousands of IndexedDB transactions during one download -- real
      // overhead for not much extra diagnostic value. Once per flush (every
      // ~8MB) is fine-grained enough to pin down where a crash happened
      // without slowing the download down.
      const flush = async () => {
        if (!buffer.length) return;
        parts.push(new Blob(buffer, { type: contentType }));
        buffer = [];
        bufferedBytes = 0;
        const pct = total ? Math.round((received / total) * 100) : 0;
        await checkpoint(`streaming "${book.title}": ${pct}% (${parts.length} parts, ${fmtBytesLocal(received)})`);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer.push(value);
        bufferedBytes += value.length;
        received += value.length;
        if (bufferedBytes >= FLUSH_BYTES) await flush();
        const pct = total ? Math.round((received / total) * 100) : 0;
        progressEl.textContent = pct + '%';
      }
      await flush();

      progressEl.textContent = 'Saving...';
      await checkpoint(`combining ${parts.length} parts into one file for "${book.title}" (${fmtBytesLocal(received)})`);
      const blob = new Blob(parts, { type: contentType });
      parts.length = 0; // done with the intermediate pieces once combined

      await checkpoint(`verifying playability of "${book.title}"`);
      // probeFile() decides whether to trust a large file outright (rather
      // than risk handing it to an <audio> element) based on the filename's
      // extension -- so this synthetic File needs a real one matching what
      // the server actually sent, not a generic name that would defeat that
      // check and route a perfectly fine multi-hundred-MB book through the
      // exact probe that's proven unsafe at this size.
      const CONTENT_TYPE_EXT = { 'audio/mp4': 'm4b', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/wav': 'wav', 'audio/opus': 'opus' };
      const probeExt = CONTENT_TYPE_EXT[contentType] || 'm4b';
      const probe = await probeFile(new File([blob], `downloaded.${probeExt}`, { type: contentType }));
      if (!probe.playable) throw new Error('This device could not play the downloaded file');

      await checkpoint(`writing "${book.title}" to IndexedDB in chunks (${fmtBytesLocal(blob.size)})`);
      const blobId = uid();
      await idbPutBlobChunked(blobId, blob, contentType, (done, count) => {
        checkpoint(`wrote chunk ${done}/${count} for "${book.title}"`);
      });
      await checkpoint(`writing "${book.title}" book record`);

      const bookId = uid();
      const record = {
        id: bookId,
        title: book.title,
        author: book.author || '',
        seriesNumber: book.seriesNumber || null,
        chapters: (book.chapters || []).map((c) => ({ blobId, name: c.name, start: c.start, duration: c.duration })),
        currentChapterIndex: 0,
        currentTime: 0,
        speed: 1,
        addedDate: Date.now(),
        lastPlayed: Date.now(),
        sourceServerId: book.id,
        sourceServerUrl: baseUrl,
      };
      if (!record.chapters.length) {
        record.chapters = [{ blobId, name: book.title, start: 0, duration: probe.duration || book.duration || 0 }];
      }
      await idbPut('books', record);
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

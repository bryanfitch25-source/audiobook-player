/* PC link: talks to the PC-side library server over the Cloudflare tunnel.
 * Owns the connection itself, the live PC catalog, pushing playback progress
 * back to the server for cross-device resume, and the live "importing"
 * status feed -- app.js's unified catalog renders on top of what this module
 * exposes rather than keeping its own separate "My Computer" screen. */

const PCLink = (() => {
  const STORAGE_KEY = 'pc-server-url';
  let baseUrl = null;
  let catalog = []; // last-fetched PC book list, each with server-side `progress`
  let currentImport = null; // { title, status, percent, label } | null
  let importSource = null; // EventSource
  const listeners = new Set(); // called whenever catalog/currentImport changes

  function onChange(fn) { listeners.add(fn); }
  function notify() { for (const fn of listeners) fn(); }

  function isConnected() { return !!baseUrl; }
  function getBaseUrl() { return baseUrl; }
  function getCatalog() { return catalog; }
  function getCurrentImport() { return currentImport; }

  function loadUrl() {
    return localStorage.getItem(STORAGE_KEY) || null;
  }

  function normalizeUrl(raw) {
    let u = raw.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!u.endsWith('/')) u += '/';
    return u;
  }

  async function testConnection(url) {
    const res = await fetch(url + 'api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('Server responded with ' + res.status);
    const data = await res.json();
    if (!data || data.ok !== true) throw new Error('Unexpected response from server');
  }

  async function connect(rawUrl) {
    const url = normalizeUrl(rawUrl);
    await testConnection(url);
    localStorage.setItem(STORAGE_KEY, url);
    baseUrl = url;
    startImportFeed();
    await refreshCatalog();
  }

  function forget() {
    localStorage.removeItem(STORAGE_KEY);
    baseUrl = null;
    catalog = [];
    stopImportFeed();
    notify();
  }

  async function refreshCatalog() {
    if (!baseUrl) return;
    try {
      const res = await fetch(baseUrl + 'api/books', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      catalog = await res.json();
    } catch (e) {
      catalog = [];
    }
    notify();
  }

  function streamUrlFor(serverId) {
    return baseUrl + 'api/books/' + encodeURIComponent(serverId) + '/file';
  }

  /* Fire-and-forget by design: a progress push that fails (signal drop mid-
   * listen) shouldn't interrupt playback or retry-storm the server. The next
   * periodic push a few seconds later covers for it. */
  async function pushProgress(serverId, currentTime, currentChapterIndex) {
    if (!baseUrl) return;
    // Updated in the local catalog cache immediately, not just pushed to the
    // server -- anything rendered from getCatalog() (the author page, the
    // currently-listening card, finished/unread splits) reads that cache
    // directly, and would otherwise keep showing the position from whenever
    // the catalog was last fully refreshed instead of just now.
    const book = catalog.find((b) => b.id === serverId);
    if (book) book.progress = { currentTime, currentChapterIndex, updatedAt: Date.now() };
    try {
      await fetch(baseUrl + 'api/books/' + encodeURIComponent(serverId) + '/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentTime, currentChapterIndex }),
      });
    } catch (e) {}
  }

  async function deleteFromServer(serverId) {
    if (!baseUrl) return;
    await fetch(baseUrl + 'api/books/' + encodeURIComponent(serverId), { method: 'DELETE' });
    await refreshCatalog();
  }

  function startImportFeed() {
    stopImportFeed();
    if (!baseUrl || typeof EventSource === 'undefined') return;
    try {
      importSource = new EventSource(baseUrl + 'api/imports/current');
      importSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          const wasActive = !!currentImport;
          currentImport = data && data.status ? data : null;
          notify();
          // A finished/errored import clears itself server-side a few seconds
          // later -- that's also the moment the new book is actually ready,
          // so refresh the catalog once rather than polling for it.
          if (wasActive && !currentImport) refreshCatalog();
        } catch (err) {}
      };
      importSource.onerror = () => {}; // EventSource auto-reconnects; nothing to do
    } catch (e) {}
  }

  function stopImportFeed() {
    if (importSource) { importSource.close(); importSource = null; }
    currentImport = null;
  }

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
    if (!log.length) lines.push('(empty -- no import or download has been attempted since this was added)');
    let prevAt = null;
    for (const entry of log) {
      const t = new Date(entry.at).toISOString();
      const delta = prevAt ? `+${((entry.at - prevAt) / 1000).toFixed(1)}s` : '';
      lines.push(`${t}  ${delta.padEnd(8)}  ${entry.label}`);
      prevAt = entry.at;
    }

    return lines.join('\n');
  }

  function el(id) { return document.getElementById(id); }

  async function showCrashReportIfAny() {
    const crashed = await lastCrashedCheckpoint();
    const box = el('computer-crash-report');
    if (!box) return;
    if (!crashed) { box.classList.add('hidden'); return; }
    const seconds = Math.round((Date.now() - crashed.at) / 1000);
    box.textContent = `Something went wrong last time. Last known step: "${crashed.label}" (${seconds}s before this reopen). Tap "Show Diagnostic Log" below to see the full log.`;
    box.classList.remove('hidden');
  }

  function wireSettingsPanel() {
    const urlInput = el('computer-url-input');
    const errEl = el('computer-connect-error');
    const connectedAs = el('computer-connected-as');
    const forgetBtn = el('btn-computer-forget');
    const saveBtn = el('btn-computer-save');

    function refreshConnectUi() {
      urlInput.value = baseUrl || '';
      forgetBtn.classList.toggle('hidden', !baseUrl);
      if (baseUrl) {
        connectedAs.textContent = 'Connected to ' + baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        connectedAs.classList.remove('hidden');
      } else {
        connectedAs.classList.add('hidden');
      }
    }
    onChange(refreshConnectUi);
    refreshConnectUi();

    saveBtn.addEventListener('click', async () => {
      const raw = urlInput.value;
      if (!raw.trim()) return;
      errEl.classList.add('hidden');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Connecting...';
      try {
        await connect(raw);
      } catch (e) {
        errEl.textContent = "Couldn't reach that address. Check it was copied in full and your PC is on.";
        errEl.classList.remove('hidden');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Connect';
      }
    });

    forgetBtn.addEventListener('click', () => {
      if (!confirm('Forget this PC? Streamed books stay on the PC, but you\'ll need to reconnect to see them here.')) return;
      forget();
    });

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

  async function init() {
    baseUrl = loadUrl();
    if (baseUrl) {
      startImportFeed();
      await refreshCatalog();
    }
    await showCrashReportIfAny();
    wireSettingsPanel();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    isConnected, getBaseUrl, getCatalog, getCurrentImport,
    refreshCatalog, streamUrlFor, pushProgress, deleteFromServer,
    onChange,
  };
})();

window.PCLink = PCLink;

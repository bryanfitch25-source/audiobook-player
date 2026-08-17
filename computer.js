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
    baseUrl = loadUrl();
    if (!baseUrl) {
      showConnectPanel(false);
    } else {
      showContent();
      await refreshList();
    }
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

    li.innerHTML = `
      <div class="book-cover" style="background:linear-gradient(150deg, ${ajah.color}, rgba(0,0,0,0.75))">${escapeHtml((book.title || '?')[0].toUpperCase())}</div>
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

  async function downloadBook(book, btn, actionContainer) {
    if (inFlight.has(book.id)) return;
    inFlight.add(book.id);
    btn.disabled = true;

    const progressEl = document.createElement('span');
    progressEl.className = 'dl-progress';
    progressEl.textContent = '0%';
    actionContainer.appendChild(progressEl);

    try {
      const res = await fetch(baseUrl + 'api/books/' + encodeURIComponent(book.id) + '/file');
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || book.sizeBytes || 0;
      const contentType = res.headers.get('content-type') || 'application/octet-stream';

      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) progressEl.textContent = Math.round((received / total) * 100) + '%';
      }

      progressEl.textContent = 'Saving...';
      const blob = new Blob(chunks, { type: contentType });

      // Sanity check it actually plays on this device before adding it -- cheap and local.
      const probe = await probeFile(new File([blob], 'downloaded', { type: contentType }));
      if (!probe.playable) throw new Error('This device could not play the downloaded file');

      const blobId = uid();
      await idbPut('chapterBlobs', { id: blobId, blob, type: contentType });

      const bookId = uid();
      const record = {
        id: bookId,
        title: book.title,
        author: book.author || '',
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

      progressEl.remove();
      actionContainer.innerHTML = '';
      const doneLabel = document.createElement('span');
      doneLabel.className = 'dl-done';
      doneLabel.textContent = 'In library';
      actionContainer.appendChild(doneLabel);

      if (typeof refreshStorageBar === 'function') refreshStorageBar();
    } catch (e) {
      progressEl.textContent = 'Failed';
      btn.disabled = false;
      setTimeout(() => progressEl.remove(), 2500);
    } finally {
      inFlight.delete(book.id);
    }
  }

  function wire() {
    el('btn-computer-save').addEventListener('click', saveConnection);
    el('btn-computer-settings').addEventListener('click', () => showConnectPanel(!!baseUrl));
    el('btn-computer-cancel').addEventListener('click', () => showContent());
    el('computer-url-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveConnection(); });
  }

  document.addEventListener('DOMContentLoaded', wire);

  return { onShow };
})();

window.ComputerTab = ComputerTab;

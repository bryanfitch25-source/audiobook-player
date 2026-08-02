/* Beam: a throwaway LAN file server for getting audiobooks onto a phone fast.
 *
 * Serves one folder over Wi-Fi. Open the printed URL in Safari, tap files, and
 * they land in the Files app at full local network speed. Nothing leaves the
 * house and no cloud account is involved.
 *
 * The one detail that matters: audio must be sent with
 * Content-Disposition: attachment. Without it iOS Safari opens an mp3 in its
 * inline player instead of saving it, and there is no obvious way to download.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(process.argv[2] || process.cwd());
const PORT = parseInt(process.argv[3], 10) || 8200;

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error('Not a folder: ' + ROOT);
  process.exit(1);
}

const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'aiff', 'aif', 'caf', 'flac', 'ogg', 'oga',
  'opus', 'wma', 'ape', 'wv', 'mpc', 'tta', 'ac3', 'dts', 'au', 'amr', 'mka',
  'mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv', 'aa', 'aax', 'dsf', 'dff',
]);

const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus',
  mp4: 'video/mp4', mkv: 'video/x-matroska', m4v: 'video/x-m4v',
};

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + ' ' + u[i];
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Keep every request inside ROOT.
function safeResolve(urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/+/, ''));
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function naturalCmp(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>
:root{--ink:#0d0b09;--leather:#1f1913;--parchment:#ece0c8;--dim:#a2917a;--gold:#c9a34e;--gold2:#e8c979}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--parchment);
 font-family:"Iowan Old Style",Palatino,Georgia,serif;
 padding:calc(18px + env(safe-area-inset-top)) 16px calc(28px + env(safe-area-inset-bottom))}
h1{font-size:21px;color:var(--gold2);margin:0 0 2px}
.sub{font-size:12px;color:var(--dim);margin:0 0 18px;word-break:break-all}
a{color:inherit;text-decoration:none}
.row{display:flex;align-items:center;gap:12px;padding:15px 12px;margin-bottom:8px;
 background:linear-gradient(180deg,rgba(42,34,26,.6),rgba(23,19,16,.6));
 border:1px solid rgba(201,163,78,.18);border-left:3px solid var(--gold);border-radius:3px}
.row:active{background:#2a221a}
.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px}
.sz{font-size:12px;color:var(--dim);white-space:nowrap}
.dir{border-left-color:var(--dim)}
.bar{display:flex;gap:10px;margin-bottom:16px}
button{flex:1;padding:13px;font-size:15px;font-family:inherit;border-radius:3px;
 border:1px solid var(--gold2);background:linear-gradient(180deg,var(--gold),#9c7c34);color:var(--ink)}
button:active{opacity:.7}
.note{font-size:12px;color:var(--dim);line-height:1.5;margin-top:22px;
 border-left:2px solid var(--gold);padding-left:10px}
</style></head><body>${body}</body></html>`;
}

function sendIndex(res, dirAbs, urlPath) {
  let entries;
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); }
  catch (e) { res.writeHead(500); return res.end('Cannot read folder'); }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(naturalCmp);
  const files = entries.filter((e) => e.isFile()).map((e) => e.name)
    .filter((n) => AUDIO_EXT.has(path.extname(n).slice(1).toLowerCase()))
    .sort(naturalCmp);

  const base = urlPath.endsWith('/') ? urlPath : urlPath + '/';
  let total = 0;
  const rows = [];

  if (base !== '/') {
    const up = path.posix.resolve(base, '..');
    rows.push(`<a href="${esc(up)}"><div class="row dir"><div class="nm">.. back</div></div></a>`);
  }

  for (const d of dirs) {
    rows.push(`<a href="${esc(base + encodeURIComponent(d))}/"><div class="row dir">` +
      `<div class="nm">${esc(d)}</div><div class="sz">folder</div></div></a>`);
  }

  for (const f of files) {
    let size = 0;
    try { size = fs.statSync(path.join(dirAbs, f)).size; } catch (e) {}
    total += size;
    const href = base + encodeURIComponent(f);
    rows.push(`<a class="dl" href="${esc(href)}" download><div class="row">` +
      `<div class="nm">${esc(f)}</div><div class="sz">${fmtBytes(size)}</div></div></a>`);
  }

  const allBtn = files.length > 1
    ? `<div class="bar"><button onclick="dlAll()">Download all ${files.length} files</button></div>`
    : '';

  const body = `
<h1>Beam</h1>
<p class="sub">${esc(decodeURIComponent(base))} &middot; ${files.length} file${files.length === 1 ? '' : 's'} &middot; ${fmtBytes(total)}</p>
${allBtn}
${rows.join('\n') || '<p class="sub">No audio files here.</p>'}
<p class="note">In Chrome: tap a file, let it download, then use <b>Save to Files</b> and put it in
<b>On My iPhone</b>. Keeping it on the phone rather than iCloud Drive avoids a slow upload and does not eat your iCloud quota.<br><br>
Then open The Pattern, tap the Wheel, and choose the files. You can select the whole book at once.</p>
<script>
function dlAll(){
  var links=[].slice.call(document.querySelectorAll('a.dl'));
  links.forEach(function(a,i){setTimeout(function(){
    var t=document.createElement('a');t.href=a.getAttribute('href');t.download='';
    document.body.appendChild(t);t.click();t.remove();
  }, i*900);});
}
</script>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page('Beam', body));
}

function sendFile(req, res, abs) {
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { res.writeHead(404); return res.end('Not found'); }

  const ext = path.extname(abs).slice(1).toLowerCase();
  const name = path.basename(abs);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // Without this iOS Safari plays the file instead of saving it.
    'Content-Disposition': 'attachment; filename="' + name.replace(/["\\]/g, '') + '"; ' +
      "filename*=UTF-8''" + encodeURIComponent(name),
    'Accept-Ranges': 'bytes',
  };

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const abs = safeResolve(urlPath);
  if (!abs) { res.writeHead(403); return res.end('Forbidden'); }

  let stat;
  try { stat = fs.statSync(abs); } catch (e) { res.writeHead(404); return res.end('Not found'); }

  if (stat.isDirectory()) sendIndex(res, abs, urlPath);
  else sendFile(req, res, abs);
}).listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push({ name, ip: n.address });
    }
  }
  console.log('');
  console.log('  Serving: ' + ROOT);
  console.log('');
  if (!ips.length) console.log('  No network address found. Is Wi-Fi on?');
  for (const { name, ip } of ips) {
    console.log('  In Chrome on your iPhone open:   http://' + ip + ':' + PORT + '     (' + name + ')');
  }
  console.log('');
  console.log('  Both devices must be on the same Wi-Fi.');
  console.log('  Press Ctrl+C when the transfer is done.');
  console.log('');
});

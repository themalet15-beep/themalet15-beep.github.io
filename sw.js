// Serves the folder picked in launch.html as if it were the origin root (replaces server.py / server.mjs).
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', map: 'application/json',
};
const PASS = new Set(['/index.html', '/sw.js']);
const MAX_BATCH = 64 * 1024 * 1024;

const idb = () => new Promise((ok, err) => {
  const r = indexedDB.open('gta-local', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => err(r.error);
});
let cached = null;
async function getRoot() {
  if (cached) return cached;
  const db = await idb();
  cached = await new Promise((ok, err) => {
    const r = db.transaction('kv').objectStore('kv').get('root');
    r.onsuccess = () => ok(r.result || null);
    r.onerror = () => err(r.error);
  });
  return cached;
}

const isolation = () => ({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Accept-Ranges': 'bytes',
});
const fail = (code, msg) => new Response(msg, { status: code, headers: { ...isolation(), 'Content-Type': 'text/plain' } });

async function fileAt(root, parts) {
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}
function cleanParts(raw) {
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.some((p) => p === '.' || p === '..' || p.includes('\\'))) return null;
  return parts;
}

async function serve(req, url, root) {
  let parts;
  try { parts = cleanParts(url.pathname); } catch { return fail(400, 'bad path'); }
  if (!parts) return fail(404, 'not found');
  if (!parts.length || url.pathname.endsWith('/')) parts.push('index.html');
  let file;
  try { file = await fileAt(root, parts); } catch { return fail(404, 'not found'); }

  const size = file.size, name = parts[parts.length - 1];
  const headers = { ...isolation(), 'Content-Type': TYPES[name.split('.').pop().toLowerCase()] || 'application/octet-stream' };
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.get('Range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2])) return fail(416, 'bad range');
    start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
    end = m[1] && m[2] ? Math.min(size - 1, parseInt(m[2], 10)) : size - 1;
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { ...isolation(), 'Content-Range': `bytes */${size}` } });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  const body = req.method === 'HEAD' || !size ? null : file.slice(start, end + 1);
  return new Response(body, { status, headers });
}

// POST /data/batch: [[name, start, end], ...] -> concatenated byte runs, lengths in X-Run-Lengths.
// (The gz=1 flag is ignored: compressing local reads only costs time.)
async function batch(req, root) {
  try {
    const runs = JSON.parse(await req.text());
    if (!Array.isArray(runs) || runs.length > 1000) throw new Error('invalid batch');
    const blobs = [], lengths = [];
    let total = 0;
    for (const run of runs) {
      if (!Array.isArray(run) || run.length !== 3) throw new Error('invalid batch');
      const [name, start, end] = run;
      if (typeof name !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw new Error('invalid file/range');
      const parts = cleanParts(name);
      if (!parts || !parts.length) throw new Error('invalid file/range');
      const file = await fileAt(root, ['data', ...parts]);
      const n = Math.max(0, Math.min(end + 1, file.size) - start);
      total += n;
      if (total > MAX_BATCH) throw new Error('batch exceeds 64 MiB');
      blobs.push(file.slice(start, start + n));
      lengths.push(n);
    }
    return new Response(new Blob(blobs), {
      status: 200,
      headers: { ...isolation(), 'Content-Type': 'application/octet-stream', 'X-Run-Lengths': lengths.join(',') },
    });
  } catch (e) {
    return fail(400, String(e.message || e));
  }
}

async function handle(req, url) {
  const root = await getRoot();
  let ok = false;
  try { ok = !!root && (await root.queryPermission({ mode: 'read' })) === 'granted'; } catch {}
  if (!ok) return req.mode === 'navigate' ? Response.redirect('/index.html', 302) : fail(503, 'Folder access not granted: open /index.html');
  if (req.method === 'POST' && url.pathname === '/data/batch') return batch(req, root);
  if (req.method === 'GET' || req.method === 'HEAD') return serve(req, url, root);
  return fail(404, 'not found');
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => { if (e.data === 'reset') cached = null; });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || PASS.has(url.pathname)) return;
  e.respondWith(handle(e.request, url));
});

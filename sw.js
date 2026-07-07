/* sw.js — service worker as a virtual filesystem over a PRIVATE GitHub repo.
 *
 * Everything under  <scope>fs/<repo-relative-path>  is intercepted and served
 * from the private decks repo via the GitHub contents API, using a PAT the page
 * hands us over postMessage. Because a deck document is served at the path that
 * MIRRORS its repo layout, the deck's own relative refs (./support.js,
 * ./assets/…) resolve back under fs/ and get proxied too — so a multi-file deck
 * renders with zero source changes.
 *
 * For a .dc.html document we inject the vendored React/Babel + dc-editor.js
 * (same as serve.js does locally), UNLESS ?raw=1 is present — the editor fetches
 * ?raw=1 to get pristine source, so saves stay clean Claude-Design DC.
 *
 * The PAT lives only in this worker's memory (+ the page's localStorage). It is
 * never written into any served HTML. Writes (commits) are done by the page, not
 * here — the worker only reads.
 */
'use strict';

const CACHE = 'decks-fs-v2';
let TOKEN = null;
let CFG = null;               // { owner, repo, branch }

const SCOPE = self.registration.scope;                 // e.g. https://user.github.io/decks-shell/
const BASE = new URL(SCOPE).pathname;                  // e.g. /decks-shell/
const MOUNT = SCOPE + 'fs/';                            // absolute URL prefix we own
const FS = BASE + 'fs/';                                // path form, e.g. /decks-shell/fs/

const MIME = {
  html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ttf: 'font/ttf', woff: 'font/woff',
  woff2: 'font/woff2', pdf: 'application/pdf',
};
const extOf = (p) => (p.split('.').pop() || '').toLowerCase();
const mimeOf = (p) => MIME[extOf(p)] || 'application/octet-stream';

// Editor + vendored React/Babel are NOT duplicated in the shell — they live once
// in the private repo's _editor/ and are pulled through the SW (/fs/_editor/…),
// the same single files serve.js injects locally.
const VENDOR =
  `\n<script src="${FS}_editor/vendor/react.production.min.js"></script>` +
  `\n<script src="${FS}_editor/vendor/react-dom.production.min.js"></script>` +
  `\n<script src="${FS}_editor/vendor/babel.min.js"></script>`;
function inject(html) {
  return html
    .replace(/<head[^>]*>/i, (m) => m + VENDOR)
    .replace(/<\/body>/i, `<script src="${FS}_editor/dc-editor.js"></script>\n</body>`);
}
// ?present=1 → deck runtime only (no editor), rail off. Used by the presenter
// window's current/next preview iframes. Mirrors serve.js injectPreview.
const PRESENT_TWEAK =
  '<script>(function(){function s(){var d=document.querySelector("deck-stage");' +
  'if(!d)return setTimeout(s,40);d.setAttribute("no-rail","");}s();})();</script>';
function injectPreview(html) {
  return html
    .replace(/<head[^>]*>/i, (m) => m + VENDOR)
    .replace(/<\/body>/i, PRESENT_TWEAK + '\n</body>');
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
  await self.clients.claim();
})()));

self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'auth') { TOKEN = m.token || null; CFG = m.config || CFG; }
  else if (m.type === 'config') { CFG = m.config || CFG; }
  else if (m.type === 'signout') {
    TOKEN = null;
    e.waitUntil(caches.delete(CACHE));
  } else if (m.type === 'bust') {
    // Drop cached copies of a path after a commit so the re-render is fresh.
    e.waitUntil((async () => {
      const c = await caches.open(CACHE);
      const keys = await c.keys();
      await Promise.all(keys
        .filter((req) => req.url.includes('/fs/' + m.path))
        .map((req) => c.delete(req)));
    })());
  }
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (!url.startsWith(MOUNT)) return;                   // not ours → normal network
  e.respondWith(handle(e.request));
});

async function handle(req) {
  const u = new URL(req.url);
  const rel = decodeURIComponent(u.pathname.slice(FS.length));
  const raw = u.searchParams.has('raw');
  const present = u.searchParams.has('present');
  const isDeck = /\.dc\.html$/i.test(rel);
  const htmlHeaders = { 'content-type': 'text/html', 'cache-control': 'no-cache' };

  if (!TOKEN || !CFG) return new Response('No token — open the gallery and sign in.', { status: 401 });

  const cache = await caches.open(CACHE);
  const cacheKey = new Request(MOUNT + rel);            // key ignores query

  // Assets: cache-first. Deck HTML: never cached — edits must stay fresh, and the
  // editor vs. present injection differ per request.
  if (!isDeck) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const bytes = await fetchRepoFile(rel);
  if (bytes instanceof Response) return bytes;          // error passthrough

  if (isDeck) {
    const html = new TextDecoder().decode(bytes);
    const out = raw ? html : present ? injectPreview(html) : inject(html);
    return new Response(out, { headers: htmlHeaders });
  }
  const base = new Response(bytes, { headers: { 'content-type': mimeOf(rel), 'cache-control': 'no-cache' } });
  cache.put(cacheKey, base.clone());
  return base;
}

// Read a file from the private repo. Uses the raw media type (streams up to
// 100MB, handles binary). Returns an ArrayBuffer, or a Response on error.
async function fetchRepoFile(rel) {
  const api = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${
    rel.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(CFG.branch)}`;
  let r;
  try {
    r = await fetch(api, { headers: { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github.raw' } });
  } catch (err) {
    return new Response('Network error reaching GitHub: ' + err.message, { status: 502 });
  }
  if (!r.ok) return new Response(`GitHub ${r.status} for ${rel}`, { status: r.status });
  return r.arrayBuffer();
}

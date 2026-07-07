/* app.js — gallery + token paste + SW wiring + iframe viewer + delegated commit.
 *
 * The service worker reads the private repo (to render decks); THIS page owns the
 * token and does the writes. When the editor inside the deck iframe wants to save,
 * it postMessages the pristine text up here and we commit it via the GitHub
 * contents API, then tell the SW to bust its cache for that path.
 *
 * owner/repo/branch come from config.js. The only runtime input is the token.
 */
'use strict';

const BASE = location.pathname.replace(/[^/]*$/, '');    // dir of index.html, e.g. /whatever/
const LS_TOKEN = 'decks_gh_pat';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
function setStatus(msg, err) { statusEl.textContent = msg || ''; statusEl.classList.toggle('err', !!err); }

const cfg = window.DECKS_CONFIG || {};
let token = localStorage.getItem(LS_TOKEN) || '';
let currentDeckPath = null;

const ghHeaders = () => ({ Authorization: 'token ' + token, Accept: 'application/vnd.github+json' });

// ---- service worker ----
let swReady = null;
async function initSW() {
  if (!('serviceWorker' in navigator)) { setStatus('This browser has no service workers — online view needs them.', true); return; }
  await navigator.serviceWorker.register(BASE + 'sw.js');
  swReady = await navigator.serviceWorker.ready;
  sendAuth();
  navigator.serviceWorker.addEventListener('controllerchange', sendAuth);
  // First load: page not yet controlled → iframe fetches would miss the SW. Reload once.
  if (!navigator.serviceWorker.controller && !sessionStorage.getItem('sw-reloaded')) {
    sessionStorage.setItem('sw-reloaded', '1');
    location.reload();
  }
}
function swPost(msg) {
  const w = (swReady && swReady.active) || navigator.serviceWorker.controller;
  if (w) w.postMessage(msg);
}
function sendAuth() { swPost({ type: 'auth', token, config: cfg }); }
function bust(path) { swPost({ type: 'bust', path }); }

// ---- auth UI ----
function showAuthed(on) {
  $('bar').style.display = on ? 'flex' : 'none';
  $('signin').classList.toggle('show', !on);
}
async function pasteToken() {
  let t = '';
  try { t = (await navigator.clipboard.readText()) || ''; } catch { /* denied / unsupported */ }
  t = t.trim();
  if (!t) t = (prompt('Paste your GitHub token:') || '').trim();
  if (!t) return;
  token = t;
  localStorage.setItem(LS_TOKEN, token);
  sendAuth();
  listDecks();
}
function signOut() {
  token = '';
  localStorage.removeItem(LS_TOKEN);
  swPost({ type: 'signout' });
  closeDeck();
  $('grid').innerHTML = '';
  setStatus('');
  showAuthed(false);
}

// ---- gallery ----
async function listDecks() {
  if (!token) { showAuthed(false); return; }
  showAuthed(true);
  setStatus('Loading decks…');
  $('grid').innerHTML = '';
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`;
  let r;
  try { r = await fetch(url, { headers: ghHeaders() }); }
  catch (e) { setStatus('Network error: ' + e.message, true); return; }
  if (r.status === 401 || r.status === 403) { setStatus('Token rejected (' + r.status + '). Check scopes, then paste again.', true); signOut(); return; }
  if (!r.ok) { setStatus('GitHub ' + r.status + ' — check owner/repo/branch in config.js.', true); return; }
  const { tree = [] } = await r.json();
  const decks = tree.filter((n) => n.type === 'blob' && /\.dc\.html$/i.test(n.path)).map((n) => n.path).sort();
  render(decks);
  setStatus(decks.length ? decks.length + (decks.length === 1 ? ' deck' : ' decks') : '');
}
function render(paths) {
  const grid = $('grid');
  if (!paths.length) { grid.innerHTML = '<p class="empty">No .dc.html decks found in this repo.</p>'; return; }
  grid.innerHTML = '';
  for (const p of paths) {
    const name = decodeURIComponent(p.split('/').pop().replace(/\.dc\.html$/i, ''));
    const folder = p.split('/').slice(0, -1).join('/') || '(root)';
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `<span class="t"></span><span class="m"></span>`;
    card.querySelector('.t').textContent = name;
    card.querySelector('.m').textContent = folder;
    card.addEventListener('click', () => openDeck(p));
    grid.appendChild(card);
  }
}

// ---- viewer ----
function openDeck(path) {
  currentDeckPath = path;
  $('vtitle').textContent = path;
  const segs = path.split('/').map(encodeURIComponent).join('/');
  $('frame').src = BASE + 'fs/' + segs;
  $('viewer').classList.add('show');
}
function closeDeck() {
  $('viewer').classList.remove('show');
  $('frame').src = 'about:blank';
  currentDeckPath = null;
}

// ---- delegated commit (editor in iframe → here) ----
async function commitDeck(path, text) {
  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  let sha;
  const g = await fetch(api + '?ref=' + encodeURIComponent(cfg.branch), { headers: ghHeaders() });
  if (g.ok) sha = (await g.json()).sha;               // absent = new file
  const body = { message: 'edit ' + path, content: b64utf8(text), branch: cfg.branch, ...(sha ? { sha } : {}) };
  const p = await fetch(api, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!p.ok) throw new Error('PUT ' + p.status + ' ' + (await p.text()).slice(0, 200));
}
function b64utf8(s) { return btoa(unescape(encodeURIComponent(s))); }

window.addEventListener('message', async (ev) => {
  const m = ev.data;
  if (!m || !m.__dc) return;
  const src = ev.source;
  if (m.__dc === 'hello') { src && src.postMessage({ __dc: 'can-save', ok: !!token }, '*'); return; }
  if (m.__dc === 'save') {
    const path = currentDeckPath;
    try {
      await commitDeck(path, m.text);
      bust(path);
      src && src.postMessage({ __dc: 'save-result', id: m.id, ok: true }, '*');
    } catch (e) {
      src && src.postMessage({ __dc: 'save-result', id: m.id, ok: false, error: String(e.message || e) }, '*');
    }
  }
});

// ---- wire ----
$('btn-refresh').addEventListener('click', listDecks);
$('btn-signout').addEventListener('click', signOut);
$('btn-paste').addEventListener('click', pasteToken);
$('btn-back').addEventListener('click', closeDeck);

(async function main() {
  $('sub').textContent = `${cfg.owner}/${cfg.repo}@${cfg.branch} · git-backed · edit anywhere`;
  await initSW();
  if (token) listDecks(); else showAuthed(false);
})();

# decks-shell

Public GitHub-Pages shell that lets you **view and edit** the decks in a **private**
`decks` repo from any browser — git-backed, no server, focknote-style.

The shell is a tiny static SPA + a service worker. The service worker mounts the
private repo at `/<shell>/fs/…` and proxies every file (deck HTML + its relative
assets) through the GitHub contents API using a PAT you enter at runtime. Deck
docs get React/Babel + the editor injected at fetch time, so **source stays
pristine** (round-trips to Claude Design). Saves are committed back to the private
repo by this page (the token never enters the deck iframe).

## No duplication — one source of truth

The editor and vendored React/Babel are **not copied here**. They live once in the
private repo at `_editor/` and are pulled through the service worker
(`/fs/_editor/…`) — the *same* files `serve.js` injects locally. Nothing to keep in
sync, and no node process needed online. The `parentSave` (commit-to-GitHub) code
added to `_editor/dc-editor.js` is inert locally (`window.parent === window`), so
the local `serve.js` disk-save workflow is unchanged.

This repo contains only: `index.html`, `app.js`, `sw.js`, `config.js`, `.nojekyll`.

## Setup

1. **Create a public repo** (e.g. `decks-shell`) and push these files to it.
2. **Enable GitHub Pages** on it: Settings → Pages → deploy from branch (root).
   `.nojekyll` is present so nothing is stripped.
3. **Edit `config.js`** so `owner`/`repo`/`branch` point at your private decks repo
   (defaults: `strikingwolf876/decks@main`). This is the only config — there is no
   settings UI.
4. **Create a fine-grained PAT** (github.com → Settings → Developer settings →
   Fine-grained tokens): *Resource owner* = you, *Repository access* = only the
   private `decks` repo, *Permissions* = **Contents: Read and write**. Nothing else.
5. Open the Pages URL, copy the PAT to your clipboard, click **🔑 Paste GitHub
   token**. (Clipboard blocked? It falls back to a paste prompt.)

The private `decks` repo must have `_editor/` **and** the decks **committed &
pushed** to the branch above — the SW reads the branch, not your working tree.
(Local `serve.js` uses the working tree, so local edits show instantly there.)

## Security

The PAT is a live repo-write credential held in this browser's `localStorage` and
the SW's memory. It is never committed and never written into served HTML. Anyone
visiting the public shell without a token sees nothing (every API call 401/404).
Keep the token **fine-grained, this-repo-only, Contents-only**. **Sign out** clears
the token, the SW memory, and the cache. XSS on this page could exfiltrate the
token — keep the shell's code minimal and dependency-free (it is).

## How it works

- `sw.js` — intercepts `/<shell>/fs/*`, resolves to a repo path, `GET
  /repos/:owner/:repo/contents/:path?ref=:branch` (raw media type, handles binary),
  returns it with the right content-type. For `*.dc.html` it injects vendor +
  editor unless `?raw=1` (the editor fetches `?raw=1` for pristine source). Caches
  everything cache-first; busts a path after a commit.
- `app.js` — stores PAT/config, registers the SW and hands it the token, lists
  decks via the git-trees API, opens a deck in an iframe under `/fs/…`, and — when
  the editor postMessages a save — commits via the contents API and tells the SW to
  bust that path.

## Rate limits

Authenticated GitHub API = 5000 req/hr. A cold deck load fetches the HTML + each
asset + editor/vendor once; the SW caches them, so repeat views cost ~0. Fine for
personal use.

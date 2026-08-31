# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Board Game Tracker is an offline-first PWA for logging board game plays, with an
optional Node server (typically run on a Raspberry Pi) for multi-profile storage
and manual cross-device sync. The client (`public/`) is plain HTML/CSS/JS with no
framework or bundler; `server.js` is a single-file, zero-dependency Node HTTP
server that both serves the static client and implements the JSON API. Local
data lives in IndexedDB (client) and flat JSON files under `data/` (server);
see README.md for the full data model, sync protocol, and API walkthrough.

## Commands

There is no package.json, build step, bundler, linter, or test suite — this is
intentional (see README: "zero-dependency"). Development is edit-and-reload.

- **Run the server:** `node server.js` (or `PORT=8080 node server.js` for a
  different port). Requires only Node core modules.
- **Run via Docker:** `docker compose up -d --build`; logs with
  `docker compose logs -f`; stop with `docker compose down`.
- **Client changes:** just edit files under `public/` and reload the browser —
  `server.js` serves them statically, no build step. To test the full app
  (server + client + sync), run `node server.js` and open
  `http://localhost:3131`.
- **No automated tests exist.** Verify changes by exercising the app in a
  browser (see the `run` skill) — check the golden path plus offline mode
  (DevTools → Network → Offline) and, for server-touching changes, an actual
  sync round-trip between two "devices" (e.g. two browser profiles).

## Conventions & Patterns

- **Plain script tags, load order matters.** Each HTML page loads its scripts
  via `<script src="...">` in a fixed order (see `index.html`); no modules, no
  bundler. Files share globals — e.g. `database.js` defines `getGames()`,
  `nav.js` calls `onSyncComplete()` if the current page defines it. When adding
  a new shared file, add it to every page's script list **and** to the
  `FILES` array in `service-worker.js` (see Pitfalls below).
- **All rendering is manual DOM/`innerHTML`**, not a templating engine. Always
  pass user-entered or stored text through `escapeHTML()` (in `database.js`)
  before interpolating into `innerHTML` — plain string concatenation into
  HTML is the injection vector to avoid here.
- **Records carry `id` (UUID via `uuid()`) and `updatedAt` (epoch ms).**
  `addGame`/`updateGame`/`addPlay`/`updatePlay` in `database.js` stamp
  `updatedAt` with `Date.now()` automatically — don't set it by hand. Records
  written verbatim from the server (`putGameRaw`/`putPlayRaw`, used by
  `sync.js`) deliberately skip that stamp because the server's timestamp is
  already authoritative. Sync is last-write-wins per record, compared by
  `updatedAt` (see `mergeRecords` in `server.js`).
- **Config vs. data:** small app config (server URL, active profile, last
  sync time) lives in `localStorage` (`profile.js`), separate from the actual
  game/play records in IndexedDB (`database.js`) — config needs to be
  readable synchronously before the DB is open.
- **UI is native browser primitives, deliberately.** Use `alert()`/`confirm()`
  for errors and confirmations, and hand-rolled `.modal-overlay` DOM elements
  (pattern in `game-editor.js`, `image-picker.js`, `date-picker.js` — build
  the overlay, resolve a Promise on save/cancel, remove the overlay) for
  anything more complex. Don't introduce a UI framework, toast library, or
  custom dialog system in their place.
- **Indentation:** 4 spaces in JS, tabs in `style.css` — matches each file's
  existing convention; there's no formatter enforcing this.
- **Sorting user-visible tags/strings** uses
  `.localeCompare(b, undefined, { sensitivity: "base" })` consistently across
  `app.js`, `game.js`, and `game-editor.js` — match this when adding a new
  place that lists tags, so ordering doesn't diverge between views (see
  Pitfalls).

## Known Pitfalls / Recurring Errors

- **Forgetting to bump `CACHE_NAME` in `service-worker.js`.** The service
  worker caches every file in `public/` for offline use, keyed by
  `CACHE_NAME` (currently `"boardgame-v8"`). Any change to a cached file (or
  adding a new one to `FILES`) needs `CACHE_NAME` bumped, or returning users
  keep getting stale cached files until the browser happens to notice.
- **Tag/list sort order drifting between files.** The tag filter dropdown
  (`app.js`), game card badges (`app.js`, `game.js`), and the tag editor
  (`game-editor.js`) each render sorted tag lists independently. A past fix
  had to re-sync these to the same comparator after one was changed without
  updating the others — when touching tag/list sorting, grep for
  `localeCompare` across `public/` and update all call sites together.

## Docs Index

No `docs/` directory exists yet — README.md covers setup, the API, the data
model, and sync behavior/limitations in full.

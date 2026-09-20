// Single source of truth for the app's version — shown in Settings and used to name
// the service worker's cache (service-worker.js loads this via importScripts, so a
// version bump here bumps CACHE_NAME too — see the Known Pitfalls note in CLAUDE.md).
// Format is 1.xx: bump xx for a normal change, move to 2.x only for a rework big
// enough to want a clean break. manifest.json's "version"/"version_name" fields can't
// import this (plain JSON), so keep those in sync with this value by hand.
const APP_VERSION = "1.21";

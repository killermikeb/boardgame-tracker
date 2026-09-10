const DB_NAME = "BoardGameTracker";
// v2: gameId index on plays. v3: local image cache store. v4: gamePrefs/boxes/
// storageLocations stores, for the shared-library migration (see server/README.md).
const DB_VERSION = 4;

let db;

function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            db = event.target.result;
            const tx = event.target.transaction;
            const oldVersion = event.oldVersion;

            const gamesStore = db.objectStoreNames.contains("games")
                ? tx.objectStore("games")
                : db.createObjectStore("games", { keyPath: "id" });

            const playsStore = db.objectStoreNames.contains("plays")
                ? tx.objectStore("plays")
                : db.createObjectStore("plays", { keyPath: "id" });

            if (!playsStore.indexNames.contains("gameId")) {
                playsStore.createIndex("gameId", "gameId", { unique: false });
            }

            if (!db.objectStoreNames.contains("images")) {
                // Local offline cache of remote/uploaded cover images, keyed by gameId.
                db.createObjectStore("images", { keyPath: "gameId" });
            }

            let gamePrefsStore;
            if (!db.objectStoreNames.contains("gamePrefs")) {
                // rating/favourite/archived, split out per profile. Only the active
                // profile's own prefs ever live here — see clearGamePrefs().
                gamePrefsStore = db.createObjectStore("gamePrefs", { keyPath: "gameId" });
            }

            let boxesStore;
            if (!db.objectStoreNames.contains("boxes")) {
                boxesStore = db.createObjectStore("boxes", { keyPath: "id" });
            } else {
                boxesStore = tx.objectStore("boxes");
            }
            if (!boxesStore.indexNames.contains("gameId")) {
                boxesStore.createIndex("gameId", "gameId", { unique: false });
            }
            if (!boxesStore.indexNames.contains("storageLocationId")) {
                boxesStore.createIndex("storageLocationId", "storageLocationId", { unique: false });
            }

            if (!db.objectStoreNames.contains("storageLocations")) {
                db.createObjectStore("storageLocations", { keyPath: "id" });
            }

            // Upgrading from a pre-v4 database: rating/favourite/archived used to live
            // directly on the game record. Carry any non-default values over into the
            // new gamePrefs store so nobody loses their ratings/favourites/archived
            // status before their next sync — mirrors the tag -> tags migration below.
            if (oldVersion < 4 && gamePrefsStore) {
                gamesStore.openCursor().onsuccess = event => {
                    const cursor = event.target.result;
                    if (!cursor) return;
                    const game = cursor.value;
                    if (game.rating || game.favourite || game.archived) {
                        gamePrefsStore.put({
                            gameId: game.id,
                            rating: game.rating || null,
                            favourite: Boolean(game.favourite),
                            archived: Boolean(game.archived),
                            updatedAt: game.updatedAt || Date.now()
                        });
                    }
                    cursor.continue();
                };
            }
        };

        request.onsuccess = event => {
            db = event.target.result;
            resolve();
        };

        request.onerror = event => {
            console.error("Failed to open database", event.target.error);
            reject(event.target.error);
        };
    });
}

// ---------- Games ----------

// Deleting a game/box/storage location writes a "tombstone" — the record's id plus
// `deleted: true` and a fresh `updatedAt`, replacing its other fields — instead of
// removing the row outright. A tombstone is just another version of the record as far
// as the last-write-wins sync merge is concerned (see mergeRecords in server.js), so it
// propagates to the server and every other device the same way an edit would, and wins
// over any stale non-deleted copy with an older updatedAt. Everyday reads (getGames,
// getBoxes, getStorageLocations, getBoxesForGame) filter tombstones out; sync.js uses
// the ...ForSync variants below, which include them, so deletions actually get pushed.
function isTombstone(record) {
    return Boolean(record.deleted);
}

function getGames() {
    return getGamesForSync().then(games => games.filter(g => !isTombstone(g)).map(migrateGameTags));
}

// Includes delete tombstones — used by sync.js so local deletions are pushed to the
// server instead of silently staying local.
function getGamesForSync() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("games", "readonly");
        const request = tx.objectStore("games").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Shared game fields plus this profile's own rating/favourite/archived, merged into
// the same flat shape the rest of the app already expects. Returns new objects —
// never mutates the underlying `games` records, so saving one back can't leak prefs
// fields into the shared game data.
async function getGamesWithPrefs() {
    const [games, prefs] = await Promise.all([getGames(), getGamePrefs()]);
    const byGameId = new Map(prefs.map(p => [p.gameId, p]));
    return games.map(game => {
        const pref = byGameId.get(game.id);
        return {
            ...game,
            rating: pref ? pref.rating : null,
            favourite: pref ? Boolean(pref.favourite) : false,
            archived: pref ? Boolean(pref.archived) : false
        };
    });
}

// Older versions of the app stored a single `tag` string per game. This upgrades
// that in memory to the new `tags` array on every read, without touching what's
// on disk — the record is only rewritten (dropping the old field) the next time
// the game is actually saved via addGame/updateGame.
function migrateGameTags(game) {
    if (!Array.isArray(game.tags)) {
        game.tags = game.tag ? [game.tag] : [];
    }
    return game;
}

// Local edits go through addGame/updateGame, which stamp updatedAt with the current
// time so the server can tell which copy of a record (local vs. server) is newer.
function addGame(game) {
    delete game.tag; // superseded by `tags` — drop it on every save, not just via the editor
    game.updatedAt = Date.now();
    return putGameRaw(game);
}

function updateGame(game) {
    delete game.tag; // superseded by `tags` — drop it on every save, not just via the editor
    game.updatedAt = Date.now();
    return putGameRaw(game);
}

// Writes a record exactly as given, without touching updatedAt. Used when writing
// records that already have a trustworthy timestamp — e.g. ones just received from
// the server during a sync or profile download.
function putGameRaw(game) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("games", "readwrite");
        tx.objectStore("games").put(game);
        tx.oncomplete = () => resolve(game);
        tx.onerror = () => reject(tx.error);
    });
}

// Tombstones a game (see isTombstone above) and hard-deletes all of its associated
// plays locally. Plays are per-profile and never shared, so there's no tombstone to
// propagate for them — this device's own play history for the game is just gone,
// same as before.
function deleteGame(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["games", "plays"], "readwrite");

        tx.objectStore("games").put({ id, deleted: true, updatedAt: Date.now() });

        const playsIndex = tx.objectStore("plays").index("gameId");
        const cursorRequest = playsIndex.openCursor(IDBKeyRange.only(id));
        cursorRequest.onsuccess = event => {
            const cursor = event.target.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------- Game prefs (per-profile rating/favourite/archived) ----------
// Games/boxes/storage-locations are shared across every profile, but a profile's
// opinion of a shared game — rating, favourite, archived — is theirs alone. Only the
// active profile's own prefs ever live in this store; switching profiles clears it
// (see clearGamePrefs) and syncs back down fresh, unlike games/boxes/storageLocations,
// which are identical for everyone and never need clearing.

function getGamePrefs() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("gamePrefs", "readonly");
        const request = tx.objectStore("gamePrefs").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getGamePref(gameId) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("gamePrefs", "readonly");
        const request = tx.objectStore("gamePrefs").get(gameId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

// Local edit path — stamps updatedAt with the current time, like addGame/addPlay.
function setGamePref(gameId, { rating = null, favourite = false, archived = false } = {}) {
    return putGamePrefRaw({ gameId, rating, favourite, archived, updatedAt: Date.now() });
}

// Writes a pref row exactly as given, without touching updatedAt — used when ingesting
// a profile's prefs from the server during sync.
function putGamePrefRaw(pref) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("gamePrefs", "readwrite");
        tx.objectStore("gamePrefs").put(pref);
        tx.oncomplete = () => resolve(pref);
        tx.onerror = () => reject(tx.error);
    });
}

function clearGamePrefs() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("gamePrefs", "readwrite");
        tx.objectStore("gamePrefs").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------- Storage boxes ----------
// A game's physical copy — the core box, plus any expansions — each with its own
// dimensions and an optional storage location. Shared across every profile.

function getBoxes() {
    return getBoxesForSync().then(boxes => boxes.filter(b => !isTombstone(b)));
}

// Includes delete tombstones — see getGamesForSync above.
function getBoxesForSync() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("boxes", "readonly");
        const request = tx.objectStore("boxes").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getBoxesForGame(gameId) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("boxes", "readonly");
        const index = tx.objectStore("boxes").index("gameId");
        const request = index.getAll(gameId);
        request.onsuccess = () => resolve(request.result.filter(b => !isTombstone(b)));
        request.onerror = () => reject(request.error);
    });
}

function addBox(box) {
    box.updatedAt = Date.now();
    return putBoxRaw(box);
}

function updateBox(box) {
    box.updatedAt = Date.now();
    return putBoxRaw(box);
}

function putBoxRaw(box) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("boxes", "readwrite");
        tx.objectStore("boxes").put(box);
        tx.oncomplete = () => resolve(box);
        tx.onerror = () => reject(tx.error);
    });
}

// Tombstones the box (see isTombstone above) rather than deleting the row outright, so
// the deletion propagates to the server and every other device on the next sync.
function deleteBox(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("boxes", "readwrite");
        tx.objectStore("boxes").put({ id, deleted: true, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------- Storage locations ----------

function getStorageLocations() {
    return getStorageLocationsForSync().then(locations => locations.filter(l => !isTombstone(l)));
}

// Includes delete tombstones — see getGamesForSync above.
function getStorageLocationsForSync() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("storageLocations", "readonly");
        const request = tx.objectStore("storageLocations").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function addStorageLocation(location) {
    location.updatedAt = Date.now();
    return putStorageLocationRaw(location);
}

function updateStorageLocation(location) {
    location.updatedAt = Date.now();
    return putStorageLocationRaw(location);
}

function putStorageLocationRaw(location) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("storageLocations", "readwrite");
        tx.objectStore("storageLocations").put(location);
        tx.oncomplete = () => resolve(location);
        tx.onerror = () => reject(tx.error);
    });
}

// Deleting a location doesn't delete the boxes stored there — a box without a location
// is still meaningful ("not yet placed"), so this is a soft cascade: every box pointing
// at this location gets unassigned rather than removed. The location itself is
// tombstoned (see isTombstone above) rather than deleted outright, so the deletion
// propagates to the server and every other device on the next sync.
function deleteStorageLocation(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["storageLocations", "boxes"], "readwrite");
        tx.objectStore("storageLocations").put({ id, deleted: true, updatedAt: Date.now() });

        const boxesIndex = tx.objectStore("boxes").index("storageLocationId");
        const cursorRequest = boxesIndex.openCursor(IDBKeyRange.only(id));
        cursorRequest.onsuccess = event => {
            const cursor = event.target.result;
            if (cursor) {
                const box = { ...cursor.value, storageLocationId: null, updatedAt: Date.now() };
                cursor.update(box);
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------- Plays ----------
// Each person records their own play sessions — plays are per-profile, not shared, so
// (like gamePrefs) only the active profile's own plays ever live here. Switching
// profiles clears this store (see clearPlays) and re-downloads fresh.

function getPlays() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("plays", "readonly");
        const request = tx.objectStore("plays").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// More efficient than getPlays() + filter when you only need one game's plays.
function getPlaysForGame(gameId) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("plays", "readonly");
        const index = tx.objectStore("plays").index("gameId");
        const request = index.getAll(gameId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function addPlay(play) {
    play.updatedAt = Date.now();
    return putPlayRaw(play);
}

function updatePlay(play) {
    play.updatedAt = Date.now();
    return putPlayRaw(play);
}

function putPlayRaw(play) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("plays", "readwrite");
        tx.objectStore("plays").put(play);
        tx.oncomplete = () => resolve(play);
        tx.onerror = () => reject(tx.error);
    });
}

function deletePlayFromDatabase(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("plays", "readwrite");
        tx.objectStore("plays").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function clearPlays() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("plays", "readwrite");
        tx.objectStore("plays").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------- Local image cache ----------
// A best-effort offline copy of each game's cover image, stored as a base64 data URL.
// Used as a fallback if the network image (local file or server URL) fails to load.

function setCachedImage(gameId, dataUrl) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("images", "readwrite");
        tx.objectStore("images").put({ gameId, dataUrl });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function getCachedImage(gameId) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("images", "readonly");
        const request = tx.objectStore("images").get(gameId);
        request.onsuccess = () => resolve(request.result ? request.result.dataUrl : null);
        request.onerror = () => reject(request.error);
    });
}

// Best-effort: downloads a remote image and stores it locally so the game still has
// a picture when offline. Silently does nothing on failure (e.g. CORS-blocked host) —
// this is a bonus cache, not a critical path.
async function cacheImageLocally(gameId, url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return;
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        await setCachedImage(gameId, dataUrl);
    } catch (err) {
        console.warn("Could not cache image locally for", gameId, err);
    }
}

// Used by <img onerror>: falls back to the local cache, then to the default artwork.
async function handleImageError(imgEl, gameId) {
    imgEl.onerror = null; // prevent any further error loops
    const cached = gameId ? await getCachedImage(gameId) : null;
    imgEl.src = cached || "images/default-game.jpg";
}

// ---------- Backup / restore (manual JSON export, independent of server sync) ----------

async function exportData() {
    const [games, plays, gamePrefs, boxes, storageLocations] = await Promise.all([
        getGames(),
        getPlays(),
        getGamePrefs(),
        getBoxes(),
        getStorageLocations()
    ]);
	plays.sort((a,b) => a.gameId.localeCompare(b.gameId));
    return JSON.stringify(
        { games, plays, gamePrefs, boxes, storageLocations, exportedAt: new Date().toISOString() },
        null,
        2
    );
}

function importData(json) {
    return new Promise((resolve, reject) => {
        let data;
        try {
            data = JSON.parse(json);
        } catch (err) {
            reject(new Error("That file isn't valid JSON."));
            return;
        }

        if (!Array.isArray(data.games) || !Array.isArray(data.plays)) {
            reject(new Error("That file doesn't look like a Board Game Tracker backup."));
            return;
        }

        // gamePrefs/boxes/storageLocations are newer additions — a backup made before
        // they existed simply won't have them, which is fine (default to empty).
        const gamePrefs = Array.isArray(data.gamePrefs) ? data.gamePrefs : [];
        const boxes = Array.isArray(data.boxes) ? data.boxes : [];
        const storageLocations = Array.isArray(data.storageLocations) ? data.storageLocations : [];

        const tx = db.transaction(
            ["games", "plays", "gamePrefs", "boxes", "storageLocations"],
            "readwrite"
        );

        data.games.forEach(game => tx.objectStore("games").put(game));
        data.plays.forEach(play => tx.objectStore("plays").put(play));
        gamePrefs.forEach(pref => tx.objectStore("gamePrefs").put(pref));
        boxes.forEach(box => tx.objectStore("boxes").put(box));
        storageLocations.forEach(loc => tx.objectStore("storageLocations").put(loc));

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ---------- Utilities ----------

function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback for older browsers without crypto.randomUUID
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

// Renders a box/storage-location's dimensions for display, in cm, always in the
// order width, depth, height — omitting whichever weren't measured. Returns "" if
// none were.
function formatDimensions(record) {
    const parts = [record.width, record.depth, record.height].filter(
        n => n !== null && n !== undefined && n !== ""
    );
    return parts.length ? `${parts.join(" × ")} cm` : "";
}

// Whether a box could physically fit inside a storage location, given their measured
// dimensions (all in cm). A box's width and depth can always swap (it can be turned
// sideways), but its height only swaps too when it ISN'T flagged mustBeFlat — a box
// that must be stored flat can't be stood up on end, so its height is fixed. Returns
// true if there's no location, or either side is missing a measurement — nothing to
// check in that case.
function boxFitsLocation(box, location) {
    if (!location) return true;

    const boxDims = [box.width, box.depth, box.height];
    const locDims = [location.width, location.depth, location.height];
    if (
        boxDims.some(n => n === null || n === undefined || n === "") ||
        locDims.some(n => n === null || n === undefined || n === "")
    ) {
        return true;
    }

    const [w, d, h] = boxDims;
    const orientations = box.mustBeFlat
        ? [
              [w, d, h],
              [d, w, h]
          ]
        : [
              [w, d, h],
              [d, w, h],
              [w, h, d],
              [h, w, d],
              [d, h, w],
              [h, d, w]
          ];

    return orientations.some(
        ([ow, od, oh]) => ow <= locDims[0] && od <= locDims[1] && oh <= locDims[2]
    );
}

// Prevents user-entered text (game names, descriptions, dates typed via prompt)
// from being interpreted as HTML when inserted via innerHTML.
function escapeHTML(value) {
    if (value === undefined || value === null) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

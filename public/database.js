const DB_NAME = "BoardGameTracker";
const DB_VERSION = 3; // v2: gameId index on plays. v3: local image cache store.

let db;

function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = event => {
            db = event.target.result;
            const tx = event.target.transaction;

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

function getGames() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("games", "readonly");
        const request = tx.objectStore("games").getAll();
        request.onsuccess = () => resolve(request.result.map(migrateGameTags));
        request.onerror = () => reject(request.error);
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
    game.updatedAt = Date.now();
    return putGameRaw(game);
}

function updateGame(game) {
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

// Deletes a game and all of its associated plays locally.
// Note: this does NOT propagate to the server on its own — deletions aren't part of
// the sync protocol in this version, so a deleted game/play can reappear after a sync
// if the server still has it. See server/README.md for details.
function deleteGame(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["games", "plays"], "readwrite");

        tx.objectStore("games").delete(id);

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

// ---------- Plays ----------

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
    const [games, plays] = await Promise.all([getGames(), getPlays()]);
	plays.sort((a,b) => a.gameId.localeCompare(b.gameId));
    return JSON.stringify(
        { games, plays, exportedAt: new Date().toISOString() },
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

        const tx = db.transaction(["games", "plays"], "readwrite");
        const gamesStore = tx.objectStore("games");
        const playsStore = tx.objectStore("plays");

        data.games.forEach(game => gamesStore.put(game));
        data.plays.forEach(play => playsStore.put(play));

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Wipes local games/plays/images. Used when switching profiles, since only one
// profile's data lives in local IndexedDB at a time.
function clearAllData() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["games", "plays", "images"], "readwrite");
        tx.objectStore("games").clear();
        tx.objectStore("plays").clear();
        tx.objectStore("images").clear();
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

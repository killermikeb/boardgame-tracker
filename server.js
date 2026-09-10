// Board Game Tracker server
// ---------------------------
// Zero external dependencies — just Node.js core modules. Run with:
//   node server.js
//
// Serves the app itself (from ./public) AND the API it talks to, so visiting
// this machine's address in a browser is all that's needed on the client side.
// See README.md for setup details and a walkthrough of the API.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { URL } = require("url");

const PORT = process.env.PORT || 3131;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const GAME_IMAGES_DIR = path.join(DATA_DIR, "game-images");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const GAMES_FILE = path.join(DATA_DIR, "games.json");
const PLAYS_FILE = path.join(DATA_DIR, "plays.json");
const GAME_PREFS_FILE = path.join(DATA_DIR, "game-prefs.json");
const STORAGE_LOCATIONS_FILE = path.join(DATA_DIR, "storage-locations.json");
const BOXES_FILE = path.join(DATA_DIR, "boxes.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(GAME_IMAGES_DIR, { recursive: true });
if (!fs.existsSync(PROFILES_FILE)) {
    fs.writeFileSync(PROFILES_FILE, "[]");
}
if (!fs.existsSync(GAMES_FILE)) {
    fs.writeFileSync(GAMES_FILE, "[]");
}
if (!fs.existsSync(PLAYS_FILE)) {
    fs.writeFileSync(PLAYS_FILE, "{}");
}
if (!fs.existsSync(GAME_PREFS_FILE)) {
    fs.writeFileSync(GAME_PREFS_FILE, "{}");
}
if (!fs.existsSync(STORAGE_LOCATIONS_FILE)) {
    fs.writeFileSync(STORAGE_LOCATIONS_FILE, "[]");
}
if (!fs.existsSync(BOXES_FILE)) {
    fs.writeFileSync(BOXES_FILE, "[]");
}

// ---------- Small storage helpers (flat JSON files — plenty for a home hobby server) ----------

function readJSON(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
        return fallback;
    }
}

function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getProfiles() {
    return readJSON(PROFILES_FILE, []);
}

function saveProfiles(profiles) {
    writeJSON(PROFILES_FILE, profiles);
}

function getGames() {
    return readJSON(GAMES_FILE, []);
}

function saveGames(games) {
    writeJSON(GAMES_FILE, games);
}

// plays.json is nested by profileId, like game-prefs.json — each person records their
// own play sessions, so they're not part of the shared library. {profileId: [play, ...]}
function getPlaysFile() {
    return readJSON(PLAYS_FILE, {});
}

function savePlaysFile(plays) {
    writeJSON(PLAYS_FILE, plays);
}

function playsForProfile(playsFile, profileId) {
    return playsFile[profileId] || [];
}

// Merges incoming plays into just this profile's own slice — never touches another
// profile's plays, same isolation guarantee as mergePrefs.
function mergePlays(playsFile, profileId, incoming) {
    return { ...playsFile, [profileId]: mergeRecords(playsFile[profileId] || [], incoming || []) };
}

function getStorageLocations() {
    return readJSON(STORAGE_LOCATIONS_FILE, []);
}

function saveStorageLocations(locations) {
    writeJSON(STORAGE_LOCATIONS_FILE, locations);
}

function getBoxes() {
    return readJSON(BOXES_FILE, []);
}

function saveBoxes(boxes) {
    writeJSON(BOXES_FILE, boxes);
}

// game-prefs.json is a nested object keyed gameId -> profileId, not a flat array like
// the other collections — rating/favourite/archived are one profile's private opinion
// of a shared game, so a sync request only ever carries (and may only ever overwrite)
// its own profileId's slice. This shape makes it structurally hard for one profile's
// sync to clobber another's prefs on the same game, which a flat union merge (keyed
// only by gameId) would risk.
function getGamePrefs() {
    return readJSON(GAME_PREFS_FILE, {});
}

function saveGamePrefs(prefs) {
    writeJSON(GAME_PREFS_FILE, prefs);
}

// Last-write-wins merge, keyed by record id, compared by updatedAt. A client-side
// delete is sent here as a tombstone record (`{ id, deleted: true, updatedAt }` — see
// database.js's deleteGame/deleteBox/deleteStorageLocation) rather than an omission, so
// it merges like any other edit: it wins over a stale non-deleted copy with an older
// updatedAt, and is included in what's sent back so every other device (and profile,
// for games/boxes/storage-locations, which are shared) also drops the record on its
// next sync. Tombstones are kept forever rather than garbage-collected — harmless
// (the client filters them out of what it displays) but something to be aware of if
// data/*.json size ever matters.
function mergeRecords(existing, incoming) {
    const byId = new Map();
    for (const record of existing) byId.set(record.id, record);
    for (const record of incoming) {
        const current = byId.get(record.id);
        if (!current || (record.updatedAt || 0) >= (current.updatedAt || 0)) {
            byId.set(record.id, record);
        }
    }
    return Array.from(byId.values());
}

// Last-write-wins merge of one profile's prefs slice into the shared game-prefs.json,
// keyed by gameId -> profileId -> {rating, favourite, archived, updatedAt}. Only ever
// touches entries under `profileId` — every other profile's slice for the same gameId
// is left untouched, unlike a flat mergeRecords union.
function mergePrefs(prefsFile, profileId, incoming) {
    const merged = { ...prefsFile };
    for (const [gameId, incomingPref] of Object.entries(incoming || {})) {
        const existingForGame = merged[gameId] || {};
        const existingPref = existingForGame[profileId];
        if (!existingPref || (incomingPref.updatedAt || 0) >= (existingPref.updatedAt || 0)) {
            merged[gameId] = { ...existingForGame, [profileId]: incomingPref };
        }
    }
    return merged;
}

// This profile's own slice across every game — {gameId: {rating, favourite, archived, updatedAt}}.
function prefsForProfile(prefsFile, profileId) {
    const slice = {};
    for (const [gameId, byProfile] of Object.entries(prefsFile)) {
        if (byProfile[profileId]) slice[gameId] = byProfile[profileId];
    }
    return slice;
}

// ---------- HTTP plumbing ----------

function sendJSON(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json);
}

function sendError(res, status, message) {
    sendJSON(res, status, { error: message });
}

function readBody(req, limitBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let chunks = [];
        let size = 0;
        req.on("data", chunk => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
};

function extFromContentType(contentType) {
    if (!contentType) return "jpg";
    if (contentType.includes("png")) return "png";
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("webp")) return "webp";
    return "jpg";
}

// Downloads bytes from a remote URL, following redirects. Used both for pasted image
// URLs and BoardGameGeek thumbnails/XML. Headers are overridable because BGG is picky
// about being hit with an obviously non-browser User-Agent (see fetchBggXml below).
function fetchUrlBytes(urlStr, options = {}) {
    const {
        redirectsLeft = 4,
        headers = { "User-Agent": "BoardGameTracker/1.0" },
        timeout = 10000
    } = options;

    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(urlStr);
        } catch (err) {
            reject(new Error("Invalid URL"));
            return;
        }

        const lib = parsed.protocol === "http:" ? http : https;
        const req = lib.get(urlStr, { headers, timeout }, res => {
            if (
                [301, 302, 303, 307, 308].includes(res.statusCode) &&
                res.headers.location &&
                redirectsLeft > 0
            ) {
                res.resume();
                const nextUrl = new URL(res.headers.location, urlStr).toString();
                fetchUrlBytes(nextUrl, { redirectsLeft: redirectsLeft - 1, headers, timeout }).then(
                    resolve,
                    reject
                );
                return;
            }

            if (res.statusCode !== 200) {
                reject(new Error(`Remote server returned HTTP ${res.statusCode}`));
                res.resume();
                return;
            }

            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () =>
                resolve({
                    buffer: Buffer.concat(chunks),
                    contentType: res.headers["content-type"] || "image/jpeg"
                })
            );
        });

        req.on("timeout", () => req.destroy(new Error("Timed out")));
        req.on("error", reject);
    });
}

async function fetchUrlText(urlStr, options) {
    const { buffer } = await fetchUrlBytes(urlStr, options);
    return buffer.toString("utf8");
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- BoardGameGeek XML API proxying ----------
// BGG only exposes an XML API (no JSON, no CORS from a browser), so the server does
// the fetching and hands back small JSON results. This uses lightweight regex-based
// extraction rather than a full XML parser, since the two endpoints we use have a
// simple, predictable shape — see README.md for caveats.

function unescapeXML(str) {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractSearchIds(xml) {
    const ids = [];
    const seen = new Set();
    const re = /<item\b[^>]*\bid="(\d+)"[^>]*>/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
        if (!seen.has(match[1])) {
            seen.add(match[1]);
            ids.push(match[1]);
        }
    }
    return ids;
}

function extractThingResults(xml) {
    const results = [];
    const blockRe = /<item\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = blockRe.exec(xml)) !== null) {
        const [, id, block] = match;

        const thumbMatch = /<thumbnail>([^<]*)<\/thumbnail>/.exec(block);
        const nameMatch = /<name\b[^>]*\btype="primary"[^>]*\bvalue="([^"]*)"/.exec(block);
        const yearMatch = /<yearpublished\b[^>]*\bvalue="([^"]*)"/.exec(block);

        results.push({
            id,
            name: nameMatch ? unescapeXML(nameMatch[1]) : "Unknown",
            year: yearMatch ? yearMatch[1] : null,
            thumbnail: thumbMatch ? unescapeXML(thumbMatch[1]) : null
        });
    }
    return results;
}

// BGG blocks requests that look like they're coming from a script/bot, so this uses
// browser-like headers, and retries a couple of times on rate-limit/server errors or
// on the "please try again" placeholder BGG sometimes returns while it prepares data.
const BGG_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "text/xml, application/xml, */*"
};

async function fetchBggXml(url, attempt = 1) {
    let text;
    try {
        text = await fetchUrlText(url, { headers: BGG_HEADERS, timeout: 12000 });
    } catch (err) {
        if (attempt < 3 && /HTTP (403|429|5\d\d)/.test(err.message)) {
            await sleep(800 * attempt);
            return fetchBggXml(url, attempt + 1);
        }
        throw err;
    }

    if (/please try again/i.test(text) && attempt < 3) {
        await sleep(800 * attempt);
        return fetchBggXml(url, attempt + 1);
    }

    return text;
}

async function searchBoardGameGeek(query) {
    const searchXml = await fetchBggXml(
        `https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(query)}&type=boardgame`
    );
    const ids = extractSearchIds(searchXml).slice(0, 8);
    if (ids.length === 0) return [];

    const thingXml = await fetchBggXml(
        `https://boardgamegeek.com/xmlapi2/thing?id=${ids.join(",")}&type=boardgame`
    );
    return extractThingResults(thingXml);
}

// ---------- Static file serving (the PWA client lives in ./public) ----------

function serveStatic(req, res, pathname) {
    let relativePath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));

    // Prevent ../.. escaping the public directory.
    if (!filePath.startsWith(PUBLIC_DIR)) {
        sendError(res, 403, "Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            sendError(res, 404, "Not found");
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(data);
    });
}

function serveGameImage(req, res, filename) {
    const filePath = path.normalize(path.join(GAME_IMAGES_DIR, filename));
    if (!filePath.startsWith(GAME_IMAGES_DIR)) {
        sendError(res, 403, "Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            sendError(res, 404, "Image not found");
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "image/jpeg" });
        res.end(data);
    });
}

// ---------- Route handlers ----------

async function handleGetProfiles(req, res) {
    sendJSON(res, 200, getProfiles());
}

async function handleCreateProfile(req, res) {
    const body = JSON.parse((await readBody(req)) || "{}");
    const name = (body.name || "").trim();
    if (!name) return sendError(res, 400, "A profile name is required");

    const profile = { id: crypto.randomUUID(), name, created: new Date().toISOString() };
    const profiles = getProfiles();
    profiles.push(profile);
    saveProfiles(profiles);

    sendJSON(res, 201, profile);
}

// Full download of the shared library (games/boxes/storage-locations — NOT plays, which
// are per-profile), used once when a device first selects a profile.
async function handleGetLibraryData(req, res) {
    sendJSON(res, 200, {
        games: getGames(),
        boxes: getBoxes(),
        storageLocations: getStorageLocations()
    });
}

// Shared-library sync: merges games/boxes/storage-locations, not profile-scoped.
async function handleLibrarySync(req, res) {
    const body = JSON.parse((await readBody(req)) || "{}");

    const merged = {
        games: mergeRecords(getGames(), body.games || []),
        boxes: mergeRecords(getBoxes(), body.boxes || []),
        storageLocations: mergeRecords(getStorageLocations(), body.storageLocations || [])
    };

    saveGames(merged.games);
    saveBoxes(merged.boxes);
    saveStorageLocations(merged.storageLocations);

    sendJSON(res, 200, merged);
}

// This profile's own rating/favourite/archived slice, and this profile's own plays —
// each person records their own play sessions, so plays live here rather than in the
// shared library.
async function handleGetProfileData(req, res, profileId) {
    const profiles = getProfiles();
    if (!profiles.some(p => p.id === profileId)) {
        return sendError(res, 404, "Profile not found");
    }
    sendJSON(res, 200, {
        prefs: prefsForProfile(getGamePrefs(), profileId),
        plays: playsForProfile(getPlaysFile(), profileId)
    });
}

// Prefs + plays sync for one profile: rating/favourite/archived keyed by gameId, plus
// this profile's own play history. Never touches another profile's prefs or plays —
// see mergePrefs/mergePlays.
async function handleSyncProfile(req, res, profileId) {
    const profiles = getProfiles();
    if (!profiles.some(p => p.id === profileId)) {
        return sendError(res, 404, "Profile not found");
    }

    const body = JSON.parse((await readBody(req)) || "{}");

    const mergedPrefs = mergePrefs(getGamePrefs(), profileId, body.prefs || {});
    saveGamePrefs(mergedPrefs);

    const mergedPlays = mergePlays(getPlaysFile(), profileId, body.plays || []);
    savePlaysFile(mergedPlays);

    sendJSON(res, 200, {
        prefs: prefsForProfile(mergedPrefs, profileId),
        plays: playsForProfile(mergedPlays, profileId)
    });
}

async function handleSaveImage(req, res, gameId) {
    const body = JSON.parse((await readBody(req)) || "{}");
    const { dataUrl, url } = body;

    let buffer, contentType;

    if (dataUrl) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
        if (!match) return sendError(res, 400, "Invalid data URL");
        contentType = match[1];
        buffer = Buffer.from(match[2], "base64");
    } else if (url) {
        try {
            ({ buffer, contentType } = await fetchUrlBytes(url));
        } catch (err) {
            return sendError(res, 502, `Couldn't download that image: ${err.message}`);
        }
    } else {
        return sendError(res, 400, "Provide either dataUrl or url");
    }

    const filename = `${gameId}.${extFromContentType(contentType)}`;
    fs.writeFileSync(path.join(GAME_IMAGES_DIR, filename), buffer);

    sendJSON(res, 200, { image: `/game-images/${filename}` });
}

async function handleBggSearch(req, res, query) {
    const q = query.get("q");
    if (!q) return sendError(res, 400, "q is required");

    try {
        const results = await searchBoardGameGeek(q);
        sendJSON(res, 200, results);
    } catch (err) {
        const hint = /HTTP 403/.test(err.message)
            ? " (BoardGameGeek may be temporarily blocking this server's IP — wait a bit and try again)"
            : "";
        sendError(res, 502, `BoardGameGeek lookup failed: ${err.message}${hint}`);
    }
}

// ---------- Router ----------

const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = parsedUrl;

    try {
        if (pathname === "/api/profiles" && req.method === "GET") {
            return await handleGetProfiles(req, res);
        }

        if (pathname === "/api/profiles" && req.method === "POST") {
            return await handleCreateProfile(req, res);
        }

        if (pathname === "/api/library/data" && req.method === "GET") {
            return await handleGetLibraryData(req, res);
        }

        if (pathname === "/api/library/sync" && req.method === "POST") {
            return await handleLibrarySync(req, res);
        }

        let match;

        if ((match = /^\/api\/profiles\/([^/]+)\/data$/.exec(pathname)) && req.method === "GET") {
            return await handleGetProfileData(req, res, match[1]);
        }

        if ((match = /^\/api\/profiles\/([^/]+)\/sync$/.exec(pathname)) && req.method === "POST") {
            return await handleSyncProfile(req, res, match[1]);
        }

        if ((match = /^\/api\/games\/([^/]+)\/image$/.exec(pathname)) && req.method === "POST") {
            return await handleSaveImage(req, res, match[1]);
        }

        if (pathname === "/api/bgg/search" && req.method === "GET") {
            return await handleBggSearch(req, res, parsedUrl.searchParams);
        }

        if ((match = /^\/game-images\/(.+)$/.exec(pathname)) && req.method === "GET") {
            return serveGameImage(req, res, match[1]);
        }

        if (pathname.startsWith("/api/")) {
            return sendError(res, 404, "Unknown API route");
        }

        // Anything else falls through to the static PWA client.
        return serveStatic(req, res, pathname);
    } catch (err) {
        console.error(err);
        sendError(res, 500, err.message || "Internal server error");
    }
});

server.listen(PORT, () => {
    console.log(`Board Game Tracker server running on port ${PORT}\n`);
    console.log("Open one of these on your phone/laptop (same network as this machine):");

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) {
                console.log(`  http://${iface.address}:${PORT}`);
            }
        }
    }
    console.log(`  http://localhost:${PORT}  (on this machine)`);
});

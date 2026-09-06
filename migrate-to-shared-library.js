// One-time migration: per-profile data silos -> shared library + per-profile prefs/plays.
// ------------------------------------------------------------------------------------
// Run by hand on the Pi, with the server stopped:
//   node migrate-to-shared-library.js            (dry run — prints a report, writes nothing)
//   node migrate-to-shared-library.js --apply     (writes the new shared files)
//
// Reads every data/profile-{id}.json (old shape: {games: [...], plays: [...]}, with
// rating/favourite/archived on each game) and builds the new data/games.json (shared),
// data/plays.json (per-profile — each person's own play sessions, kept separate rather
// than merged together), data/game-prefs.json (per-profile rating/favourite/archived),
// and data/boxes.json (a default "Core Box" for every game), relocating cover images out
// of their per-profile folders. Original profile-{id}.json files are renamed to .bak,
// never deleted, so a bad migration can always be undone by hand.
//
// Games with an exact-match name (trimmed, case-insensitive) across profiles are
// merged into a single shared record. This is a blunt heuristic — it can wrongly
// merge two different games that happen to share a name, and it won't catch near-
// duplicates (typos, diacritics). That's why this only ever runs with --apply after
// a human has read the dry-run report below.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const GAME_IMAGES_DIR = path.join(DATA_DIR, "game-images");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const GAMES_FILE = path.join(DATA_DIR, "games.json");
const PLAYS_FILE = path.join(DATA_DIR, "plays.json");
const GAME_PREFS_FILE = path.join(DATA_DIR, "game-prefs.json");
const STORAGE_LOCATIONS_FILE = path.join(DATA_DIR, "storage-locations.json");
const BOXES_FILE = path.join(DATA_DIR, "boxes.json");

const APPLY = process.argv.includes("--apply");

// Profiles whose data is intentionally excluded from migration (test/scratch data,
// not real collections). Their profile-{id}.json is still backed up like everyone
// else's, just never folded into the migrated games/plays/prefs.
const IGNORED_PROFILE_NAMES = ["TEST"];

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

// Same last-write-wins union merge as server.js's mergeRecords — duplicated here (server.js
// has no module.exports) as a belt-and-suspenders guard against duplicate ids within a
// single profile's own play list, which shouldn't happen with UUIDs but costs nothing
// to guard against.
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

function hasPrefs(game) {
    return Boolean(game.rating) || Boolean(game.favourite) || Boolean(game.archived);
}

function nameKey(name) {
    return (name || "").trim().toLowerCase();
}

function main() {
    if (!fs.existsSync(PROFILES_FILE)) {
        console.error(`No ${PROFILES_FILE} found — nothing to migrate.`);
        process.exit(1);
    }

    const profiles = readJSON(PROFILES_FILE, []);
    if (profiles.length === 0) {
        console.log("No profiles found — nothing to migrate.");
        return;
    }

    // Load every profile's games/plays, tagging each in-memory game with its source
    // profile so prefs/images can be traced back after clustering. Plays stay bucketed
    // by their owning profile — they were already per-profile before this migration and
    // remain so, just with gameId remapped through any duplicate-game merge below.
    const soloProfile = profiles.find(p => p.name === "SOLO");

    const allGames = []; // { ...game, sourceProfileId }
    const playsByProfile = new Map(); // profileId -> raw play records, gameId not yet remapped
    const missingFiles = [];
    const ignoredProfiles = [];

    for (const profile of profiles) {
        const file = path.join(DATA_DIR, `profile-${profile.id}.json`);
        if (!fs.existsSync(file)) {
            missingFiles.push(file);
            continue;
        }
        if (IGNORED_PROFILE_NAMES.includes(profile.name)) {
            ignoredProfiles.push(profile.name);
            continue;
        }
        const data = readJSON(file, { games: [], plays: [] });
        for (const game of data.games || []) {
            allGames.push({ ...game, sourceProfileId: profile.id });
        }
        playsByProfile.set(profile.id, data.plays || []);
    }

    if (missingFiles.length) {
        console.log(`Note: ${missingFiles.length} profile(s) had no data file (skipped):`);
        missingFiles.forEach(f => console.log(`  ${f}`));
    }
    if (ignoredProfiles.length) {
        console.log(`Note: ${ignoredProfiles.length} profile(s) excluded by name (data ignored): ${ignoredProfiles.join(", ")}`);
    }

    // Cluster games by exact (trimmed, case-insensitive) name match.
    const clusters = new Map(); // nameKey -> game[]
    for (const game of allGames) {
        const key = nameKey(game.name);
        if (!clusters.has(key)) clusters.set(key, []);
        clusters.get(key).push(game);
    }

    const oldGameIdToSurvivorId = new Map();
    const survivorGames = []; // final games.json entries (shared fields only)
    const report = []; // per-cluster summary lines
    let soloTaggedCount = 0;

    for (const [key, members] of clusters) {
        // Survivor = most-recently-updated member, matching the app's own LWW philosophy.
        const survivor = members.reduce((best, g) =>
            (g.updatedAt || 0) >= (best.updatedAt || 0) ? g : best
        );

        for (const member of members) {
            oldGameIdToSurvivorId.set(member.id, survivor.id);
        }

        const mergedTags = [];
        const seenTags = new Set();
        for (const member of members) {
            for (const tag of member.tags || []) {
                const tagKey = tag.trim().toLowerCase();
                if (!seenTags.has(tagKey)) {
                    seenTags.add(tagKey);
                    mergedTags.push(tag);
                }
            }
        }

        // Games that came from the "SOLO" profile get an explicit "SOLO" tag — the app
        // pre-filters that profile's games list to this tag (see app.js), so the tag
        // needs to exist on the shared game record, not just live implicitly in the
        // profile that owns it.
        if (soloProfile && members.some(g => g.sourceProfileId === soloProfile.id) && !seenTags.has("solo")) {
            seenTags.add("solo");
            mergedTags.push("SOLO");
            soloTaggedCount++;
        }

        const minCreated = members
            .map(g => g.created)
            .filter(Boolean)
            .sort()[0];

        const {
            rating, favourite, archived, sourceProfileId, ...sharedFields
        } = survivor;

        survivorGames.push({
            ...sharedFields,
            tags: mergedTags,
            created: minCreated || survivor.created,
            updatedAt: Date.now()
        });

        if (members.length > 1) {
            report.push({
                name: survivor.name,
                survivorId: survivor.id,
                contributingProfiles: [...new Set(members.map(g => g.sourceProfileId))],
                memberCount: members.length
            });
        }
    }

    // Remap each profile's own plays to their survivor gameId, then dedupe by id within
    // that profile — plays are NOT merged across profiles, since each person's play
    // history is their own.
    const playsFile = {}; // profileId -> play[]
    let totalPlays = 0;
    for (const [profileId, plays] of playsByProfile) {
        const remapped = plays.map(play => ({
            ...play,
            gameId: oldGameIdToSurvivorId.get(play.gameId) || play.gameId
        }));
        playsFile[profileId] = mergeRecords([], remapped);
        totalPlays += playsFile[profileId].length;
    }

    // Every game gets a default "Core Box" — none of the old per-profile data had any
    // concept of boxes, so this is the one entry every migrated game starts with.
    const boxes = survivorGames.map(game => ({
        id: crypto.randomUUID(),
        gameId: game.id,
        storageLocationId: null,
        label: "Core Box",
        width: null,
        depth: null,
        height: null,
        mustBeFlat: false,
        created: new Date().toISOString(),
        updatedAt: Date.now()
    }));

    // Build game-prefs.json: gameId -> profileId -> {rating, favourite, archived, updatedAt}.
    // Only games with a non-default rating/favourite/archived get an entry — matching the
    // "no row = defaults" convention the rest of the app uses for prefs. On a same-profile
    // collision within a cluster (rare — would mean one profile had two separate copies of
    // the same-named game), the higher-updatedAt copy's prefs win.
    const gamePrefs = {};
    for (const game of allGames) {
        if (!hasPrefs(game)) continue;
        const survivorId = oldGameIdToSurvivorId.get(game.id);
        const pref = {
            rating: game.rating || null,
            favourite: Boolean(game.favourite),
            archived: Boolean(game.archived),
            updatedAt: game.updatedAt || 0
        };
        if (!gamePrefs[survivorId]) gamePrefs[survivorId] = {};
        const existing = gamePrefs[survivorId][game.sourceProfileId];
        if (!existing || pref.updatedAt >= existing.updatedAt) {
            gamePrefs[survivorId][game.sourceProfileId] = pref;
        }
    }
    const prefsWritten = Object.values(gamePrefs).reduce(
        (sum, byProfile) => sum + Object.keys(byProfile).length,
        0
    );

    // Plan image relocations: data/game-images/{profileId}/{gameId}.{ext} -> data/game-images/{survivorId}.{ext}.
    // On a cluster with more than one candidate image, only the survivor's own image (if any) is kept.
    const imageMoves = [];
    for (const [key, members] of clusters) {
        const survivorId = oldGameIdToSurvivorId.get(members[0].id); // same for every member
        const survivor = members.find(g => g.id === survivorId);
        const srcDir = path.join(GAME_IMAGES_DIR, survivor.sourceProfileId);
        if (!fs.existsSync(srcDir)) continue;
        const match = fs.readdirSync(srcDir).find(f => f.startsWith(`${survivor.id}.`));
        if (!match) continue;
        const ext = path.extname(match);
        imageMoves.push({
            from: path.join(srcDir, match),
            to: path.join(GAME_IMAGES_DIR, `${survivorId}${ext}`)
        });
    }

    // ---------- Dry-run report (always printed) ----------

    console.log(`\n${APPLY ? "APPLYING" : "DRY RUN"} — shared-library migration\n${"=".repeat(60)}`);
    console.log(`Profiles: ${profiles.length}${ignoredProfiles.length ? ` (${ignoredProfiles.length} excluded: ${ignoredProfiles.join(", ")})` : ""}`);
    console.log(`Games read: ${allGames.length} -> ${survivorGames.length} after merging duplicates`);
    console.log(`Plays: ${totalPlays} (kept per-profile — not merged across profiles)`);
    console.log(`Prefs rows carried forward: ${prefsWritten}`);
    console.log(`Default "Core Box" entries to create: ${boxes.length}`);
    console.log(
        soloProfile
            ? `"SOLO" tag added to ${soloTaggedCount} game(s) contributed by the SOLO profile`
            : `No profile named "SOLO" found — no games tagged`
    );
    console.log(`Images to relocate: ${imageMoves.length}`);

    if (report.length) {
        console.log(`\nMerged duplicate-name clusters (${report.length}):`);
        for (const entry of report) {
            console.log(
                `  "${entry.name}" — ${entry.memberCount} copies across ${entry.contributingProfiles.length} profile(s) -> survivor ${entry.survivorId}`
            );
        }
    } else {
        console.log("\nNo duplicate-name clusters found.");
    }

    if (!APPLY) {
        console.log(
            "\nDry run only — nothing written. Review the clusters above, then re-run with --apply."
        );
        return;
    }

    // ---------- Apply ----------

    if (fs.existsSync(GAMES_FILE)) {
        console.error(
            `\nRefusing to apply: ${GAMES_FILE} already exists. This migration only runs once — ` +
                "delete or move it aside first if you really mean to re-run it."
        );
        process.exit(1);
    }

    for (const move of imageMoves) {
        fs.copyFileSync(move.from, move.to);
    }

    const backedUp = [];
    for (const profile of profiles) {
        const file = path.join(DATA_DIR, `profile-${profile.id}.json`);
        if (!fs.existsSync(file)) continue;
        const backup = `${file}.bak`;
        fs.renameSync(file, backup);
        backedUp.push(backup);
    }

    writeJSON(GAMES_FILE, survivorGames);
    writeJSON(PLAYS_FILE, playsFile);
    writeJSON(GAME_PREFS_FILE, gamePrefs);
    writeJSON(BOXES_FILE, boxes);
    if (!fs.existsSync(STORAGE_LOCATIONS_FILE)) writeJSON(STORAGE_LOCATIONS_FILE, []);

    console.log(`\nWrote ${GAMES_FILE}, ${PLAYS_FILE}, ${GAME_PREFS_FILE}, ${BOXES_FILE}.`);
    console.log(`Relocated ${imageMoves.length} image(s) to ${GAME_IMAGES_DIR}.`);
    console.log(`Backed up ${backedUp.length} profile data file(s):`);
    backedUp.forEach(f => console.log(`  ${f}`));
    console.log("\nDone. Restart the server and verify in the browser before deleting any .bak files.");
}

main();

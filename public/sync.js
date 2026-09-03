// Sync happens in two calls, matching the shared/per-profile split in the data model:
//   1. Library sync — games/boxes/storageLocations, shared by every profile, against
//      /api/library/sync.
//   2. Profile sync — this profile's own rating/favourite/archived AND this profile's
//      own play sessions (each person records their own), against
//      /api/profiles/:id/sync.
// Library goes first so any newly-learned shared games exist locally before plays/prefs
// referencing them are written. Both sides resolve conflicts "last write wins" using
// each record's updatedAt — see server/README.md.
async function syncNow() {
    const profile = getActiveProfile();
    if (!profile) throw new Error("No active profile.");

    const [games, boxes, storageLocations] = await Promise.all([
        getGames(),
        getBoxes(),
        getStorageLocations()
    ]);

    const library = await apiFetch("/api/library/sync", {
        method: "POST",
        body: JSON.stringify({ games, boxes, storageLocations })
    });
    await writeLibraryDataLocally(library.games, library.boxes, library.storageLocations);

    const [localPrefs, localPlays] = await Promise.all([getGamePrefs(), getPlays()]);
    const prefsByGameId = Object.fromEntries(localPrefs.map(pref => [pref.gameId, pref]));
    const { prefs, plays } = await apiFetch(`/api/profiles/${profile.id}/sync`, {
        method: "POST",
        body: JSON.stringify({ prefs: prefsByGameId, plays: localPlays })
    });
    await writeProfileDataLocally(prefs, plays);

    cacheMissingImages(library.games);

    return { games: library.games.length, plays: plays.length };
}
// TODO: sync local deletions to main server. Now that games/boxes/storage-locations are
// shared across every profile, this gap matters more than it used to — a delete on one
// device can be silently undone by the next sync if another device still has the
// record. See mergeRecords in server.js.

// Full downloads used when first selecting a profile in Settings — the shared library
// (same for every profile) plus this one profile's own prefs and plays.
async function downloadLibraryData() {
    const data = await apiFetch("/api/library/data");
    await writeLibraryDataLocally(data.games, data.boxes, data.storageLocations);
    return { games: data.games.length };
}

async function downloadProfileData(profileId) {
    const { prefs, plays } = await apiFetch(`/api/profiles/${profileId}/data`);
    await writeProfileDataLocally(prefs, plays);
    return { plays: plays.length };
}

// Writes server-provided shared-library records into IndexedDB as-is (their updatedAt
// timestamps are already trustworthy, so this uses the raw put helpers rather than
// addGame/updateGame, which would overwrite updatedAt with "now").
async function writeLibraryDataLocally(games, boxes, storageLocations) {
    for (const game of games) await putGameRaw(game);
    for (const box of boxes || []) await putBoxRaw(box);
    for (const location of storageLocations || []) await putStorageLocationRaw(location);
}

// Same raw-write reasoning as writeLibraryDataLocally, for this profile's own prefs and
// play sessions.
async function writeProfileDataLocally(prefsByGameId, plays) {
    for (const [gameId, pref] of Object.entries(prefsByGameId || {})) {
        await putGamePrefRaw({ gameId, ...pref });
    }
    for (const play of plays || []) await putPlayRaw(play);
}

// A game's `image` can point at this server (e.g. set from another device, or
// downloaded before this device ever cached it) or at some other remote host — a
// BoardGameGeek cover, or a pasted URL from before a server was ever configured. Either
// way, we're online right now — we just talked to the server — so this is the best
// chance to grab a local offline copy before that host becomes unreachable, such as
// when out and about. Fire-and-forget: cacheImageLocally() is already best-effort/
// silent, and this shouldn't hold up the sync itself.
function cacheMissingImages(games) {
    for (const game of games) {
        if (!/^https?:\/\//i.test(game.image || "")) continue; // skip data: URLs and local paths — no fetch needed
        getCachedImage(game.id).then(cached => {
            if (!cached) cacheImageLocally(game.id, game.image);
        });
    }
}

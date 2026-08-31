// Uploads local games/plays to the server and merges in whatever the server sends
// back (which may include records from other devices). The server resolves conflicts
// by "last write wins" using each record's updatedAt timestamp — see server/README.md.
async function syncNow() {
    const profile = getActiveProfile();
    if (!profile) throw new Error("No active profile.");

    const [games, plays] = await Promise.all([getGames(), getPlays()]);

    const merged = await apiFetch(`/api/profiles/${profile.id}/sync`, {
        method: "POST",
        body: JSON.stringify({ games, plays })
    });

    await writeServerRecordsLocally(merged.games, merged.plays);

    return { games: merged.games.length, plays: merged.plays.length };
}
// TODO: sync local deletions to main server

// Full download used when first selecting a profile in Settings.
async function downloadProfileData(profileId) {
    const data = await apiFetch(`/api/profiles/${profileId}/data`);
    await writeServerRecordsLocally(data.games, data.plays);
    return { games: data.games.length, plays: data.plays.length };
}

// Writes server-provided records into IndexedDB as-is (their updatedAt timestamps
// are already trustworthy, so this uses the raw put helpers rather than addGame/
// updateGame, which would overwrite updatedAt with "now").
async function writeServerRecordsLocally(games, plays) {
    for (const game of games) await putGameRaw(game);
    for (const play of plays) await putPlayRaw(play);
    cacheMissingServerImages(games);
}

// A game's `image` field can point at this server (e.g. set from another device, or
// downloaded before this device ever cached it). We're reachable right now — we just
// talked to the server — so this is the best chance to grab a local offline copy
// before the server (e.g. a home Raspberry Pi) becomes unreachable, such as when out
// and about. Fire-and-forget: cacheImageLocally() is already best-effort/silent, and
// this shouldn't hold up the sync itself.
function cacheMissingServerImages(games) {
    const serverUrl = getServerUrl();
    if (!serverUrl) return;

    for (const game of games) {
        if (!game.image || !game.image.startsWith(serverUrl)) continue;
        getCachedImage(game.id).then(cached => {
            if (!cached) cacheImageLocally(game.id, game.image);
        });
    }
}

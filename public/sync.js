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
}

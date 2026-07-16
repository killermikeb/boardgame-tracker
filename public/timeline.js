window.onload = async () => {
    await initDatabase();
    renderNav("timeline");
    await renderTimeline();
};

// Called by nav.js after a successful sync so the timeline reflects any new data.
function onSyncComplete() {
    renderTimeline();
}

function openGame(id) {
    window.location = `game.html?id=${id}`;
}

async function renderTimeline() {
    const container = document.getElementById("timeline");
    const [games, plays] = await Promise.all([getGames(), getPlays()]);
    const gamesById = new Map(games.map(g => [g.id, g]));

    // Group plays into "YYYY-MM" buckets, each holding a gameId -> play count map.
    // Archived games are intentionally still included here — this is a historical
    // record of what was played, independent of the main list's archived filter.
    const monthMap = new Map();

    plays.forEach(play => {
        const d = new Date(play.date);
        if (isNaN(d)) return; // skip anything with an unparsable date

        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!monthMap.has(key)) monthMap.set(key, new Map());

        const counts = monthMap.get(key);
        counts.set(play.gameId, (counts.get(play.gameId) || 0) + 1);
    });

    const monthKeys = Array.from(monthMap.keys()).sort().reverse(); // newest month first

    if (monthKeys.length === 0) {
        container.innerHTML = `<p class="empty-state">No plays logged yet.</p>`;
        return;
    }

    container.innerHTML = monthKeys
        .map(key => {
            const [year, month] = key.split("-").map(Number);
            const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, {
                month: "long",
                year: "numeric"
            });

            const entries = Array.from(monthMap.get(key).entries())
                .map(([gameId, count]) => ({ game: gamesById.get(gameId), count }))
                .filter(entry => entry.game) // guard against plays referencing a deleted game
                .sort((a, b) => b.count - a.count || a.game.name.localeCompare(b.game.name));

            const tiles = entries
                .map(
                    ({ game, count }) => `
                        <div class="timeline-tile" onclick="openGame('${game.id}')">
                            <img
                                src="${escapeHTML(game.image || 'images/default-game.jpg')}"
                                alt="${escapeHTML(game.name)}"
                                onerror="handleImageError(this, '${game.id}')"
                            >
                            <span class="timeline-count">${count}</span>
                        </div>
                    `
                )
                .join("");

            return `
                <section class="timeline-month">
                    <h2>${escapeHTML(monthLabel)}</h2>
                    <div class="timeline-grid">${tiles}</div>
                </section>
            `;
        })
        .join("");
}

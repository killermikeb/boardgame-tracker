let gamesContainer;

// Cached in memory so search/filter/sort can re-render instantly without re-hitting
// IndexedDB on every keystroke. Refreshed via loadGames() after any mutation.
let allGames = [];
let allPlays = [];
let searchQuery = "";
let showArchived = false;

window.onload = async () => {
    gamesContainer = document.getElementById("games");
    registerServiceWorker();
    await initDatabase();
    renderNav("home");
    await loadGames();
};

// Called by nav.js after a successful sync so the list reflects any new data.
function onSyncComplete() {
    loadGames();
}

function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker
            .register("service-worker.js")
            .catch(err => console.error("Service worker registration failed", err));
    }
}

async function loadGames() {
    allGames = await getGames();
    allPlays = await getPlays();
    renderGames();
}

function handleSearchInput() {
    searchQuery = document.getElementById("searchInput").value;
    renderGames();
}

function handleArchivedToggle() {
    showArchived = document.getElementById("showArchivedToggle").checked;
    renderGames();
}

function matchesSearch(game, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
        (game.name || "").toLowerCase().includes(q) ||
        (game.tag || "").toLowerCase().includes(q)
    );
}

function byFavouriteThenName(a, b) {
    const favA = a.favourite ? 1 : 0;
    const favB = b.favourite ? 1 : 0;
    if (favA !== favB) return favB - favA; // favourites first
    return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
}

function renderGames() {
    const visible = allGames
        .filter(game => (showArchived || !game.archived) && matchesSearch(game, searchQuery))
        .sort(byFavouriteThenName);

    gamesContainer.innerHTML = "";

    if (visible.length === 0) {
        gamesContainer.innerHTML = `<p class="empty-state">No games match.</p>`;
        return;
    }

    visible.forEach(game => {
        const div = document.createElement("div");
        div.className = "game-card" + (game.archived ? " archived" : "");

        div.innerHTML = `
            <div class="game-image" onclick="openGame('${game.id}')">
                <img
                    src="${escapeHTML(game.image || 'images/default-game.jpg')}"
                    alt="${escapeHTML(game.name)} box art"
                    onerror="handleImageError(this, '${game.id}')"
                >
            </div>

            <div class="game-info">

                <h3>${escapeHTML(game.name)}</h3>
                <div class="card-badges">
                    ${game.rating ? `<span class="badge badge-rating">${escapeHTML(game.rating)}</span>` : ""}
                    ${game.tag ? `<span class="badge badge-tag">${escapeHTML(game.tag)}</span>` : ""}
                    ${game.archived ? `<span class="badge badge-archived">Archived</span>` : ""}
                </div>

                <p>Total: ${countSessions(allPlays, game.id)}</p>
                <p>Last month: ${countLastMonth(allPlays, game.id)}</p>
                <p>This month: ${countThisMonth(allPlays, game.id)}</p>

				<div class="game-buttons">
					<button
						onclick="toggleFavourite('${game.id}')"
						aria-label="${game.favourite ? 'Remove from favourites' : 'Add to favourites'}"
					>${game.favourite ? "★" : "☆"}</button>
					<button onclick="recordPlay('${game.id}')">+</button>
				</div>

            </div>
        `;

        gamesContainer.appendChild(div);
    });
}

async function createGame() {
    const input = document.getElementById("gameName");
    const name = input.value.trim();

    if (!name) return;

    const game = {
        id: uuid(),
        name,
        image: "images/default-game.jpg",
        favourite: false,
        archived: false,
        created: new Date().toISOString()
    };

    await addGame(game);
    input.value = "";
    await loadGames();

    if (getServerUrl() && confirm(`Search BoardGameGeek for a cover image for "${name}"?`)) {
        const chosen = await openImagePicker(game.id, name, game.image);
        if (chosen) {
            game.image = chosen;
            await updateGame(game);
            loadGames();
        }
    }
}

async function recordPlay(gameId) {
    const added = await addPlayWithDatePicker(gameId);
    if (added) loadGames();
}

function countSessions(plays, gameId) {
    return plays.filter(p => p.gameId === gameId).length;
}

function countThisMonth(plays, gameId) {
    const now = new Date();

    return plays.filter(p => {
        const d = new Date(p.date);
        return (
            p.gameId === gameId &&
            d.getMonth() === now.getMonth() &&
            d.getFullYear() === now.getFullYear()
        );
    }).length;
}

function countLastMonth(plays, gameId) {
    const now = new Date();
    // Anchor on the 1st so this correctly rolls back across a year boundary
    // (e.g. in January, "last month" is December of the previous year).
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    return plays.filter(p => {
        const d = new Date(p.date);
        return (
            p.gameId === gameId &&
            d.getMonth() === lastMonth.getMonth() &&
            d.getFullYear() === lastMonth.getFullYear()
        );
    }).length;
}

async function toggleFavourite(id) {
    const games = await getGames();
    const game = games.find(g => g.id === id);
    if (!game) return;

    game.favourite = !game.favourite;
    await updateGame(game);
    loadGames();
}

function openGame(id) {
    window.location = `game.html?id=${id}`;
}

// ---------- Backup / restore (local JSON file, independent of server sync) ----------

async function handleExport() {
    const json = await exportData();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `boardgame-backup-${new Date().toISOString().split("T")[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
}

function handleImportFile(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
        try {
            await importData(reader.result);
            alert("Import complete.");
            loadGames();
        } catch (err) {
            alert("Import failed: " + err.message);
        }
    };
    reader.readAsText(file);

    input.value = ""; // allow re-importing the same filename later
}

let gamesContainer;

// Cached in memory so filtering can re-render instantly without re-hitting IndexedDB
// on every keystroke/change. Refreshed via loadGames() after any mutation.
let allGames = [];
let allPlays = [];

// Tags currently checked in the tag filter dropdown. A game must carry ALL of these
// to match (narrowing filter), not just any one of them.
let selectedTagFilters = [];

window.onload = async () => {
    gamesContainer = document.getElementById("games");
    registerServiceWorker();
    await initDatabase();
    renderNav("home");
    await loadGames();

    // Close the tag filter dropdown when clicking anywhere outside it.
    document.addEventListener("click", e => {
        const dropdown = document.getElementById("tagFilterDropdown");
        if (dropdown && !dropdown.contains(e.target)) {
            closeTagFilterMenu();
        }
    });
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

function typeLabel(type) {
    if (type === "coop") return "Co-op";
    if (type === "versus") return "Versus";
    return "";
}

async function loadGames() {
    allGames = await getGames();
    allPlays = await getPlays();
    populateTagFilterOptions();
    renderGames();
}

// The tag filter's options depend on what tags actually exist in the collection,
// so it's rebuilt whenever the underlying games change (not on every filter tweak).
function populateTagFilterOptions() {
    const menu = document.getElementById("tagFilterMenu");
    if (!menu) return;

    const tags = Array.from(new Set(allGames.flatMap(g => g.tags || []))).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
    );

    // Drop any previously-selected tags that no longer exist on any game.
    selectedTagFilters = selectedTagFilters.filter(t => tags.includes(t));

    if (tags.length === 0) {
        menu.innerHTML = `<p class="tag-filter-empty">No tags yet</p>`;
    } else {
        // Without line-break/indentation whitespace.
        menu.innerHTML = tags.map(
			tag =>
				`<label class="tag-filter-option">` +
				`<input type="checkbox" value="${escapeHTML(tag)}" ${selectedTagFilters.includes(tag) ? "checked" : ""} onchange="onTagFilterChange(this)">` +
				`<span>${escapeHTML(tag)}</span>` +
				`</label>`
		).join("");
    }

    updateTagFilterToggleLabel();
}

function onTagFilterChange(checkbox) {
    const tag = checkbox.value;
    if (checkbox.checked) {
        if (!selectedTagFilters.includes(tag)) selectedTagFilters.push(tag);
    } else {
        selectedTagFilters = selectedTagFilters.filter(t => t !== tag);
    }
    updateTagFilterToggleLabel();
    renderGames();
}

function updateTagFilterToggleLabel() {
    const toggle = document.getElementById("tagFilterToggle");
    if (!toggle) return;

    if (selectedTagFilters.length === 0) {
        toggle.textContent = "All tags ▾";
    } else if (selectedTagFilters.length === 1) {
        toggle.textContent = `${selectedTagFilters[0]} ▾`;
    } else {
        toggle.textContent = `${selectedTagFilters.length} tags ▾`;
    }
}

function toggleTagFilterMenu() {
    const menu = document.getElementById("tagFilterMenu");
    if (!menu) return;
    menu.hidden = !menu.hidden;
}

function closeTagFilterMenu() {
    const menu = document.getElementById("tagFilterMenu");
    if (menu) menu.hidden = true;
}

function clearFilters() {
    document.getElementById("searchInput").value = "";
    document.getElementById("filterType").value = "";
    document.getElementById("filterLength").value = "";
    document.getElementById("filterRating").value = "";
    document.getElementById("filterArchived").value = "active";
    document.getElementById("filterLastPlayed").value = "";
    selectedTagFilters = [];
    populateTagFilterOptions();
    renderGames();
}

function matchesSearch(game, query) {
    if (!query) return true;
    return (
        (game.name || "").toLowerCase().includes(query) ||
        (game.tags || []).some(t => t.toLowerCase().includes(query))
    );
}

// A game must carry every currently-checked tag to match (narrowing filter).
function matchesTags(game, selected) {
    if (selected.length === 0) return true;
    const gameTags = game.tags || [];
    return selected.every(t => gameTags.includes(t));
}

function matchesArchived(game, mode) {
    if (mode === "archived") return !!game.archived;
    if (mode === "all") return true;
    return !game.archived; // "active" (default)
}

// Whole calendar months between a game's most recent play and the current month
// (0 = played this month, 1 = played last month, etc). Null if never played.
function monthsSinceLastPlay(game, plays) {
    const gamePlays = plays.filter(p => p.gameId === game.id);
    if (gamePlays.length === 0) return null;

    const mostRecentDate = gamePlays.reduce((latest, p) => {
        const d = new Date(p.date);
        return d > latest ? d : latest;
    }, new Date(0));

    const now = new Date();
    const diff = (now.getFullYear() - mostRecentDate.getFullYear()) * 12 + (now.getMonth() - mostRecentDate.getMonth());
    return Math.max(0, diff);
}

function matchesLastPlayed(game, mode, plays) {
    if (!mode) return true;

    const monthsSince = monthsSinceLastPlay(game, plays);

    if (mode === "never") return monthsSince === null;
    if (mode === "ever") return monthsSince !== null;
    if (mode === "last-month") return monthsSince !== null && monthsSince <= 1;
    if (mode === "last-2-months") return monthsSince !== null && monthsSince <= 2;
    return true;
}

function byFavouriteThenName(a, b) {
    const favA = a.favourite ? 1 : 0;
    const favB = b.favourite ? 1 : 0;
    if (favA !== favB) return favB - favA; // favourites first
    return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
}

function renderGames() {
    const search = document.getElementById("searchInput").value.trim().toLowerCase();
    const typeFilter = document.getElementById("filterType").value;
    const lengthFilter = document.getElementById("filterLength").value;
    const ratingFilter = document.getElementById("filterRating").value;
    const archivedFilter = document.getElementById("filterArchived").value;
    const lastPlayedFilter = document.getElementById("filterLastPlayed").value;

    const visible = allGames
        .filter(game => matchesArchived(game, archivedFilter))
        .filter(game => matchesSearch(game, search))
        .filter(game => !typeFilter || game.type === typeFilter)
        .filter(game => !lengthFilter || String(game.length) === lengthFilter)
        .filter(game => !ratingFilter || game.rating === ratingFilter)
        .filter(game => matchesTags(game, selectedTagFilters))
        .filter(game => matchesLastPlayed(game, lastPlayedFilter, allPlays))
        .sort(byFavouriteThenName);

    updateFilterIndicator(visible);

    gamesContainer.innerHTML = "";

    if (visible.length === 0) {
        gamesContainer.innerHTML = `<p class="empty-state">No games match those filters.</p>`;
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
					${game.type ? `<span class="badge badge-type-${escapeHTML(game.type)}">${escapeHTML(typeLabel(game.type))}</span>` : ""}
					${game.length ? `<span class="badge badge-length-${escapeHTML(game.length)}">${escapeHTML(game.length)} min</span>` : ""}
                    ${game.rating ? `<span class="badge badge-rating-${escapeHTML(game.rating)}">${escapeHTML(game.rating)}</span>` : ""}
                    ${(game.tags || []).sort().map(tag => `<span class="badge badge-tag">${escapeHTML(tag)}</span>`).join("")}
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

// Shows the currently-filtered game count and total play sessions on the right side
// of the shared sync status bar (only present/populated on this page).
function updateFilterIndicator(visibleGames) {
    const indicator = document.getElementById("sync-filter-indicator");
    if (!indicator) return;

    const visibleIds = new Set(visibleGames.map(g => g.id));
    const totalPlays = allPlays.filter(p => visibleIds.has(p.gameId)).length;

    indicator.textContent = `${visibleGames.length} games · ${totalPlays} plays`;
}

async function createGame() {
    const blankGame = {
        id: uuid(),
        name: "",
        image: "images/default-game.jpg",
        favourite: false,
        archived: false,
        tags: [],
        created: new Date().toISOString()
    };

    const created = await openGameEditor(blankGame, { title: "Add Game" });
    if (!created) return null; // cancelled — nothing was saved

    await addGame(created);
    await loadGames();
    return created;
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

    const profile = getActiveProfile();
    const profileSlug = slugifyProfileName(profile ? profile.name : "local");

    const a = document.createElement("a");
    a.href = url;
    a.download = `boardgame-backup-${profileSlug}-${new Date().toISOString().split("T")[0]}.json`;
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

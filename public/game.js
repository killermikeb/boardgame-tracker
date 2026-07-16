let gameId;
let editMode = false;

window.onload = async () => {
    registerServiceWorker();
    await initDatabase();
    renderNav("home");

    const params = new URLSearchParams(window.location.search);
    gameId = params.get("id");

    loadGame();
};

// Called by nav.js after a successful sync so the detail view reflects any new data.
function onSyncComplete() {
    loadGame();
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

function toggleEditMode() {
    editMode = !editMode;
    loadGame();
}

async function loadGame() {
    const games = await getGames();
    const game = games.find(g => g.id === gameId);

    if (!game) {
        document.getElementById("game").innerHTML = `
            <p>That game couldn't be found.</p>
            <a href="index.html">Back to list</a>
        `;
        document.getElementById("history").innerHTML = "";
        return;
    }

    document.getElementById("game").innerHTML = `
        <div class="detail-header">
            <button class="master-edit-btn" onclick="toggleEditMode()">${editMode ? "Done" : "Edit"}</button>
        </div>

        <img
            class="detail-image"
            src="${escapeHTML(game.image || 'images/default-game.jpg')}"
            alt="${escapeHTML(game.name)} box art"
            onerror="handleImageError(this, '${game.id}')"
        >

        <h1>${escapeHTML(game.name)}</h1>

        ${game.archived ? `<p class="archived-banner">Archived — disposed of / thrown out</p>` : ""}

        <p>${escapeHTML(game.description || "")}</p>

        <div class="detail-badges">
            ${game.type ? `<span class="badge">${escapeHTML(typeLabel(game.type))}</span>` : ""}
            ${game.length ? `<span class="badge">${escapeHTML(game.length)} min</span>` : ""}
            ${game.rating ? `<span class="badge badge-rating">${escapeHTML(game.rating)}</span>` : ""}
            ${game.tag ? `<span class="badge badge-tag">${escapeHTML(game.tag)}</span>` : ""}
        </div>

        <div class="detail-actions">
            <button onclick="addPlayForGame()">Add Play</button>
            ${editMode ? `<button onclick="openEditor()">Edit</button>` : ""}
            ${editMode ? `<button onclick="removeGame()">Delete Game</button>` : ""}
        </div>

        <a href="index.html">Back to list</a>
    `;

    const plays = await getPlaysForGame(gameId);

    document.getElementById("history").innerHTML = plays
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map(
            play => `
                <div class="history-item">
                    ${escapeHTML(play.date)}
                    ${
                        editMode
                            ? `<span class="history-actions">
                                   <button onclick="editPlay('${play.id}')">Edit</button>
                                   <button onclick="deletePlay('${play.id}')">Delete</button>
                               </span>`
                            : ""
                    }
                </div>
            `
        )
        .join("");
}

async function addPlayForGame() {
    const added = await addPlayWithDatePicker(gameId);
    if (added) loadGame();
}

async function editPlay(id) {
    const plays = await getPlaysForGame(gameId);
    const play = plays.find(p => p.id === id);
    if (!play) return;

    const date = await openDatePicker("Change date", play.date);
    if (!date) return;

    play.date = date;
    await updatePlay(play);
    loadGame();
}

async function deletePlay(id) {
    if (!confirm("Delete this play?")) return;

    await deletePlayFromDatabase(id);
    loadGame();
}

async function openEditor() {
    const games = await getGames();
    const game = games.find(g => g.id === gameId);
    if (!game) return;

    const updated = await openGameEditor(game);
    if (!updated) return;

    await updateGame(updated);
    loadGame();
}

async function removeGame() {
    if (!confirm("Delete this game and all of its play history? This can't be undone.")) {
        return;
    }

    await deleteGame(gameId);
    window.location = "index.html";
}

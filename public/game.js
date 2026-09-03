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
    const games = await getGamesWithPrefs();
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

        <img
            class="detail-image"
            src="${escapeHTML(game.image || 'images/default-game.jpg')}"
            alt="${escapeHTML(game.name)} box art"
            onerror="handleImageError(this, '${game.id}')"
        >

        <h2>${escapeHTML(game.name)}</h2>

        ${game.archived ? `<p class="archived-banner">Archived — disposed of / thrown out</p>` : ""}

        <p>${escapeHTML(game.description || "")}</p>

        <div class="detail-badges">
            ${game.type ? `<span class="badge badge-type-${escapeHTML(game.type)}">${escapeHTML(typeLabel(game.type))}</span>` : ""}
            ${game.length ? `<span class="badge badge-length-${escapeHTML(game.length)}">${escapeHTML(game.length)} min</span>` : ""}
            ${game.rating ? `<span class="badge badge-rating-${escapeHTML(game.rating)}">${escapeHTML(game.rating)}</span>` : ""}
        </div>

        ${
            (game.tags || []).length
                ? `<div class="detail-tags">
                       <span class="detail-tags-label">Tags:</span>
                       ${game.tags
                           .slice()
                           .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
                           .map(tag => `<span class="badge badge-tag">${escapeHTML(tag)}</span>`)
                           .join("")}
                   </div>`
                : ""
        }

        <div class="detail-actions">
            <button onclick="addPlayForGame()">Add Play</button>
            <button onclick="openEditor()">Edit</button>
            ${editMode ? `<button onclick="removeGame()">Delete Game</button>` : ""}
        </div>

        <a href="index.html">Back to list</a>
    `;

    const plays = await getPlaysForGame(gameId);


    document.getElementById("master-edit").innerHTML = `
		<button class="master-edit-btn" onclick="toggleEditMode()">${editMode ? "Done" : "Edit"}</button>
	`

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

    renderBoxes();
}

async function renderBoxes() {
    let [boxes, storageLocations] = await Promise.all([
        getBoxesForGame(gameId),
        getStorageLocations()
    ]);

    // Every game should always have at least its Core Box — lazily create one for any
    // game that doesn't (e.g. migrated from before boxes existed).
    if (boxes.length === 0) {
        const coreBox = { id: uuid(), gameId, storageLocationId: null, label: "Core Box", mustBeFlat: false };
        await addBox(coreBox);
        boxes = [coreBox];
    }

    const locationsById = new Map(storageLocations.map(loc => [loc.id, loc]));

    document.getElementById("boxes").innerHTML = boxes
        .slice()
        .sort((a, b) => (a.label || "").localeCompare(b.label || "", undefined, { sensitivity: "base" }))
        .map(box => {
            const location = box.storageLocationId ? locationsById.get(box.storageLocationId) : null;
            const dims = formatDimensions(box);
            const fits = boxFitsLocation(box, location);
            return `
                <div class="history-item">
                    ${escapeHTML(box.label)}
                    ${dims ? ` — ${escapeHTML(dims)}` : ""}
                    · ${escapeHTML(location ? location.name : "Unassigned")}
                    ${box.mustBeFlat ? ` <span class="badge badge-tag">Must store flat</span>` : ""}
                    ${!fits ? ` <span class="badge badge-warning">Doesn't fit here</span>` : ""}
                    ${
                        editMode
                            ? `<span class="history-actions">
                                   <button onclick="handleEditBox('${box.id}')">Edit</button>
                                   <button onclick="handleDeleteBox('${box.id}')">Delete</button>
                               </span>`
                            : ""
                    }
                </div>
            `;
        })
        .join("") + (editMode ? `<button onclick="handleAddBox()">+ Add Box</button>` : "");
}

async function handleAddBox() {
    const storageLocations = await getStorageLocations();
    const result = await openBoxEditor(
        { label: "", storageLocationId: null, mustBeFlat: false },
        storageLocations,
        { title: "Add Box" }
    );
    if (!result) return;

    await addBox({ id: uuid(), gameId, ...result });
    renderBoxes();
}

async function handleEditBox(id) {
    const [boxes, storageLocations] = await Promise.all([
        getBoxesForGame(gameId),
        getStorageLocations()
    ]);
    const box = boxes.find(b => b.id === id);
    if (!box) return;

    const result = await openBoxEditor(box, storageLocations, { title: "Edit Box" });
    if (!result) return;

    await updateBox({ ...box, ...result });
    renderBoxes();
}

async function handleDeleteBox(id) {
    if (!confirm("Delete this box?")) return;
    await deleteBox(id);
    renderBoxes();
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
    const games = await getGamesWithPrefs();
    const game = games.find(g => g.id === gameId);
    if (!game) return;

    const result = await openGameEditor(game, { existingGames: games });
    if (!result) return;

    await updateGame(result.game);
    // Preserve favourite, which this editor never touches.
    const existingPref = (await getGamePref(result.game.id)) || {};
    await setGamePref(result.game.id, { ...existingPref, ...result.prefs });
    loadGame();
}

async function removeGame() {
    if (!confirm("Delete this game and all of its play history? This can't be undone.")) {
        return;
    }

    await deleteGame(gameId);
    window.location = "index.html";
}

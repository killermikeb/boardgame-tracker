window.onload = async () => {
    await initDatabase();
    renderNav("storage");
    await renderStorage();
};

// Called by nav.js after a successful sync so this reflects any new data.
function onSyncComplete() {
    renderStorage();
}

function openGame(id) {
    window.location = `game.html?id=${id}`;
}

// One box's row: a small game thumbnail + name (links to the game's detail page),
// plus the box's own label/dimensions/flags.
function renderBoxRow(box, game, location) {
    if (!game) {
        return `<div class="history-item">${escapeHTML(box.label)}<span class="modal-hint"> (game not found)</span></div>`;
    }

    const dims = formatDimensions(box);
    const fits = boxFitsLocation(box, location);

    return `
        <div class="history-item clickable" onclick="openGame('${game.id}')">
            <span class="storage-box-info">
                <img class="row-thumb" src="${escapeHTML(game.image || 'images/default-game.jpg')}"
                     alt="" onerror="this.src='images/default-game.jpg'">
                <strong>${escapeHTML(game.name)}</strong>
                <span class="modal-hint"> — ${escapeHTML(box.label)}${dims ? `, ${escapeHTML(dims)}` : ""}</span>
                ${box.mustBeFlat ? ` <span class="badge badge-tag">Flat</span>` : ""}
                ${!fits ? ` <span class="badge badge-warning">Doesn't fit here</span>` : ""}
            </span>
        </div>
    `;
}

async function renderStorage() {
    const container = document.getElementById("storage");
    const [locations, boxes, games] = await Promise.all([
        getStorageLocations(),
        getBoxes(),
        getGames()
    ]);
    const gamesById = new Map(games.map(g => [g.id, g]));
    const locationsById = new Map(locations.map(loc => [loc.id, loc]));

    if (locations.length === 0 && boxes.length === 0) {
        container.innerHTML = `
            <p class="empty-state">
                No storage locations or boxes yet. Add a storage location in
                <a href="settings.html">Settings</a>, then assign boxes to it from each
                game's page.
            </p>
        `;
        return;
    }

    const boxesByLocationId = new Map();
    const unassigned = [];
    for (const box of boxes) {
        if (box.storageLocationId && locationsById.has(box.storageLocationId)) {
            if (!boxesByLocationId.has(box.storageLocationId)) boxesByLocationId.set(box.storageLocationId, []);
            boxesByLocationId.get(box.storageLocationId).push(box);
        } else {
            unassigned.push(box);
        }
    }

    const byLabel = (a, b) => (a.label || "").localeCompare(b.label || "", undefined, { sensitivity: "base" });

    const locationBlocks = locations
        .slice()
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }))
        .map(location => {
            const locBoxes = (boxesByLocationId.get(location.id) || []).sort(byLabel);
            const dims = formatDimensions(location);
            return `
                <div class="storage-location-block">
                    <h2>${escapeHTML(location.name)}${dims ? ` <span class="modal-hint">— ${escapeHTML(dims)}</span>` : ""}</h2>
                    ${location.notes ? `<p class="modal-hint">${escapeHTML(location.notes)}</p>` : ""}
                    ${
                        locBoxes.length
                            ? locBoxes.map(box => renderBoxRow(box, gamesById.get(box.gameId), location)).join("")
                            : `<p class="modal-hint">No boxes stored here yet.</p>`
                    }
                </div>
            `;
        })
        .join("");

    const unassignedBlock = `
        <div class="storage-location-block">
            <h2>Unassigned</h2>
            ${
                unassigned.length
                    ? unassigned
                          .sort(byLabel)
                          .map(box => renderBoxRow(box, gamesById.get(box.gameId), null))
                          .join("")
                    : `<p class="modal-hint">Every box is assigned to a storage location.</p>`
            }
        </div>
    `;

    container.innerHTML = locationBlocks + unassignedBlock;
}

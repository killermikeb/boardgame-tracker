// Opens a modal for picking a game's cover image. Resolves with a new image URL/path
// to save on the game record, or null if the user cancelled (keep the existing image).
//
// However the image is chosen, if a server is configured this also asks the server to
// store a permanent copy (so it's available on other devices too) and best-effort
// caches it locally for offline use. If no server is configured, remote picks are used
// directly as-is and only local caching happens.
function openImagePicker(gameId, gameName, currentImage) {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal">
                <h2>Choose a cover image</h2>

                <img class="modal-preview" src="${escapeHTML(currentImage || 'images/default-game.jpg')}"
                     onerror="this.src='images/default-game.jpg'">

                <div class="modal-section">
                    <h3>Search BoardGameGeek</h3>
                    <div class="modal-row">
                        <input type="text" id="bgg-query" value="${escapeHTML(gameName || '')}" placeholder="Game name">
                        <button id="bgg-search-btn">Search</button>
                    </div>
                    <div id="bgg-results" class="bgg-results"></div>
                    <p id="bgg-status" class="modal-hint"></p>
                </div>

                <div class="modal-section">
                    <h3>Paste an image URL</h3>
                    <div class="modal-row">
                        <input type="text" id="image-url" placeholder="https://example.com/cover.jpg">
                        <button id="use-url-btn">Use URL</button>
                    </div>
                </div>

                <div class="modal-section">
                    <h3>Upload from this device</h3>
                    <input type="file" id="image-upload" accept="image/*">
                </div>

                <div class="modal-actions">
                    <button id="use-default-btn" class="secondary">Use default image</button>
                    <button id="cancel-btn" class="secondary">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = result => {
            overlay.remove();
            resolve(result);
        };

        overlay.addEventListener("click", e => {
            if (e.target === overlay) close(null);
        });

        overlay.querySelector("#cancel-btn").onclick = () => close(null);
        overlay.querySelector("#use-default-btn").onclick = () => close("images/default-game.jpg");

        overlay.querySelector("#bgg-search-btn").onclick = () =>
            runBggSearch(overlay, gameId, close);

        overlay.querySelector("#use-url-btn").onclick = async () => {
            const url = overlay.querySelector("#image-url").value.trim();
            if (!url) return;
            await pickRemoteImage(overlay, gameId, url, close);
        };

        overlay.querySelector("#image-upload").onchange = async e => {
            const file = e.target.files[0];
            if (!file) return;
            await pickUploadedImage(overlay, gameId, file, close);
        };

        // Auto-run a search immediately if we have a game name, to save a click.
        if (gameName) runBggSearch(overlay, gameId, close);
    });
}

async function runBggSearch(overlay, gameId, close) {
    const query = overlay.querySelector("#bgg-query").value.trim();
    const resultsEl = overlay.querySelector("#bgg-results");
    const statusEl = overlay.querySelector("#bgg-status");

    if (!query) return;

    if (!getServerUrl()) {
        statusEl.textContent = "Connect a server in Settings to search BoardGameGeek.";
        return;
    }

    statusEl.textContent = "Searching…";
    resultsEl.innerHTML = "";

    try {
        const results = await apiFetch(`/api/bgg/search?q=${encodeURIComponent(query)}`);

        if (results.length === 0) {
            statusEl.textContent = "No matches found on BoardGameGeek.";
            return;
        }

        statusEl.textContent = "";
        resultsEl.innerHTML = results
            .map(
                (r, i) => `
                    <button class="bgg-result" data-index="${i}">
                        <img src="${escapeHTML(r.thumbnail || 'images/default-game.jpg')}"
                             onerror="this.src='images/default-game.jpg'">
                        <span>${escapeHTML(r.name)}${r.year ? ` (${escapeHTML(r.year)})` : ""}</span>
                    </button>
                `
            )
            .join("");

        resultsEl.querySelectorAll(".bgg-result").forEach((btn, i) => {
            btn.onclick = () => pickRemoteImage(overlay, gameId, results[i].thumbnail, close);
        });
    } catch (err) {
        statusEl.textContent = `Search failed: ${err.message}`;
    }
}

// A remote URL was chosen (BGG result or pasted link). If a server is configured,
// ask it to download and store a permanent copy; otherwise use the URL directly.
async function pickRemoteImage(overlay, gameId, url, close) {
    const statusEl = overlay.querySelector("#bgg-status");

    if (!url) return;

    if (!getServerUrl()) {
        await cacheImageLocally(gameId, url);
        close(url);
        return;
    }

    if (statusEl) statusEl.textContent = "Saving image…";

    try {
        const result = await apiFetch(`/api/profiles/${getActiveProfile().id}/image`, {
            method: "POST",
            body: JSON.stringify({ gameId, url })
        });
        const fullUrl = getServerUrl() + result.image;
        await cacheImageLocally(gameId, fullUrl);
        close(fullUrl);
    } catch (err) {
        if (statusEl) statusEl.textContent = `Couldn't save that image: ${err.message}`;
    }
}

// A file was picked from disk. Reads it as base64; uploads to the server if one's
// configured, otherwise keeps it purely local (data URL stored directly on the game).
async function pickUploadedImage(overlay, gameId, file, close) {
    const statusEl = overlay.querySelector("#bgg-status");

    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    await setCachedImage(gameId, dataUrl);

    if (!getServerUrl()) {
        close(dataUrl);
        return;
    }

    if (statusEl) statusEl.textContent = "Uploading image…";

    try {
        const result = await apiFetch(`/api/profiles/${getActiveProfile().id}/image`, {
            method: "POST",
            body: JSON.stringify({ gameId, dataUrl })
        });
        close(getServerUrl() + result.image);
    } catch (err) {
        if (statusEl) statusEl.textContent = `Upload failed, using local copy only: ${err.message}`;
        // Still usable offline even though the server copy failed.
        setTimeout(() => close(dataUrl), 1500);
    }
}

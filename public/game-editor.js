// Modal form for editing a game's details, including the image. Resolves with the
// updated game object (not yet saved to the database — the caller is responsible for
// calling addGame()/updateGame() with it), or null if the user cancelled.
//
// opts.title lets callers relabel the modal (e.g. "Add Game" vs "Edit Game").
async function openGameEditor(game, opts = {}) {
    // Pulled in up front so the tag input can offer autocomplete suggestions from
    // tags already used elsewhere in the library.
    const existingGames = await getGames();
    const tagSuggestions = Array.from(
        new Set(existingGames.flatMap(g => g.tags || []))
    ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    return new Promise(resolve => {
        let currentImage = game.image || "images/default-game.jpg";
        let tags = Array.isArray(game.tags) ? [...game.tags] : (game.tag ? [game.tag] : []);

        const lengthOptions = [30, 60, 90, 120];
        const ratingOptions = ["S", "A", "B", "C", "D", "UP"];

        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal">
                <h2>${escapeHTML(opts.title || "Edit Game")}</h2>

                <img id="editor-image-preview" class="modal-preview"
                     src="${escapeHTML(currentImage)}" onerror="this.src='images/default-game.jpg'">
                <div class="modal-actions image-actions">
                    <button id="editor-change-image-btn" class="secondary">Change Image</button>
                </div>

                <label class="field-label">Name</label>
                <input type="text" id="editor-name" value="${escapeHTML(game.name || "")}">

                <label class="field-label">Description</label>
                <textarea id="editor-description" rows="3">${escapeHTML(game.description || "")}</textarea>

                <div class="field-row">
                    <div>
                        <label class="field-label">Type</label>
                        <select id="editor-type">
                            <option value="">—</option>
                            <option value="coop" ${game.type === "coop" ? "selected" : ""}>Co-op</option>
                            <option value="versus" ${game.type === "versus" ? "selected" : ""}>Versus</option>
                        </select>
                    </div>
                    <div>
                        <label class="field-label">Length</label>
                        <select id="editor-length">
                            <option value="">—</option>
                            ${lengthOptions
                                .map(
                                    m =>
                                        `<option value="${m}" ${String(game.length) === String(m) ? "selected" : ""}>${m} min</option>`
                                )
                                .join("")}
                        </select>
                    </div>
                </div>

                <div class="field-row">
                    <div>
                        <label class="field-label">Rating</label>
                        <select id="editor-rating">
                            <option value="">—</option>
                            ${ratingOptions
                                .map(r => `<option value="${r}" ${game.rating === r ? "selected" : ""}>${r}</option>`)
                                .join("")}
                        </select>
                    </div>
                    <div>
                        <label class="field-label">Tags</label>
                        <div class="tag-editor" id="editor-tags-editor">
                            <div class="tag-chips" id="editor-tag-chips"></div>
                            <input type="text" id="editor-tag-input" list="editor-tag-suggestions" placeholder="Add a tag…">
                        </div>
                        <datalist id="editor-tag-suggestions">
                            ${tagSuggestions.map(t => `<option value="${escapeHTML(t)}">`).join("")}
                        </datalist>
                    </div>
                </div>

                <label class="checkbox-row">
                    <input type="checkbox" id="editor-archived" ${game.archived ? "checked" : ""}>
                    Archived (disposed of / thrown out)
                </label>

                <div class="modal-actions">
                    <button id="editor-save-btn">Save</button>
                    <button id="editor-cancel-btn" class="secondary">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const chipsEl = overlay.querySelector("#editor-tag-chips");
        const tagInput = overlay.querySelector("#editor-tag-input");

        const renderTagChips = () => {
            chipsEl.innerHTML = tags
                .map(
                    (t, i) => `
                        <span class="tag-chip">
                            ${escapeHTML(t)}
                            <button type="button" class="tag-chip-remove" data-index="${i}" aria-label="Remove tag ${escapeHTML(t)}">×</button>
                        </span>
                    `
                )
                .join("");
        };

        const addTag = value => {
            const clean = value.trim();
            if (!clean) return;
            if (!tags.some(t => t.toLowerCase() === clean.toLowerCase())) {
                tags.push(clean);
                renderTagChips();
            }
            tagInput.value = "";
        };

        chipsEl.addEventListener("click", e => {
            const btn = e.target.closest(".tag-chip-remove");
            if (!btn) return;
            tags.splice(Number(btn.dataset.index), 1);
            renderTagChips();
        });

        tagInput.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag(tagInput.value);
            } else if (e.key === "Backspace" && !tagInput.value && tags.length) {
                // Backspace on an empty input pops the last chip, matching common
                // tag-input conventions (Gmail, etc).
                tags.pop();
                renderTagChips();
            }
        });

        // Catches a tag left typed-but-uncommitted if the user clicks away.
        tagInput.addEventListener("blur", () => addTag(tagInput.value));

        renderTagChips();

        const close = result => {
            overlay.remove();
            resolve(result);
        };

        overlay.addEventListener("click", e => {
            if (e.target === overlay) close(null);
        });

        overlay.querySelector("#editor-cancel-btn").onclick = () => close(null);

        overlay.querySelector("#editor-change-image-btn").onclick = async () => {
            const nameNow = overlay.querySelector("#editor-name").value.trim() || game.name;
            const chosen = await openImagePicker(game.id, nameNow, currentImage);
            if (chosen) {
                currentImage = chosen;
                overlay.querySelector("#editor-image-preview").src = chosen;
            }
        };

        overlay.querySelector("#editor-save-btn").onclick = () => {
            const name = overlay.querySelector("#editor-name").value.trim();
            if (!name) {
                alert("Name can't be empty.");
                return;
            }

            const length = overlay.querySelector("#editor-length").value;

            // Pick up anything still sitting uncommitted in the tag input.
            addTag(tagInput.value);

            const finalGame = {
                ...game,
                name,
                description: overlay.querySelector("#editor-description").value.trim(),
                type: overlay.querySelector("#editor-type").value || null,
                length: length ? Number(length) : null,
                rating: overlay.querySelector("#editor-rating").value || null,
                tags,
                archived: overlay.querySelector("#editor-archived").checked,
                image: currentImage
            };
            delete finalGame.tag; // superseded by `tags`

            close(finalGame);
        };
    });
}

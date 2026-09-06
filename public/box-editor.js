// Modal form for adding/editing one of a game's storage boxes (the core box, or an
// expansion's own box). Resolves with { label, width, depth, height,
// storageLocationId, mustBeFlat }, or null if the user cancelled.
async function openBoxEditor(box, storageLocations, opts = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal modal-small">
                <h2>${escapeHTML(opts.title || "Edit Box")}</h2>

                <label class="field-label">Label</label>
                <input type="text" id="box-editor-label" value="${escapeHTML(box.label || "")}">

                <p class="modal-hint">Dimensions in cm (optional):</p>
                <div class="dimensions-row">
                    <input type="number" id="box-editor-width" placeholder="Width (cm)" value="${box.width ?? ""}">
                    <input type="number" id="box-editor-depth" placeholder="Depth (cm)" value="${box.depth ?? ""}">
                    <input type="number" id="box-editor-height" placeholder="Height (cm)" value="${box.height ?? ""}">
                </div>

                <label class="field-label">Storage location</label>
                <select id="box-editor-location">
                    <option value="">— Unassigned —</option>
                    ${storageLocations
                        .map(
                            loc =>
                                `<option value="${loc.id}" ${box.storageLocationId === loc.id ? "selected" : ""}>${escapeHTML(loc.name)}</option>`
                        )
                        .join("")}
                </select>

                <label class="checkbox-row">
                    <input type="checkbox" id="box-editor-flat" ${box.mustBeFlat ? "checked" : ""}>
                    Must be stored flat (height cannot interchange)
                </label>

                <div class="modal-actions">
                    <button id="box-editor-save">Save</button>
                    <button id="box-editor-cancel" class="secondary">Cancel</button>
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

        overlay.querySelector("#box-editor-cancel").onclick = () => close(null);
        overlay.querySelector("#box-editor-save").onclick = () => {
            const label = overlay.querySelector("#box-editor-label").value.trim();
            if (!label) {
                alert("Label can't be empty.");
                return;
            }

            const width = overlay.querySelector("#box-editor-width").value;
            const depth = overlay.querySelector("#box-editor-depth").value;
            const height = overlay.querySelector("#box-editor-height").value;
            const storageLocationId = overlay.querySelector("#box-editor-location").value || null;
            const mustBeFlat = overlay.querySelector("#box-editor-flat").checked;

            const result = {
                label,
                width: width ? Number(width) : null,
                depth: depth ? Number(depth) : null,
                height: height ? Number(height) : null,
                storageLocationId,
                mustBeFlat
            };

            const location = storageLocations.find(loc => loc.id === storageLocationId);
            if (location && !boxFitsLocation(result, location)) {
                const proceed = confirm(
                    `This box's dimensions don't fit inside "${location.name}" based on what's on record. Save anyway?`
                );
                if (!proceed) return;
            }

            close(result);
        };

        overlay.querySelector("#box-editor-label").focus();
    });
}

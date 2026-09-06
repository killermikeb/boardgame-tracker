// Modal form for editing a storage location's name/notes/dimensions. Resolves with
// { name, notes, width, depth, height }, or null if the user cancelled.
async function openLocationEditor(location, opts = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal modal-small">
                <h2>${escapeHTML(opts.title || "Edit Storage Location")}</h2>

                <label class="field-label">Name</label>
                <input type="text" id="location-editor-name" value="${escapeHTML(location.name || "")}">

                <label class="field-label">Notes</label>
                <input type="text" id="location-editor-notes" value="${escapeHTML(location.notes || "")}">

                <p class="modal-hint">Dimensions in cm (optional):</p>
                <div class="dimensions-row">
                    <input type="number" id="location-editor-width" placeholder="Width (cm)" value="${location.width ?? ""}">
                    <input type="number" id="location-editor-depth" placeholder="Depth (cm)" value="${location.depth ?? ""}">
                    <input type="number" id="location-editor-height" placeholder="Height (cm)" value="${location.height ?? ""}">
                </div>

                <div class="modal-actions">
                    <button id="location-editor-save">Save</button>
                    <button id="location-editor-cancel" class="secondary">Cancel</button>
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

        overlay.querySelector("#location-editor-cancel").onclick = () => close(null);
        overlay.querySelector("#location-editor-save").onclick = () => {
            const name = overlay.querySelector("#location-editor-name").value.trim();
            if (!name) {
                alert("Name can't be empty.");
                return;
            }

            const notes = overlay.querySelector("#location-editor-notes").value.trim();
            const width = overlay.querySelector("#location-editor-width").value;
            const depth = overlay.querySelector("#location-editor-depth").value;
            const height = overlay.querySelector("#location-editor-height").value;

            close({
                name,
                notes,
                width: width ? Number(width) : null,
                depth: depth ? Number(depth) : null,
                height: height ? Number(height) : null
            });
        };

        overlay.querySelector("#location-editor-name").focus();
    });
}

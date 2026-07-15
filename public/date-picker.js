// Small modal wrapping a native <input type="date">. Resolves with "YYYY-MM-DD",
// or null if the user cancelled.
function openDatePicker(title, currentDate) {
    return new Promise(resolve => {
        const today = new Date().toISOString().split("T")[0];

        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal modal-small">
                <h2>${escapeHTML(title)}</h2>
                <input type="date" id="date-picker-input" value="${escapeHTML(currentDate || today)}">
                <div class="modal-actions">
                    <button id="date-picker-save">Save</button>
                    <button id="date-picker-cancel" class="secondary">Cancel</button>
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

        overlay.querySelector("#date-picker-cancel").onclick = () => close(null);
        overlay.querySelector("#date-picker-save").onclick = () => {
            const value = overlay.querySelector("#date-picker-input").value;
            close(value || null);
        };

        overlay.querySelector("#date-picker-input").focus();
    });
}

// Shared "log a play" flow used by both the game list and the game detail page.
// Returns true if a play was added, false if the user cancelled.
async function addPlayWithDatePicker(gameId) {
    const date = await openDatePicker("Log a play", new Date().toISOString().split("T")[0]);
    if (!date) return false;

    await addPlay({ id: uuid(), gameId, date });
    return true;
}

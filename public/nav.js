// Renders the shared header (Games / Settings links, active profile, sync button)
// into a `<div id="app-nav"></div>` placeholder present on every page.
function renderNav(activePage) {
    const nav = document.getElementById("app-nav");
    if (!nav) return;

    const profile = getActiveProfile();

    nav.innerHTML = `
        <div class="nav-bar">
            <div class="nav-links">
                <a href="index.html" class="${activePage === "home" ? "active" : ""}">Games</a>
                <a href="settings.html" class="${activePage === "settings" ? "active" : ""}">Settings</a>
            </div>
            <div class="nav-status">
                ${
                    profile
                        ? `<span class="profile-name">👤 ${escapeHTML(profile.name)}</span>
                           <button id="sync-btn" onclick="handleSyncClick()">⟳ Sync</button>`
                        : `<span class="profile-name">No profile — <a href="settings.html">set one up</a></span>`
                }
            </div>
        </div>
        ${
            profile
                ? `<div class="sync-status" id="sync-status">Last synced: ${roughlyAgo(getLastSync())}</div>`
                : ""
        }
    `;
}

async function handleSyncClick() {
    const btn = document.getElementById("sync-btn");
    const status = document.getElementById("sync-status");

    if (btn) {
        btn.disabled = true;
        btn.textContent = "Syncing…";
    }

    try {
        const result = await syncNow();
        setLastSync(new Date().toISOString());
        if (status) {
            status.textContent = `Synced just now — ${result.games} games, ${result.plays} plays`;
        }
        if (typeof onSyncComplete === "function") {
            onSyncComplete();
        }
    } catch (err) {
        if (status) status.textContent = `Sync failed: ${err.message}`;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "⟳ Sync";
        }
    }
}

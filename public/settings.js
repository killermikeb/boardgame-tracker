window.onload = async () => {
    await initDatabase();
    renderNav("settings");

    document.getElementById("server-url").value = getServerUrl();
    renderCurrentProfile();

    if (getServerUrl()) {
        loadProfiles();
    }
};

function renderCurrentProfile() {
    const profile = getActiveProfile();
    document.getElementById("current-profile").textContent = profile
        ? `Currently signed in as "${profile.name}".`
        : "No profile selected yet — pick or create one below.";
}

async function handleSaveServer() {
    const url = document.getElementById("server-url").value.trim();
    const statusEl = document.getElementById("server-status");

    if (!url) {
        statusEl.textContent = "Enter a server address first.";
        return;
    }

    setServerUrl(url);
    statusEl.textContent = "Checking connection…";

    try {
        await apiFetch("/api/profiles");
        statusEl.textContent = "Connected.";
        loadProfiles();
    } catch (err) {
        statusEl.textContent = `Couldn't connect: ${err.message}`;
    }
}

async function loadProfiles() {
    const listEl = document.getElementById("profile-list");
    listEl.innerHTML = "<p class=\"modal-hint\">Loading profiles…</p>";

    try {
        const profiles = await apiFetch("/api/profiles");
        const active = getActiveProfile();

        if (profiles.length === 0) {
            listEl.innerHTML = "<p class=\"modal-hint\">No profiles yet — create the first one below.</p>";
            return;
        }

        listEl.innerHTML = profiles
            .map(
                p => `
                    <div class="profile-row ${active && active.id === p.id ? "active" : ""}">
                        <span>${escapeHTML(p.name)}</span>
                        <button onclick="handleSelectProfile('${p.id}', '${escapeHTML(p.name).replace(/'/g, "\\'")}')">
                            ${active && active.id === p.id ? "Re-download" : "Use this profile"}
                        </button>
                    </div>
                `
            )
            .join("");
    } catch (err) {
        listEl.innerHTML = `<p class="modal-hint">Couldn't load profiles: ${escapeHTML(err.message)}</p>`;
    }
}

async function handleCreateProfile() {
    const input = document.getElementById("new-profile-name");
    const name = input.value.trim();
    if (!name) return;

    try {
        const profile = await apiFetch("/api/profiles", {
            method: "POST",
            body: JSON.stringify({ name })
        });
        input.value = "";
        await handleSelectProfile(profile.id, profile.name);
        loadProfiles();
    } catch (err) {
        alert(`Couldn't create profile: ${err.message}`);
    }
}

async function handleSelectProfile(id, name) {
    const switching = getActiveProfile() && getActiveProfile().id !== id;

    if (switching) {
        const confirmed = confirm(
            `Switch to "${name}"? Any local changes for the current profile that haven't been synced will stay on this device but won't be shown until you switch back.`
        );
        if (!confirmed) return;
    }

    try {
        await clearAllData();
        const result = await downloadProfileData(id);
        setActiveProfile(id, name);
        setLastSync(new Date().toISOString());
        renderNav("settings");
        renderCurrentProfile();
        loadProfiles();
        alert(`Signed in as "${name}" — downloaded ${result.games} games and ${result.plays} plays.`);
    } catch (err) {
        alert(`Couldn't switch profiles: ${err.message}`);
    }
}

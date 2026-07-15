// Small config values (which server to talk to, which profile is active) live in
// localStorage rather than IndexedDB — they're app configuration, not game data,
// and need to be readable synchronously before the database is even open.

const LS_SERVER_URL = "boardgame_server_url";
const LS_PROFILE_ID = "boardgame_profile_id";
const LS_PROFILE_NAME = "boardgame_profile_name";
const LS_LAST_SYNC = "boardgame_last_sync";

function getServerUrl() {
    return localStorage.getItem(LS_SERVER_URL) || "";
}

function setServerUrl(url) {
    localStorage.setItem(LS_SERVER_URL, url.trim().replace(/\/+$/, ""));
}

function getActiveProfile() {
    const id = localStorage.getItem(LS_PROFILE_ID);
    const name = localStorage.getItem(LS_PROFILE_NAME);
    return id ? { id, name } : null;
}

function setActiveProfile(id, name) {
    localStorage.setItem(LS_PROFILE_ID, id);
    localStorage.setItem(LS_PROFILE_NAME, name);
}

function clearActiveProfile() {
    localStorage.removeItem(LS_PROFILE_ID);
    localStorage.removeItem(LS_PROFILE_NAME);
}

function getLastSync() {
    return localStorage.getItem(LS_LAST_SYNC);
}

function setLastSync(iso) {
    localStorage.setItem(LS_LAST_SYNC, iso);
}

// Thin wrapper around fetch() that targets the configured server and turns
// non-2xx responses / network failures into readable Error messages.
async function apiFetch(path, options = {}) {
    const base = getServerUrl();
    if (!base) {
        throw new Error("No server is set up yet. Go to Settings to connect one.");
    }

    let res;
    try {
        res = await fetch(base + path, {
            headers: { "Content-Type": "application/json" },
            ...options
        });
    } catch (err) {
        throw new Error(`Couldn't reach the server at ${base}. Is it running?`);
    }

    if (!res.ok) {
        let message = `Server returned ${res.status}`;
        try {
            const body = await res.json();
            if (body && body.error) message = body.error;
        } catch (err) {
            // response wasn't JSON — fall back to the generic message above
        }
        throw new Error(message);
    }

    return res.json();
}

function roughlyAgo(iso) {
    if (!iso) return "never";
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}

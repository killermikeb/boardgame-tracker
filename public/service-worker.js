const CACHE_NAME = "boardgame-v5";

const FILES = [
    "./",
    "./index.html",
    "./game.html",
    "./settings.html",
    "./style.css",
    "./app.js",
    "./game.js",
    "./settings.js",
    "./database.js",
    "./profile.js",
    "./nav.js",
    "./sync.js",
    "./image-picker.js",
    "./date-picker.js",
    "./game-editor.js",
    "./manifest.json",
    "./images/default-game.jpg"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(FILES))
    );
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);

    // Never cache API calls or server-hosted game images — those need to hit the
    // network (they change often and may live on a different origin, the Pi server).
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/game-images/")) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then(response => {
            return response || fetch(event.request);
        })
    );
});

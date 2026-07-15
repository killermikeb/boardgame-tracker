# Board Game Tracker

A small offline-first PWA for tracking board game plays, with an optional
Raspberry Pi server for profiles and syncing across devices.

## Running with Docker Compose (on the Pi)

```
docker compose up -d --build
```

That builds the image (no `npm install` needed — it's zero-dependency) and
starts the container in the background, restarting automatically on reboot
or crash. Check it's healthy with `docker compose ps`, and view logs with
`docker compose logs -f`.

Game data lives in `./data` on the Pi (bind-mounted into the container), so
it survives container rebuilds/restarts — back that folder up like any other
files. To stop it: `docker compose down` (the `data/` folder is untouched).

If you'd rather not use Compose, `node server.js` directly (see above) works
identically — Docker is just a convenience for auto-restart and isolation.

## Running the server (on your Raspberry Pi)

Requirements: Node.js only (no `npm install` needed — the server uses only
Node's built-in modules).

```
node server.js
```

That's it. The server does two jobs at once:

1. **Serves the app itself** from `public/` — so you can just open
   `http://<your-pi's-address>:3131` in a browser on any device on your
   network and the app loads from there.
2. **Serves the API** the app talks to for profiles, syncing, and images.

On startup it prints the addresses to use, e.g.:

```
Open one of these on your phone/laptop (same network as this machine):
  http://192.168.1.42:3131
  http://localhost:3131  (on this machine)
```

To keep it running after you close the terminal, use something like `pm2`,
a `systemd` service, or just `tmux`/`screen`. To run on a different port:
`PORT=8080 node server.js`.

All data is stored as plain JSON files under `data/`, created automatically
on first run:
- `data/profiles.json` — the list of profiles
- `data/profile-<id>.json` — that profile's games and plays
- `data/game-images/<profileId>/` — uploaded/downloaded cover images

Back this folder up however you'd back up any files on the Pi (there's no
database to worry about).

## Using the app

- On first launch, go to **Settings** and enter your Pi's address (whatever
  the server printed on startup) and hit **Connect**.
- Create a profile (e.g. your name) or pick an existing one. This downloads
  that profile's games and plays onto the device.
- Use the app as normal — add games, log plays, edit details.
- Hit **Sync** (top right, next to your profile name) whenever you want to
  push local changes to the server and pull down anything added elsewhere.
  Syncing is manual on purpose, so it's predictable about when data moves.
- If you never set up a server, the app still works — everything just stays
  local to that device (IndexedDB), same as before.

### Images

When adding or editing a game, you can:
- **Search BoardGameGeek** — the server proxies BGG's public API and
  downloads a permanent copy of whichever cover you pick, storing it both on
  the server and (best-effort) locally for offline viewing.
- **Paste an image URL** — same idea, the server fetches and stores it.
- **Upload a file from your device.**
- **Use the default placeholder image** — this is also what new games start
  with automatically.

If no server is configured, picked images are still saved directly to the
device (as a local copy) but won't be shared to other devices until you
connect one.

## Game fields

Beyond name, description, and image, each game can have:
- **Type** — Co-op or Versus
- **Length** — 30 / 60 / 90 / 120 minutes
- **Rating** — S / A / B / C / D / UP
- **Tag** — a short freeform label, used by the search box on the main page
  (which matches against both name and tag)
- **Archived** — marks a game as disposed of / thrown out. Archived games are
  hidden from the main list by default; toggle "Show archived" in the
  filters bar to see them.

The main list is always sorted with favourites first, then alphabetically
by name.

## How syncing works (and its limits)

Sync is intentionally simple: each game/play record has an `updatedAt`
timestamp. When you sync, the server merges your local records with
whatever it already has, keeping whichever copy of each record is newer,
and sends the full merged result back.

Known limitations, so they don't surprise you:
- **Deletions don't sync.** Deleting a game or play locally only removes it
  from that device — if the server still has it, it'll come back on your
  next sync. Full delete-tracking (tombstones) would be a reasonable next
  step if this bites you.
- **Only one profile's data lives on a device at a time.** Switching
  profiles in Settings clears local data and re-downloads the selected
  profile's data.
- **BoardGameGeek search uses lightweight XML parsing**, not a full parser —
  it works for typical searches but is a bit more fragile than a proper XML
  library would be if BGG changes their response format.

## File layout

```
server.js            Run this on the Pi
public/               The client app (HTML/CSS/JS), served by server.js
  index.html          Game list
  game.html           Game detail + play history
  settings.html        Server & profile setup
  database.js          IndexedDB (local storage) layer
  profile.js            Server URL / active profile config
  sync.js                Push/pull logic
  image-picker.js         BGG search / URL / upload modal
  nav.js                   Shared header, sync button
  service-worker.js       Offline caching
data/                 Created automatically — profiles, games, plays, images
```

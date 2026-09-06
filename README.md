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
- `data/games.json`, `data/boxes.json`, `data/storage-locations.json` — the
  shared library: every profile sees the same games, boxes, and storage
  locations
- `data/game-prefs.json` — each profile's own rating/favourite/archived for
  each game
- `data/plays.json` — each profile's own play sessions. Play history is
  **not** shared — everyone records and sees only their own plays
- `data/game-images/` — uploaded/downloaded cover images, one per game

Back this folder up however you'd back up any files on the Pi (there's no
database to worry about).

**Upgrading from an older version?** Games/plays used to live in a separate
`data/profile-<id>.json` per profile, with rating/favourite/archived stored
directly on the game record. `migrate-to-shared-library.js` converts old data
to the new shape — see [Migrating old data](#migrating-old-data) below.

## Using the app

- On first launch, go to **Settings** and enter your Pi's address (whatever
  the server printed on startup) and hit **Connect**.
- Create a profile (e.g. your name) or pick an existing one. This downloads
  the shared library (games, boxes, storage locations — the same for
  everyone) plus your own ratings/favourites/archived status and your own
  play history.
- Use the app as normal — add games, log plays, edit details. Play sessions
  are personal: each profile records and sees only their own play history,
  even though the games themselves are shared.
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

When a BGG cover or pasted URL is swapped for a server-hosted copy, the
original URL is kept on the game record as `imageSource` for reference —
it's never used as a fallback if the server becomes unreachable. Every
device also opportunistically caches a local offline copy of each game's
image (whether server-hosted or not) the next time it syncs while
online, so images keep showing even if their original host later goes
down.

## Game fields

Beyond name, description, and image, each game can have:
- **Type** — Co-op or Versus
- **Length** — 30 / 60 / 90 / 120 minutes
- **Tag** — a short freeform label, used by the search box on the main page
  (which matches against both name and tag)

Every game is shared — everyone using the same server sees the same title,
description, image, type, length, and tags. **Rating, Favourite, and
Archived are per-profile**, though: your rating of a game is yours alone,
and doesn't affect what anyone else sees for that same shared game.
- **Rating** — S / A / B / C / D / UP
- **Archived** — marks a game as disposed of / thrown out, *from your
  perspective*. Archived games are hidden from your main list by default;
  toggle "Show archived" in the filters bar to see them. Another profile
  sharing the same library can still see it as active.

The main list is always sorted with your favourites first, then
alphabetically by name.

## Boxes and storage locations

Each game can have one or more **boxes** — a default "Core Box", plus a
separate box for each expansion — and each box can optionally be assigned to
a **storage location** (e.g. "Closet shelf", "Attic bin"). Both boxes and
storage locations can record dimensions in **cm**, always shown/entered in
the order **width, depth, height**. A box can also be flagged "must be
stored flat" — its height can't interchange with width/depth (i.e. it can't
be stood on end), though the box can still be turned sideways. When a box's
dimensions don't fit inside its assigned storage location's dimensions
(accounting for that rotation rule), it's flagged with a "Doesn't fit here"
warning — this is advisory only, not enforced.

Every game always has at least its Core Box — new games get one
automatically, and any older game without one gets it created the next time
its detail page loads.

Storage locations are managed from **Settings** (enable edit mode there to
add/edit/delete); boxes are managed from a game's detail page, under
"Boxes" (same pattern — enable edit mode to add/edit/delete). Both are
shared across every profile, like the rest of the library. The
**Storage** page gives an overview of every storage location and the boxes
in it (with a small game thumbnail and name for each), plus an "Unassigned"
group for boxes not yet placed anywhere.

## How syncing works (and its limits)

Sync is two calls, matching the shared/per-profile split in the data model:
1. **Library sync** — games, boxes, and storage locations, shared by every
   profile. Each record has an `updatedAt` timestamp; the server merges your
   local copies with whatever it already has, keeping whichever copy of each
   record is newer, and sends the full merged result back.
2. **Profile sync** — your own rating/favourite/archived AND your own play
   sessions, merged the same way but scoped to your profile only. Another
   profile syncing their own prefs or plays can never overwrite yours.

Known limitations, so they don't surprise you:
- **Deletions don't sync.** Deleting a game, box, or storage location
  locally only removes it from that device — if the server still has it,
  it'll come back on your next sync. Since the library is shared, this now
  affects everyone using the same server, not just one profile's private
  copy. Full delete-tracking (tombstones) would be a reasonable next step if
  this bites you.
- **Only your own prefs and plays live on a device at a time.** Switching
  profiles in Settings re-downloads your prefs and plays fresh; the shared
  library itself doesn't need re-downloading, since it's the same for every
  profile.
- **BoardGameGeek search uses lightweight XML parsing**, not a full parser —
  it works for typical searches but is a bit more fragile than a proper XML
  library would be if BGG changes their response format.

## Migrating old data

If `data/` still has the old `profile-<id>.json` layout (from before the
shared library), run the migration once, with the server stopped:

```
node migrate-to-shared-library.js          # dry run — prints a report, writes nothing
node migrate-to-shared-library.js --apply  # writes games.json, plays.json, game-prefs.json, boxes.json
```

Games with the exact same name across profiles are merged into one shared
entry (each profile keeps its own rating/favourite/archived for it) — review
the dry-run report before applying, since exact-name matching can occasionally
merge two different games that happen to share a title. Plays are **not**
merged across profiles — each profile's play history stays its own, just
with `gameId` updated to point at the merged game where applicable. Every
migrated game gets a default "Core Box". The original `profile-<id>.json`
files are renamed to `.bak`, never deleted, so you can always undo by hand.
Restart the server and check the app in a browser before removing any `.bak`
files.

Two profile names get special handling:
- A profile named **TEST** is excluded entirely — its games/plays/prefs are
  not migrated (its `profile-TEST.json` is still backed up like everyone
  else's, just never folded into the shared data).
- Any game contributed by a profile named **SOLO** gets an explicit `SOLO`
  tag added, since the app pre-filters that profile's games list to it (see
  below) — without the tag actually being on the shared game record, the
  filter would have nothing to match.

## The "SOLO" profile

A profile named exactly **SOLO** is treated as a special case: its Games
list starts pre-filtered to the `SOLO` tag (rather than showing everything),
since that profile is meant to track solo plays specifically. This is just
the *initial* filter on page load — clearing it (or picking different tags)
works normally for the rest of that session. For this to do anything useful,
games need an actual `SOLO` tag on them (added automatically for
SOLO-profile games by the migration script, or added by hand when creating/
editing a game).

## File layout

```
server.js                    Run this on the Pi
migrate-to-shared-library.js  One-time migration from the old per-profile layout
public/               The client app (HTML/CSS/JS), served by server.js
  index.html          Game list
  game.html           Game detail + boxes + play history
  settings.html        Server, profile, & storage location setup
  storage.html          Storage locations + the boxes in them
  database.js          IndexedDB (local storage) layer
  profile.js            Server URL / active profile config
  sync.js                Push/pull logic (library sync + profile sync)
  image-picker.js         BGG search / URL / upload modal
  box-editor.js            Add/edit a game's box modal
  location-editor.js        Edit a storage location modal
  nav.js                   Shared header, sync button
  service-worker.js       Offline caching
data/                 Created automatically — profiles, shared library, per-profile
                      prefs & plays, images
```

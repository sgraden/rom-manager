# ROM Manager

A local web app for curating a ROM library: drop a file in, it detects the console, converts
disc images to space-efficient CHD/RVZ, and files the result into the right per-system folder
on a destination (an SD card, an external drive, wherever). Built for personal use on macOS.

Full design/architecture is in [PLAN.md](PLAN.md). This README covers install and day-to-day use.

**Status:** Phase 4 of 5 — the app is fully functional end to end. Drop or path-in files, review
the detected system/action/destination, hit **Process**, and it actually converts (via `chdman`/
`7zz`/DolphinTool) and writes into the right folder on your destination, atomically, with live
progress in the Queue tab. Only Phase 5 (hashing + optional DAT-based renaming) remains, and it's
inert-by-default even once built — v1 is otherwise complete. A visual/layout pass (spacing,
button sizing, CTA visibility) is planned as the next piece of work — current styling is
functional but rough in a few spots (see the Review table on narrow windows).

---

## Prerequisites

- **macOS**, any recent version.
- **[Homebrew](https://brew.sh)**.
- **Node.js 20+**. Check with `node -v`; install via `brew install node` or [nvm](https://github.com/nvm-sh/nvm) if needed.
- **Conversion tools**, installed via Homebrew:

  ```bash
  brew install rom-tools sevenzip
  ```

  - `rom-tools` provides **`chdman`** — required. Creates and verifies `.chd` files for every
    disc-based system (PS1, PS2, Saturn, Sega CD, Dreamcast, PC Engine CD, 3DO, …).
  - `sevenzip` provides **`7zz`** — required. Lists and extracts cartridge ROM archives
    (`.zip`, `.7z`) and re-zips converted output.

- **Optional:**
  - **DolphinTool**, for GameCube/Wii → RVZ conversion. Install with `brew install --cask dolphin`
    (it's bundled inside the Dolphin emulator app). Without it, GameCube/Wii images are copied
    as-is, uncompressed — everything else still works.
  - **maxcso**, for PSP → CSO/ZSO conversion. **Not available via Homebrew.** Without it, PSP
    discs are converted to CHD instead, which PPSSPP reads natively — so most people don't need
    this at all. Build from source from
    [unknownbrackets/maxcso](https://github.com/unknownbrackets/maxcso) only if you specifically
    want ZSO output.

The app detects all four of these itself at startup and in the Settings screen — you don't need
to configure paths by hand. It checks `PATH` first, then falls back to the standard Homebrew
install locations for both Apple Silicon (`/opt/homebrew/bin`) and Intel/Rosetta
(`/usr/local/bin`) Macs, so a normal `brew install` is enough regardless of which Mac you're on.
If a tool still isn't found, Settings shows the exact `brew` command to fix it.

---

## Install

```bash
git clone <this-repo-url> rom-manager
cd rom-manager
npm install
```

That's it — no build step is required to get started, and nothing outside `node_modules` and a
few auto-generated local files (see [What gets created locally](#what-gets-created-locally)) is
touched. Cloning this repo onto a different Mac and running `npm install` again is the entire
migration story.

## Running it

**Day-to-day (recommended):**

```bash
npm run dev
```

This starts the API server and the web UI together and opens the UI at
**http://localhost:5173**. Both auto-reload on file changes.

**A more permanent local run** (no file-watching overhead, one process):

```bash
npm run build
npm start
```

Then open **http://localhost:3001**. Re-run `npm run build` after pulling changes.

To use a different port, either edit `"port"` in `config/config.json`, or set
`ROM_MANAGER_PORT` when starting:

```bash
ROM_MANAGER_PORT=4000 npm start
```

(Not `PORT` — that name is reserved by some dev tooling for a different purpose and is
deliberately ignored here.)

---

## What gets created locally

On first run the app creates a few files and folders that are **not** part of the git repo
(they're in `.gitignore`) because they're specific to your machine:

| Path | Purpose |
|---|---|
| `config/config.json` | Your settings — destination folder mappings, tool path overrides, per-system action overrides. Generated from `config/config.example.json` on first run. |
| `config/dats/` | Drop No-Intro/Redump `.dat` files here to enable exact-name matching later (see [Roadmap](#roadmap)). Empty is fine — the app works fully without any. |
| `data/library.json` | Reserved for Phase 5 (library hashing) — not written yet. |
| `staging/` | Temporary holding area for uploads while they're being processed. |

None of this needs to be backed up to get the app working on a new machine — it all regenerates.
If you *do* want to carry your settings or library history to a new machine, copy those files
over manually; they're plain JSON.

---

## Destinations

The Settings screen lists every volume mounted under `/Volumes` (so any SD card, USB drive, or
external disk shows up automatically the moment macOS mounts it) plus any extra paths you add to
`additionalTargetPaths` in `config/config.json`. For each one it shows free/total space,
filesystem type, and whether it found a `roms/` subfolder to use as the root.

exFAT-formatted cards (the usual choice for handhelds) are fully supported — the app knows about
exFAT's filename restrictions, and every write goes to a `.part` file next to the destination and
is renamed into place only on success, so a card removed mid-transfer never ends up with a
half-written ROM that looks complete. A file already present at the destination is never
overwritten — the job fails with a clear error instead.

**Folder mapping:** each system needs a folder on the destination to file into. The app
auto-matches folders by name against a built-in alias list (e.g. a folder named `ps1`, `psx`, or
`playstation` all resolve to PlayStation) the first time it sees a destination, and remembers the
result in `config/config.json` from then on. If nothing matches — or the auto-match picked the
"wrong" one of two plausible folders (e.g. your card has both `nes` and `famicom`) — fix it in
**Settings → Folder mapping**, which shows every system next to a dropdown of that destination's
actual folders. If the folder genuinely doesn't exist yet (e.g. no `ps2` folder on a card that's
never had a PS2 game on it), both Settings and the Review tab (right where the "no folder mapped"
warning shows up) offer a **Create folder** action — the one place the app is allowed to create a
directory. It defaults to the system's canonical folder name (the convention used by
ES-DE/Batocera-derived frontends most handhelds ship with — `ps2`, `snes`, `gba`, etc.) but the
name is editable before creating.

---

## Using the app

1. **Drop tab** — pick a destination, then add files either by dragging them in (streamed
   straight to `staging/`, never buffered in memory — safe for huge disc images), or via
   "Add by path" / the built-in folder browser for files already on disk (no copy). Click
   **Build Plan** — nothing is written yet.
2. **Review tab** — each file shows its detected system (with the evidence behind the guess), the
   action that will run on it, its destination path, and any warnings (name collision, low
   detection confidence, no folder mapped, not enough free space). Override the system or action
   dropdown and the destination re-computes immediately, server-side. A "What do these actions
   mean?" disclosure explains the chd-cd/chd-dvd/rvz/keep-zip/copy choice inline. If a system has
   no folder yet, a **Create folder** control appears right in the warning, pre-filled with the
   standard name for that system — click it and the row resolves immediately. Click **Process** to
   start converting and writing the rows that resolved cleanly.
3. **Queue tab** — live progress per file (streamed over SSE), with a Cancel button while a job is
   queued or running. A cancelled or failed job never leaves a partial file at the destination.

**What each action actually does:**

| Action | Systems | What runs |
|---|---|---|
| `chd-cd` / `chd-dvd` | PS1/PS2/PSP/Saturn/Sega CD/Dreamcast/PCE-CD/3DO | `chdman createcd`/`createdvd`, then `chdman verify` (toggle via `verifyAfterConvert` in config) |
| `rvz` | GameCube/Wii | `DolphinTool convert` — **not exercised locally** (see note below); GC/Wii support degrades to `copy` if DolphinTool isn't found |
| `keep-zip` | Cartridges | Copies an existing `.zip` as-is; re-packages a `.7z`/`.rar`/raw ROM into a fresh `.zip` via `7zz` |
| `copy` | Computer disk images, arcade sets | Straight streamed copy, no transformation |

A bare `.bin` with no `.cue` at all gets a `.cue` synthesized on the fly (sector mode read from
the first sector's header) before conversion. A multi-disc set — files whose names differ only by
a `(Disc N)`/`(Disk N)`/`(CD N)` token — gets a `.m3u` playlist written alongside them once every
disc in the set is done.

**DolphinTool caveat:** the RVZ wrapper (`server/convert/dolphin.ts`) is written against
DolphinTool's documented CLI but hasn't been run against a real DolphinTool binary — it isn't
installed on the machine this was built on. If you install Dolphin and hit an RVZ conversion
error, check the exact flags with `DolphinTool convert --help` first.

**Known limitation:** the Review tab's overrides (and the re-planned destinations they produce)
live in that tab's local state — navigating to Queue or Drop and back to Review resets the table
to the original auto-detected plan. Re-apply any manual system/action overrides after switching
tabs and back, or process before switching away.

## System detection

The detection engine behind the Drop/Review screens can also be exercised directly:

```bash
curl -s -X POST http://localhost:3001/api/detect \
  -H "Content-Type: application/json" \
  -d '{"path":"/absolute/path/to/some.iso"}' | python3 -m json.tool
```

It identifies a file by, in order: archive contents (recursing into a zipped single ROM or a
zipped disc set), `.cue`/`.gdi`/`.ccd` track resolution, disc structure (GameCube/Wii boot magic,
ISO9660 `SYSTEM.CNF`/`PSP_GAME` for PS1/PS2/PSP, IP.BIN text markers for Saturn/Dreamcast/Sega
CD/PC Engine CD), cartridge header magic bytes (NES/SNES/N64/GB/GBC/GBA/NDS/Genesis/SMS/Game
Gear), and finally a low-confidence file-extension fallback. Each result is a ranked list of
candidates with a human-readable evidence string — nothing is a silent guess. Every check reads
only small, targeted regions of the file (a header, a directory sector), never the whole thing,
so this is cheap even against multi-gigabyte disc images.

---

## Roadmap

See [PLAN.md](PLAN.md) for the full build plan. Remaining:

5. Library hashing + optional DAT-based renaming (inert until you add DAT files)

---

## Development

```bash
npm run typecheck   # TypeScript, both server and web
npm test             # vitest — detection, planning, and real chdman/7zz conversion integration tests
```

Project layout:

```
server/    Express API — tool discovery, destination/folder mapping, system detection, planning, conversion + job queue
web/       Vite + React UI
config/    User settings + optional DAT files (gitignored except the example/.gitkeep)
data/      Reserved for the Phase 5 library log (gitignored, not written yet)
staging/   Upload holding area (gitignored)
```

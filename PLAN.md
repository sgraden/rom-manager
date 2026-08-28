# ROM Manager — Implementation Plan

## Context

Managing a ROM library by hand is tedious and error-prone: disc-based games ship as huge
`bin`/`cue`/`iso` sets that waste tens of GB unless converted to CHD/RVZ, bare `.bin` dumps
arrive with no `.cue`, multi-disc games need `.m3u` playlists, and every file has to land in
exactly the right per-system folder or the frontend won't see it.

The goal is a **local web app**: drag a file (or a folder, or an archive) into the browser, the
app identifies what console it belongs to, converts it to the space-efficient container that
system's emulator actually reads, and writes it to the correct folder on a chosen destination —
today an exFAT SD card mounted at `/Volumes/ROMSCARD` (30 GB, 131 pre-created system folders,
currently empty), used in an AYN Thor. Nothing about the design is Thor-specific; the destination
and its folder layout are discovered at runtime.

Current state: `/Users/steven/Git/rom-manager` is empty. This is a greenfield build.

### Decisions already made
- **Local Node server + browser UI.** The server needs real filesystem access and must shell out
  to native converters; multi-GB files must never be buffered in browser memory.
- **Folder mapping is discovered, not hardcoded.** Scan the destination's existing folders, match
  against a built-in alias table, persist overrides in editable JSON.
- **No renaming in v1.** Files keep their original names. DAT-based renaming is designed for now
  (hashes computed, interfaces in place, `config/dats/` watched) but is inert until DAT files
  exist. It must be addable later without reprocessing the library.
- **v1 scope:** disc→CHD, cartridge archive handling, and PS2/PSP/GC/Wii formats.
- **Out of scope for v1:** auditing/repairing the existing card contents, artwork scraping,
  online hash lookup.

---

## Prerequisites (document in README; the app must also detect and report these)

```bash
brew install rom-tools sevenzip
```

- `chdman` (from `rom-tools`) — CHD creation/verification. Confirmed available, v0.289.
- `7zz` (from `sevenzip`) — archive listing/extraction/creation. Confirmed available, v26.02.
- `DolphinTool` — RVZ for GameCube/Wii. Ships inside the Dolphin cask at
  `/Applications/Dolphin.app/Contents/MacOS/DolphinTool`. Optional; GC/Wii support degrades to
  "copy as-is" when missing.
- `maxcso` — **not in Homebrew**. Optional. PSP defaults to CHD instead (PPSSPP reads CHD), so
  maxcso is only used for CSO/ZSO if the user installs it and enables it in config.

The server must probe for each tool at startup (`chdman --help`, etc.), cache the result, and
expose it at `GET /api/tools`. The UI shows a status panel and disables actions whose tool is
missing rather than failing mid-job.

---

## Architecture

```
rom-manager/
  package.json  tsconfig.json          # TypeScript, ESM, Node 25
  config/
    config.json                        # generated on first run; user-editable, UI-editable
    dats/                              # empty in v1; drop No-Intro/Redump .dat here later
  data/
    library.json                       # append-only record of everything processed
  staging/                             # uploads land here; cleaned after successful write
  server/
    index.ts                           # Express app, static web build, SSE endpoint
    routes/{ingest,plan,jobs,targets,config,tools}.ts
    detect/
      index.ts                         # orchestrator: archive -> disc -> magic -> ext -> unknown
      signatures.ts                    # console header magic table
      extensions.ts                    # extension -> candidate systems
      disc.ts                          # ISO9660 walker, SYSTEM.CNF, IP.BIN, GC/Wii magic
      archive.ts                       # 7zz list/extract wrappers
      cuesheet.ts                      # parse .cue/.gdi/.ccd, find referenced tracks
    convert/
      tools.ts                         # discovery + version probe for external binaries
      chdman.ts  dolphin.ts  sevenzip.ts  maxcso.ts
      cuegen.ts                        # synthesize .cue for a bare .bin
      m3u.ts                           # multi-disc playlist generation
    library/
      systems.ts                       # THE canonical system table (see below)
      targets.ts                       # destination discovery + folder mapping
      hash.ts                          # single-pass CRC32/MD5/SHA1
      dat.ts                           # DatIndex; no-op when config/dats is empty
      fsutil.ts                        # exFAT-safe names, free-space check, atomic write
    jobs/
      queue.ts                         # serial (configurable) queue, cancel, progress events
      types.ts
  web/                                 # Vite + React + TypeScript
    pages: Drop, Review, Queue, Settings
```

### Data flow
1. **Ingest** — file lands in `staging/` (upload) or is referenced in place (local path).
2. **Detect** — produce `{ system, confidence, kind: cart|disc|archive, evidence[] }`.
3. **Plan** — combine detection + config rules into a proposed `Job`
   (`action`, `destination`, `estimatedSize`). Nothing is written yet.
4. **Review** — user sees a table of proposed jobs, can override system, action, or destination.
5. **Execute** — queue runs jobs, streams progress over SSE, writes atomically to the target.
6. **Record** — append hashes + result to `data/library.json`.

Steps 3 and 5 are strictly separated: **the app never writes to the destination without an
explicit confirm from the Review screen.** Source files are never deleted unless the user opts in
per-batch.

---

## Component detail

### `library/systems.ts` — the canonical system table

This is the most important file in the project; everything else reads from it. One entry per
console:

```ts
{
  id: "psx",
  name: "Sony PlayStation",
  media: "disc",                        // disc | cartridge | computer | arcade
  extensions: [".cue", ".bin", ".iso", ".img", ".chd", ".pbp"],
  folderAliases: ["psx", "ps1", "playstation", "psone"],
  detect: [...],                        // references into signatures.ts / disc.ts probes
  defaultAction: "chd",                 // chd | rvz | cso | keep-zip | extract | copy
  chdmanMode: "createcd",               // createcd | createdvd | createraw
}
```

Minimum coverage for v1 (detection + routing): NES, FDS, SNES, N64, GB, GBC, GBA, NDS,
Genesis/MD, Sega CD, Saturn, Master System, Game Gear, 32X, Dreamcast, PS1, PS2, PSP, GameCube,
Wii, TurboGrafx-16/PC Engine + CD, Neo Geo/FBNeo, Atari 2600/5200/7800/Lynx/Jaguar, 3DO, Amiga,
C64, MAME/arcade. Every other folder on the card is reachable via manual override in Review.

### `detect/` — identification, in order

1. **Archive** (`.zip .7z .rar`) → list entries with `7zz l`, recurse detection on the entries.
   A single-ROM archive resolves to that ROM's system; a bin/cue set resolves as one disc unit.
2. **Cue/gdi/ccd** → parse, verify referenced track files exist alongside, classify as a disc set.
3. **Disc image** (`.iso .bin .img .chd .cdi .nrg`) → `disc.ts`:
   - GameCube magic `0xC2339F3D` @ `0x1C`; Wii magic `0x5D1C9EA3` @ `0x18`
   - ISO9660: read PVD @ sector 16, walk root; `SYSTEM.CNF` with `BOOT=` → PS1, `BOOT2=` → PS2;
     `PSP_GAME/` or `UMD_DATA.BIN` → PSP
   - IP.BIN strings: `SEGA SEGAKATANA` → Dreamcast, `SEGA SEGASATURN` → Saturn,
     `SEGADISCSYSTEM` → Sega CD, `PC Engine CD-ROM` → PCE-CD, 3DO volume header
4. **Cartridge magic bytes** (`signatures.ts`): `NES\x1A`; `FDS\x1A`; N64 `0x80371240` and its
   byteswapped forms; GB/GBC Nintendo logo @ `0x104` (+ CGB flag @ `0x143`); GBA logo @ `0x04`;
   NDS logo @ `0xC0`; `SEGA` @ `0x100` (Genesis); `TMR SEGA` @ `0x1FF0/0x3FF0/0x7FF0` (SMS/GG);
   SNES internal header checksum/complement probe at `0x7FC0`/`0xFFC0`/`0x40FFC0`.
5. **Extension table** — unambiguous extensions (`.sfc .gba .nds .a26 …`) resolve directly.
6. **Unknown** → surfaced in Review with a system dropdown, never silently guessed.

Detection returns *ranked candidates with evidence strings* ("SYSTEM.CNF contains BOOT2"), shown
in the UI so an override is an informed one. Only the first 64 KB plus targeted seeks are read —
never the whole file.

### `convert/` — the conversions

| Source | Action | Command |
|---|---|---|
| `.cue`/`.gdi`/`.ccd` (+ tracks) | CHD | `chdman createcd -i X.cue -o X.chd` |
| bare `.bin`, no cue | generate cue, then CHD | `cuegen.ts` → `chdman createcd` |
| CD `.iso` (PS1, PCE-CD, …) | CHD | `chdman createcd` |
| DVD `.iso` (PS2, PSP) | CHD | `chdman createdvd -i X.iso -o X.chd` |
| GameCube/Wii `.iso`/`.gcm` | RVZ | `DolphinTool convert -f rvz -c zstd -l 5 -b 131072` |
| PSP `.iso` (maxcso enabled) | ZSO | `maxcso --format=zso` |
| Cartridge ROM | per-config: keep `.zip`, extract, or copy | `7zz` |
| Already `.chd`/`.rvz`/`.cso` | copy as-is | — |

**`cuegen.ts`** — for a bare `.bin`, determine sector size and mode before writing the cue:
`size % 2352 == 0` → raw sectors; read the byte at offset `0x0F` of the first sector
(`0x01` → `MODE1/2352`, `0x02` → `MODE2/2352`). `size % 2048 == 0` and not a multiple of 2352
→ `MODE1/2048`. Emit a single-track cue; flag low confidence in the UI when ambiguous, since a
wrong mode produces a CHD that won't boot.

**`m3u.ts`** — after a batch, group outputs whose names differ only by a
`(Disc N)` / `(Disk N)` / `(CD N)` token and write `Base.m3u` listing them in disc order next to
the converted files.

**Progress** — `chdman` writes `Compressing, XX.X% complete...` to stderr with `\r`;
`DolphinTool` prints a percentage. Each wrapper parses its own tool's output and emits normalized
`{ jobId, percent, phase }` events. Cancel kills the child and deletes the partial output.

**Verification** — config flag `verifyAfterConvert` (default on for CHD): run `chdman verify`
and mark the job failed if it doesn't pass.

### `library/targets.ts` — destinations and folder mapping

- `GET /api/targets` lists candidate destinations: everything under `/Volumes` plus any paths
  added in config. Report free space and filesystem type per target (`exfat` matters).
- On selecting a target, find its ROM root (a directory named `roms`, or the target root itself)
  and enumerate subdirectories.
- Map each folder to a system id via `folderAliases`, case-insensitively. Persist the resulting
  map to `config.json` under the target's volume name so it survives remounts.
- Unmatched folders and unmapped systems are both shown in Settings for manual pairing.
- Never create a folder implicitly — if a system has no folder, Review shows a "create
  `roms/<id>`?" prompt.

### `library/fsutil.ts` — exFAT-safe writes

The destination is exFAT, which constrains what can be written:

- Strip/replace illegal characters `" * / : < > ? \ |`; no trailing dot or space; cap at 255 chars.
- Check free space against the estimated output size *before* starting a job; fail fast.
- Write to `<name>.part` in the destination folder, then `rename()` into place — never leave a
  half-written ROM that looks complete.
- No symlinks or hardlinks; no POSIX permission assumptions (`noowners` is set on the mount).
- Detect a name collision and offer skip / overwrite / rename in Review, never auto-overwrite.

### `library/dat.ts` + `hash.ts` — future-ready, inert today

- `hash.ts` computes CRC32, MD5, and SHA-1 in a **single pass** over the source file, reusing the
  read stream already needed for staging or hashing. Hashes are always of the *original,
  pre-conversion* file, because that is what DATs describe.
- Every processed file gets a record in `data/library.json`:
  `{ hashes, originalName, system, action, destination, sizeBefore, sizeAfter, timestamp }`.
- `DatIndex` loads every `.dat` (No-Intro/Redump XML) found in `config/dats/` into a
  hash → canonical-name map. **When the folder is empty it returns `null` for every lookup and
  the app keeps original filenames.**
- The rename step calls `datIndex.lookup(hashes)` and uses the result only if non-null. Dropping
  a DAT in later is a restart away; because `library.json` already holds the hashes, a future
  "re-check names against DATs" command can rename files already on the card without re-reading
  or re-converting them. Build that command's foundation now, the command itself later.

### `jobs/queue.ts`

Serial by default (`maxConcurrent` in config; conversions are CPU-bound). Job states:
`queued → running → done | failed | cancelled`. Progress and state changes broadcast over
`GET /api/events` (SSE). Failures keep their error text and the tool's last stderr lines, visible
in the UI. A failed job never leaves anything at the destination.

### Web UI (4 screens)

- **Drop** — big drop zone (streams uploads to `staging/` via a `fetch` request with a
  `ReadableStream` body, so a 40 GB file never enters memory), plus an "Add by path" field and a
  server-side folder browser. macOS Finder drag-drop doesn't expose file paths to the browser, so
  the path input is the way to process large files already on disk without copying them.
- **Review** — table: file, detected system (+ evidence, editable dropdown), action (editable),
  destination path, size before → estimated after, warnings (collision, low-confidence cue mode,
  missing tool, insufficient space). One "Process" button.
- **Queue** — live progress bars, per-job log tail, cancel, retry.
- **Settings** — destination picker, folder map editor, per-system default actions, tool paths
  and detected versions, `config/dats/` status, delete-source-after-success toggle (default off).

---

## Build order

1. **Skeleton + tools** — Express server, Vite web build, `GET /api/tools` probing chdman/7zz/
   DolphinTool, `GET /api/targets` listing volumes with free space and fs type. Settings screen.
2. **Systems table + detection** — `systems.ts`, `signatures.ts`, `extensions.ts`, `disc.ts`,
   `cuesheet.ts`, `archive.ts`. Ship a unit test per detector using small synthetic headers.
3. **Ingest + planning + Review UI** — upload streaming, path ingest, plan generation, folder
   mapping, exFAT name sanitization, collision and free-space checks. **Dry run only — no writes.**
4. **Conversion + queue** — chdman (createcd/createdvd), cuegen, 7zz, DolphinTool, SSE progress,
   cancel, atomic write, verify, m3u generation. This is where the app becomes useful.
5. **Library record + DAT scaffolding** — single-pass hashing, `library.json`, `DatIndex`
   returning null on an empty folder, rename hook wired through but inactive.

---

## Verification

Run each after its phase; phases 4–5 need the card mounted.

**Tools and targets**
```bash
npm run dev
```
Open the UI: Settings must show chdman 0.289 and 7zz 26.02 as found, DolphinTool as found or
missing, and `/Volumes/ROMSCARD` as a target with ~29 GB free and filesystem `exfat`.

**Detection** — unit tests over synthetic headers (`NES\x1a`, Genesis `SEGA` @ 0x100, GC magic
@ 0x1C, a minimal ISO9660 PVD with a `SYSTEM.CNF` containing `BOOT2=`). Then feed real files
through `POST /api/detect` and confirm the reported system and evidence.

**Cue generation** — construct a 2352-byte-sector MODE1 bin and a 2048-sector bin; assert
`cuegen` emits `MODE1/2352` and `MODE1/2048` respectively.

**End-to-end round trip** — the real correctness check for CHD:
```bash
chdman extractcd -i out.chd -o rt.cue -ob rt.bin && cmp rt.bin original.bin
```
Byte-identical output means the conversion is lossless. Do this once by hand with a homebrew or
public-domain disc image before trusting the app with the library.

**Write path** — process one small cartridge ROM and one small disc image to
`/Volumes/ROMSCARD`. Confirm: file lands in the right system folder, no `.part` file remains,
the source in `staging/` is cleaned, `data/library.json` has a record with three hashes, and the
name is unchanged from the original. Then re-process the same file and confirm the collision
prompt appears instead of an overwrite.

**Multi-disc** — process a two-disc set and confirm both CHDs plus a correctly ordered `.m3u`
appear in the destination folder.

**Cancel and failure** — cancel a running conversion; confirm the child process dies, no partial
file remains at the destination, and the job shows as cancelled. Point a job at a full volume and
confirm it fails on the pre-flight space check rather than mid-write.

**DAT inertness** — with `config/dats/` empty, confirm every processed file keeps its original
name and no lookup errors appear in the log.

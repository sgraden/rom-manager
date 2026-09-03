# ROM Manager — Review, Fixes, and Planned Work

Audience: a coding agent picking this repo up cold. Read [PLAN.md](PLAN.md) for the original
architecture and [README.md](README.md) for install/usage. This document is the working list of
**known defects, efficiency problems, planned features, and design work**, each with a concrete
recommended fix.

Reviewed at commit `6c4272d`. At that commit: `npm run typecheck` passes, `npm test` passes
(129 tests, 15 files). Everything below was read from source; measured claims note how they
were measured.

**How to use this file:** pick an item, implement the "Fix" section, add or update a test that
would have caught it, then add a `> **Status: done.**` line under its heading saying what landed.
Items are ordered by impact within each section. Nothing here requires a rewrite — they are all
local changes.

**Progress.** Sections 1, 2 and 3 are complete, and §4's server side is done (index, matching,
routes, and the safe replace-on-write path). Still to do: §4's UI (Review Status column and the
Library tab) and §5 (design). Sections 1–3 — every correctness, efficiency and
robustness item listed below has landed, each with a test. Remaining: **§4** (Library page and
duplicate matching) and **§5** (design work).

---

## Table of contents

1. [Correctness bugs](#1-correctness-bugs)
2. [Efficiency problems](#2-efficiency-problems)
3. [Robustness and security](#3-robustness-and-security)
4. [Feature: Library page + duplicate matching on add](#4-feature-library-page--duplicate-matching-on-add)
5. [Design improvements](#5-design-improvements)
6. [Suggested order of work](#6-suggested-order-of-work)

---

## 1. Correctness bugs

### 1.1 One unreadable file fails the entire plan
> **Status: done.** Detection is now contained per-file in `buildOne`; an unreadable source becomes an unresolved row with a warning. Covered by *"keeps planning the rest of the batch when one file can't be inspected"* in `plan.test.ts`.


**Where:** [server/library/plan.ts:92](server/library/plan.ts#L92), inside `buildOne`.

`statSync` is wrapped in try/catch, but the `detectPath` call immediately after is not. If a
single source has been moved, unmounted, or has bad permissions, `FileReader`'s `openSync`
throws, the exception propagates out of `buildPlan`, and [server/routes/plan.ts](server/routes/plan.ts)
returns a 500 for the **whole batch**. Drop twenty files, have one go missing, and the Review
page shows nothing but a raw 500 string.

The same path is re-run at enqueue time in [server/routes/jobs.ts:72](server/routes/jobs.ts#L72),
so it can also kill a Process click that was valid a moment earlier.

**Fix:** wrap the `detectPath` call per-file and degrade to an unresolved row rather than
throwing:

```ts
let detection: DetectionResult;
try {
  detection = detectPath(sourcePath, options);
} catch (err) {
  detection = { kind: "unknown", candidates: [], warnings: [
    `Could not inspect this file: ${err instanceof Error ? err.message : String(err)}`,
  ] };
}
```

The row then renders with a warning and an unset system, which is exactly the "needs manual
review" state the UI already handles. Add a `plan.test.ts` case for a non-existent path.

---

### 1.2 Two jobs writing the same destination corrupt each other
> **Status: done.** `.part` files are now scoped per job id, `enqueue` claims destination paths and rejects a second job aimed at the same one, and the destination is re-checked immediately before the rename. Three new cases in `queue.test.ts`.


**Where:** [server/jobs/queue.ts:312-317](server/jobs/queue.ts#L312) and
[server/jobs/queue.ts:463](server/jobs/queue.ts#L463).

The pre-flight `existsSync(job.destinationPath)` check and the final `renameSync` are separated
by the entire conversion. With `maxConcurrentJobs > 1`, two jobs that resolve to the same
destination (the same game added twice, or two dumps whose sanitized names collide) both pass
the check, then both write to the *same* `${destinationPath}.part` file simultaneously. The
output is a corrupt interleaving, and the second `renameSync` silently replaces the first
result.

**Fix:** two changes, both small.

1. Make the `.part` path unique per job — `${job.destinationPath}.${job.id}.part` — so
   concurrent writers can never share a scratch file.
2. Claim the destination atomically at enqueue time. Keep a `Set<string>` of destination paths
   claimed by queued/running jobs on `JobQueue`; `enqueue` rejects (or marks the job failed with
   a clear message) when the path is already claimed, and the claim is released in `runJob`'s
   `finally`. This also gives the Review page a truthful "already queued" warning.

Additionally, `renameSync` should be preceded by a final `existsSync` re-check so a file that
appeared on the card mid-conversion isn't clobbered.

---

### 1.3 `.m3u` playlists only ever see the current session's jobs
> **Status: done.** `maybeWriteM3u` now reads the destination folder's real contents (skipping dotfiles and the playlist itself) and is scoped to the folders the finished job wrote to — which also resolves §2.6. Two new `queue.test.ts` cases, including a disc placed by an earlier session.


**Where:** [server/jobs/queue.ts:567](server/jobs/queue.ts#L567), `maybeWriteM3u`.

The playlist is built from `this.order` — the in-memory job list, which is empty after every
restart. `groupForM3u` requires two or more discs in a group, so adding *Final Fantasy VII
(Disc 2)* in a later session than *(Disc 1)* writes no playlist at all, and the user has no
signal that it was skipped.

**Fix:** build the group from the destination folder's actual contents, not from job history.
After a disc-numbered job completes, `readdirSync(job.destinationFolder)`, feed every filename
sharing the stripped base name into `groupForM3u`, and write the playlist if the result has two
or more discs. This is a handful of lines and makes the feature correct across restarts. It also
composes with the Library index in §4, which already needs a per-folder file listing.

---

### 1.4 An old `config.json` can crash every target route
> **Status: done.** `DEFAULTS` is now a complete `AppConfig`, `toolPathOverrides` is merged one level deeper, and an unparseable config falls back to defaults instead of failing at boot. Covered by the new `config.test.ts`.


**Where:** [server/library/config.ts:114-140](server/library/config.ts#L114).

`DEFAULTS` backfills only `reservedCpuCores`. Any other field added since a user's
`config.json` was generated stays `undefined`, and
[server/library/targets.ts:459](server/library/targets.ts#L459)
(`config.targetFolderMaps[target.name]`) throws a `TypeError` on `undefined`. The comment on
`DEFAULTS` says it exists so "upgrading the app doesn't require deleting/regenerating their
config" — but it only covers one field, so it does not deliver that.

**Fix:** make `DEFAULTS` a complete `AppConfig` (it can simply be the parsed
`config.example.json`, or a literal mirroring it) and deep-merge `toolPathOverrides` rather than
spreading it shallowly. Add a `config.test.ts` that loads a `{"port": 3001}`-only config and
asserts every field is populated.

---

### 1.5 A failed upload leaves an orphaned staging directory and hangs the client
> **Status: done.** `abort()` now destroys the stream, removes the upload directory, and always answers the request. A startup sweep (`server/library/staging.ts`, with tests) clears directories left by earlier crashes.


**Where:** [server/routes/ingest.ts:26](server/routes/ingest.ts#L26).

On `req` error the write stream is destroyed, but the partially-written file and its UUID
directory are never removed, and **no response is ever sent** — the browser's XHR just hangs
until it times out. Every aborted drop leaks a directory under `staging/`.

**Fix:**

```ts
const abort = (message: string) => {
  writeStream.destroy();
  rmSync(uploadDir, { recursive: true, force: true });
  if (!res.headersSent) res.status(500).json({ error: message });
};
req.on("error", () => abort("Upload interrupted before the file finished transferring."));
req.on("aborted", () => abort("Upload cancelled."));
writeStream.on("error", (err) => abort(err.message));
```

Consider also a startup sweep that removes `staging/` subdirectories older than a day, since
crashes will always leak some.

---

### 1.6 Archived ROMs never match a DAT
> **Status: done.** New `hashArchiveEntry` hashes the ROM's decompressed bytes straight from `7zz` stdout, and `hashTargetFor` uses it for single-entry archives; multi-entry archives still hash the container, which stays the honest answer for a disc set. `LibraryRecord.hashedName` records which was hashed. An entry filter that matches nothing now rejects instead of silently producing the empty digest.


**Where:** [server/jobs/queue.ts:517](server/jobs/queue.ts#L517).

`recordLibraryEntry` hashes `job.sourcePath`. When the source is a `.zip`/`.7z`, that is the
hash of the *archive container*, not of the ROM inside it. DAT files index the inner ROM's
CRC32/MD5/SHA-1, so every archived cartridge ROM — the single most common case for `keep-zip`
systems — records hashes that can never match, and `datMatch` is permanently null.

**Fix:** hash the content that was actually inspected. The cleanest route is to have the
conversion step return the resolved inner file path (it already extracts one in
`resolveDiscSource` / `runKeepZip`) and pass it to `recordLibraryEntry` before the temp
directory is cleaned up. Where no inner file exists, keep hashing the source. Record both
`sourceHashes` and `contentHashes` in `LibraryRecord` so the log stays honest about which is
which.

---

### 1.7 `.gdi` parsing can be fooled by a comment or a quoted title
> **Status: done.** Track filenames are now matched positionally against the real GDI line grammar, with an optional trailing offset. Four new `cuesheet.test.ts` cases.


`GDI_TRACK_FILENAME` in [server/detect/cuesheet.ts](server/detect/cuesheet.ts) alternates a
quoted-string match with a bare `\S+\.(bin|raw|iso)` match, applied to any non-empty line after
the first. A `.gdi` whose lines carry other quoted fields will pick up the wrong token. Low
severity (missing files are reported as warnings rather than failing silently), but worth
tightening to the real GDI grammar: `index type sectorSize "filename" offset`.

---

## 2. Efficiency problems

### 2.1 Archives are fully extracted just to identify them — repeatedly
> **Status: done.** All three parts landed. Detection streams a bounded 8MB prefix of the single relevant entry via `7zz e -so` (measured: **87ms vs 832ms** on a 600MB entry, and nothing written to disk), falling back to a full read only when no byte-level probe matched; results are cached on `path + mtime + size`; and `ReviewPage.replan` now re-plans only the affected rows. Covered by `server/detect/archiveDetect.test.ts`.


**Where:** [server/detect/index.ts:135](server/detect/index.ts#L135), `detectArchive`.

To identify one file inside an archive, the code runs `7zz x` and decompresses the **entire
archive** to a temp directory, inspects one entry, then deletes it. For a 4 GB PS2 `.7z` that is
a multi-minute, multi-gigabyte round trip.

Worse, it happens more than once for a single file:

| When | Trigger |
| --- | --- |
| 1 | Build Plan — `POST /api/plan` |
| 2..n | Every System/Action dropdown change on Review (`applyOverride` → full `replan`) |
| n+1 | Process — `POST /api/jobs` rebuilds the plan server-side before enqueueing |
| n+2 | The job itself — `resolveDiscSource` extracts it again |

Changing three dropdowns on a plan of five archived discs is dozens of gigabytes of redundant
decompression.

**Fix — three independent wins, do all three:**

1. **Extract only what is needed.** `7zz x -y -o<dir> <archive> <entryName>` extracts a single
   entry. Better still for detection, `7zz e -so <archive> <entryName>` streams the entry to
   stdout — read the first ~64 KB, plus `readIso9660RootEntries`' sector 16 if needed, and stop.
   Detection never needs more than the first few hundred KB of a disc image.
2. **Cache detection results.** Key on `${path}:${mtimeMs}:${size}` in a module-level `Map` in
   `server/detect/index.ts`. Detection is a pure function of file bytes, so this is safe, and it
   collapses steps 1–3 above to a single inspection.
3. **Re-plan only the changed row.** `ReviewPage.applyOverride` currently re-plans every file to
   reflect one dropdown change. Send just the changed `sourcePath` and merge the single returned
   job into state.

### 2.2 Tool detection spawns four subprocesses on nearly every request
> **Status: done.** `detectTools` is memoized on the overrides object, with `refreshTools()` exposed through `GET /api/tools?refresh=1`. Covered by `server/convert/tools.test.ts`, including a warm-vs-cold timing assertion.


**Where:** [server/convert/tools.ts:645](server/convert/tools.ts#L645), `detectTools`.

`detectTools` is not memoized. Every call `spawnSync`s up to four binaries with `--help`. It is
called from `/api/tools`, `/api/detect`, `/api/plan`, `POST /api/jobs`, and from the queue's
`getTools()` closure once per job.

Measured on this machine: **~295 ms per call** (5 sequential calls took 1478 ms). That is ~300 ms
of pure subprocess overhead added to every plan and every re-plan, on the request's main thread,
blocking the event loop for the whole duration.

**Fix:** memoize the result in a module-level variable, invalidated when
`config.toolPathOverrides` changes and by an explicit `refreshTools()` that `/api/tools` calls
when given `?refresh=1`. Settings should keep a "Re-check tools" button so a user who just ran
`brew install` doesn't have to restart.

### 2.3 `library.json` is rewritten in full on every job
> **Status: done.** The log is now `data/library.jsonl`, appended one line per record, with `readLibraryRecords()` for reading it back and a one-time migration from the old array format. A damaged line is skipped rather than failing the read. Covered by a rewritten `libraryLog.test.ts`. **See the warning under §2.3a below.**


**Where:** [server/library/libraryLog.ts:24](server/library/libraryLog.ts#L24).

`appendLibraryRecord` reads, parses, pushes, and re-serializes the entire log for each record —
O(n²) total work as the library grows, and a crash mid-`writeFileSync` truncates the whole
history, not just the newest entry. PLAN.md calls this an "append-only record", which is what it
should be but isn't.

**Fix:** switch to JSON Lines (`data/library.jsonl`) and use `appendFileSync` with one
`JSON.stringify(record) + "\n"` per line. Appends become O(1) and constant-memory, and a partial
write costs at most the last line. Provide a one-time migration that converts an existing
`library.json` array into `.jsonl` on first run. The Library page in §4 reads it back with a
streaming line reader.

If the JSON array format must be kept, at minimum write to `${LIBRARY_PATH}.tmp` and
`renameSync` over the original so the file is never observed half-written.

### 2.3a Incident: `data/library.json` was destroyed during this work

**What happened.** The JSONL migration in §2.3 deletes the legacy `data/library.json` once its
contents are safely converted. `server/jobs/queue.test.ts` mocks `../lib/paths.js` with
`{ ...actual, LIBRARY_LOG_PATH: <tmp> }` — overriding only the *new* path, so
`LEGACY_LIBRARY_PATH` still resolved to the real `data/library.json` in the repo. The first
test run after the migration landed therefore migrated the user's genuine processing log into a
scratch file in `$TMPDIR` and removed the original. The scratch file was then deleted as
ordinary test cleanup before the mistake was noticed. **The contents are not recoverable** —
the file was gitignored, so there is no committed copy, and no dated local snapshot covers it.

**What was lost.** The record of previously processed files: original names, CRC32/MD5/SHA-1
hashes, actions, destinations, sizes, and any DAT matches. No ROM on any card was touched, and
nothing in the app depends on the log to function — §4's Library index treats the card itself
as the source of truth and uses the log only for enrichment. The practical loss is the hashes,
which would take a full re-read of every source file to reproduce.

**Fixes applied, so this cannot recur:**

1. `migrateLegacyLog` now **renames** the legacy file to `library.json.migrated` instead of
   unlinking it. A migration should never be the step that loses the only copy of something.
2. `queue.test.ts` now overrides **both** `LIBRARY_LOG_PATH` and `LEGACY_LIBRARY_PATH`, with a
   comment naming this failure so the next person to touch the mock understands why.

**Standing rule for this repo:** any test that exercises code touching `data/`, `config/`, or
`staging/` must redirect *every* path constant that code reads — not just the one the test is
about. Partially mocking a paths module leaves the un-mocked constants pointing at real user
data.

---

### 2.4 Post-job hashing is unbounded and competes with active conversions
> **Status: done.** Hashing runs through a serial `hashChain`, with a `hashing` phase emitted for the UI and a `.catch` so one failure can't stop every later job from being hashed. Covered by a test asserting peak concurrency is 1.


**Where:** [server/jobs/queue.ts:475](server/jobs/queue.ts#L475).

`void this.recordLibraryEntry(job)` is deliberately fired without awaiting so the run slot frees
immediately — good — but nothing bounds how many of these run at once. Finish four jobs together
and four full multi-gigabyte reads run concurrently *while* the next four conversions are
hammering the same disk. On an SD card or a spinning external drive this measurably slows the
conversions the user is actually watching.

**Fix:** run hashing through a simple serial queue (a promise chain, one file at a time). The
work is I/O-bound, so serializing costs almost nothing in throughput and removes the contention.
While it is pending, the Queue row can show "hashing…" — see §5.4.

### 2.5 `mount` is shelled out on every target listing
> **Status: done.** The parsed mount table is cached for 3s.


`listTargets` → `getMounts` runs `spawnSync("mount")` each call, and `listTargets` is called by
`/api/targets`, `/api/plan`, `POST /api/jobs`, and three separate `/api/targets/:name/...`
routes (`targetsRouter.post("/:name/folders")` calls it twice). Cache the parsed mount table for
a few seconds; volume topology does not change per-request.

### 2.6 `maybeWriteM3u` rescans and rewrites every group after every job
> **Status: done.** Resolved as part of §1.3 — the call is now scoped to the finished job's own destination folder.


Called from `pump`'s `finally` for each completed job, it iterates all done jobs and rewrites
every multi-disc playlist. Harmless at ten jobs, wasteful at a thousand. Once §1.3 changes it to
read the destination folder, scope the call to the finished job's own group.

### 2.7 `extractArchive`'s 120-second timeout will kill real extractions
> **Status: done.** The timeout is gone — a large disc image legitimately takes minutes, and a timed-out `spawnSync` reported the useless `exit null`.


[server/detect/archive.ts](server/detect/archive.ts) passes `timeout: 120000` to the extraction
`spawnSync`. A large `.7z` legitimately takes longer, and on timeout `result.status` is `null`,
producing the useless message `7-Zip extract failed (exit null)`. Once §2.1 lands, detection no
longer extracts whole archives and this mostly goes away — but the timeout should still be
removed or raised, and the error message should distinguish a timeout (`result.signal`) from a
real failure.

---

## 3. Robustness and security

### 3.1 The server listens on all interfaces
> **Status: done.** Now binds `127.0.0.1`.


[server/index.ts:51](server/index.ts#L51) calls `app.listen(port, ...)` with no host, binding
`0.0.0.0`. Combined with unauthenticated routes that (a) read any absolute path
(`POST /api/detect`, `POST /api/ingest/path`), (b) write to any mounted volume, and (c) trigger
an `osascript` file-picker dialog on the user's desktop (`POST /api/browse/native`), anyone on
the same network — a café Wi-Fi, a shared office LAN — can read files and write to the card.

**Fix:** `app.listen(port, "127.0.0.1", ...)`. This is a local-only tool; there is no reason to
be reachable off-box. One line, no downside.

### 3.2 Unknown `/api/*` routes return the SPA's HTML with status 200
> **Status: done.** A JSON 404 handler is mounted on `/api` ahead of the static/catch-all block.


[server/index.ts:41](server/index.ts#L41)'s `app.get("*")` catch-all runs after the API routers,
so a typo'd or removed endpoint returns `index.html` with a 200. The client's
`res.json()` then throws an opaque `SyntaxError: Unexpected token '<'` instead of a 404.

**Fix:** insert `app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API endpoint." }))`
immediately before the static/catch-all block.

### 3.3 No express error handler and no body-size limit
> **Status: done.** `express.json({ limit: "2mb" })` plus a terminal error middleware that always responds with `{ error }`.


An exception thrown synchronously in any route without its own try/catch produces Express's
default HTML error page, which the client cannot parse. And `express.json()` defaults to a
100 KB limit — a plan of several hundred long paths plus overrides can exceed it and fail with
an HTML `PayloadTooLargeError`.

**Fix:** `app.use(express.json({ limit: "2mb" }))`, plus a terminal error middleware that always
returns `{ error }` as JSON.

### 3.4 SSE stream has no heartbeat and no listener-cap adjustment
> **Status: done.** `setMaxListeners(0)` on the queue, `flushHeaders()`, `X-Accel-Buffering: no`, and a 20s `: ping` comment cleared on disconnect.


[server/routes/jobs.ts:229](server/routes/jobs.ts#L229) registers one `update` listener per open
`/api/jobs/events` connection. Past ten concurrent tabs Node logs a MaxListenersExceededWarning,
and an idle connection can be dropped by intermediaries with no reconnect signal.

**Fix:** call `jobQueue.setMaxListeners(0)` at construction, `res.flushHeaders()` after
`writeHead`, and write a `: ping\n\n` comment every 20 s cleared on `req.on("close")`.

### 3.5 Job history is unbounded and lost on restart
> **Status: done.** `DELETE /api/jobs/completed` plus a **Clear finished** button on the Queue page, and `trimHistory()` caps retained terminal jobs at 200.


`JobQueue.jobs`/`order` grow forever within a process and vanish when it exits. There is no way
to clear completed rows from the Queue page, and a long session accumulates a table of hundreds.

**Fix:** add `DELETE /api/jobs/completed` that drops terminal jobs from `jobs`/`order`, wire it
to a "Clear finished" button, and cap retained terminal jobs at, say, 200. Durable history is
what `library.jsonl` is for — see §4.

---

## 4. Feature: Library page + duplicate matching on add

**Goal.** A user should be able to see what is already on the destination card, and — when
adding a game that is already there — be told before anything is written, with an explicit
choice to **Replace** or **Skip**.

This is the largest missing piece of workflow. Today the only duplicate signal is a plan warning
string ("A file named X already exists at the destination"), the job then hard-fails at
[server/jobs/queue.ts:317](server/jobs/queue.ts#L317) with "remove or rename it first", and the
user has no way to act on it from inside the app.

### 4.1 Server: a library index
> **Status: server side done.** `server/library/libraryIndex.ts` scans the card and joins `library.jsonl` onto what it finds; `server/routes/library.ts` exposes `GET /api/library`, `POST /api/library/matches`, `DELETE /api/library/entry` (path rebuilt from the target's own romRoot and re-checked with `isPathInside`, files only) and `POST /api/library/reveal`. Six `libraryIndex.test.ts` cases.


Add `server/library/index.ts` exporting a `LibraryIndex` built from two sources:

1. **The card itself** — walk `target.romRoot`, one level into each mapped system folder, and
   collect `{ systemId, folder, filename, sizeBytes, mtimeMs }`. This is the source of truth:
   it reflects files put there by other tools, or by a previous install of this app.
2. **`data/library.jsonl`** (§2.3) — enriches entries this app wrote with `hashes`,
   `originalName`, `datMatch`, `action`, and `sizeBefore`. Join on `destination` path.

Cache the scan per target keyed on the rom-root's `mtimeMs`, and expose a manual refresh; a card
with a few thousand files should scan in well under a second, but it should not be re-walked on
every keystroke.

**Routes:**

| Route | Purpose |
| --- | --- |
| `GET /api/library?target=<name>` | Full index: entries grouped by system, with per-system counts and total bytes. |
| `GET /api/library/matches?target=<name>` (POST body: `sourcePaths`) | For each source, the duplicate verdict described in §4.2. |
| `DELETE /api/library/entry` (body: `{ target, folder, filename }`) | Deletes one file from the card. Must validate with `isPathInside(fullPath, target.romRoot)` before unlinking, and must refuse a path outside it. |

### 4.2 Matching rules — strongest signal first
> **Status: server side done.** `server/library/duplicates.ts` implements all four tiers with the tier reported alongside each match. `(Disc 1)` vs `(Disc 2)` is explicitly not a match, and matching is scoped to the destination folder so two systems' same-named games stay distinct. Nine `duplicates.test.ts` cases.


For each planned source, compute a verdict of `exact` | `likely` | `name` | `none`:

1. **`exact` — content hash match.** The source's (or its inner content's, per §1.6) SHA-1
   equals a hash recorded in `library.jsonl` for a file still present on the card. Unambiguous:
   this is the same dump. Only available for files this app wrote.
2. **`likely` — DAT canonical-name match.** Both sides resolve to the same `datMatch` name via
   `DatIndex`. Catches "same game, differently named dump".
3. **`name` — normalized filename match.** Compare `outputFilenameFor(sourceName, action)`
   against the on-card filenames after normalizing: lowercase, strip the extension, strip region
   and revision tags (`(USA)`, `(En,Fr,Es)`, `(Rev 1)`), collapse whitespace and punctuation.
   Preserve disc tokens — `(Disc 1)` and `(Disc 2)` are *not* duplicates of each other; reuse
   `DISC_TOKEN` from [server/convert/m3u.ts](server/convert/m3u.ts) rather than writing a second
   regex.
4. **`none`** — no match; proceed as today.

Hashing a multi-gigabyte source purely to check for duplicates is too slow to do on the Review
page. Run tier 1 only when the file is small (say under 256 MB) or when the user explicitly asks
("Check by content"), and rely on tiers 2–3 otherwise. Always show which tier produced the
verdict — that is what makes the answer trustworthy.

### 4.3 Review page: the Replace / Skip decision
> **Status: server side done.** The write path is in place: `replace` flows through `PlanOverride` → `PlannedJob` → `Job`, and the queue moves the existing file aside only after the conversion succeeds, deletes it only after the rename succeeds, and restores it if the rename fails. Two `queue.test.ts` cases, including one asserting a failed replace leaves the original untouched. **The Review UI itself is still to do.**


Add a **Status** column to the Review table. For a non-`none` verdict, the row renders:

```
⟳ Already on card — Smuggler's Run (USA).chd, 1.2 GB, added 12 Aug 2025
   matched by: filename                                  [ Skip ] [ Replace ]
```

- **Skip** (the default for every duplicate) excludes the row from the Process submission. The
  Process button's count updates to match, and skipped rows stay visible and greyed rather than
  disappearing, so the user can see what was left out.
- **Replace** carries an explicit `{ replace: true }` per-source flag through to
  `POST /api/jobs`. The queue then, after a successful conversion and immediately before
  `renameSync`, moves the existing file aside to `${destinationPath}.replaced-<timestamp>` and
  deletes it only once the rename succeeds. Never delete the old file up front — a failed
  conversion must leave the card exactly as it was.
- Size deltas belong in the prompt: "replacing 1.2 GB with ~0.9 GB (frees 300 MB)" turns an
  abstract choice into an informed one, and the numbers are already available from
  `estimateOutputBytes` and the index.

Add **Skip all duplicates** / **Replace all duplicates** bulk buttons above the table — the
whole point of this feature is a user re-adding a folder of thirty games and needing to resolve
them in one gesture.

### 4.4 Library page: a fourth top-level tab

A new `library` tab in [web/src/App.tsx](web/src/App.tsx)'s `Tab` union, sitting outside the
Drop → Review → Queue stepper (it is a reference view, not a step). It shows:

- A target selector, plus a header with total files, total bytes used, and free space.
- A collapsible section per system: file count and size, expanding to a sortable table of
  filename / size / date added / DAT match.
- A search box filtering across all systems.
- Per-row **Delete** (with a confirmation naming the file, since this destroys the user's data)
  and **Reveal in Finder** (`execFile("open", ["-R", fullPath])`, mirroring the existing
  `osascript` usage in [server/routes/browse.ts](server/routes/browse.ts)).
- An "unmatched files" section for anything found in a folder that is not mapped to a system,
  so orphans are visible rather than silently ignored.

**Empty and error states matter here more than anywhere else in the app.** No card mounted, card
mounted but empty, and card unreadable are three different situations with three different next
actions — see §5.1.

### 4.5 Tests to write alongside

- `library/index.test.ts` — scanning a scratch directory tree; unmapped folders surface as
  unmatched; the `library.jsonl` join populates hashes.
- `library/match.test.ts` — the four verdict tiers; `(Disc 1)` vs `(Disc 2)` is **not** a match;
  `Game (USA).zip` vs `Game (USA) (Rev 1).zip` matches at the `name` tier.
- `queue.test.ts` — a replace job leaves the original in place when the conversion fails, and
  swaps it only on success.

---

## 5. Design improvements

The README already flags that styling is "functional but rough". These are the specific,
highest-value items. There is currently **no `@media` query anywhere in
[web/src/styles.css](web/src/styles.css)**.

### 5.1 Errors should carry their own fix

This is the single biggest UX gap. Every error in the app today is a raw string in a red
paragraph, and the ones from the API are formatted by
[web/src/api.ts](web/src/api.ts)'s `safeErrorText` as `"/api/plan -> 500: <message>"` — a URL and
a status code shown to a person who wants to know what to do next.

**Introduce a structured error shape** and render it consistently. Server errors become:

```ts
interface AppError {
  message: string;        // what went wrong, in plain language
  cause?: string;         // the underlying detail, collapsed by default
  remedy?: {
    text: string;         // what to do about it
    action?: { label: string; kind: "retry" | "open-settings" | "open-library" | "copy" | "link"; payload?: string };
  };
}
```

and a shared `<ErrorPanel error={...} />` component renders the message prominently, the remedy
beneath it, an action button when there is one, and the raw cause behind a `<details>` disclosure
for when the user needs to paste it somewhere.

Concrete mappings worth shipping — each of these is a real error the app can produce today:

| Situation | Today | Should say |
| --- | --- | --- |
| chdman missing | `chdman is not available.` | "chdman isn't installed — it's required for disc conversions." Remedy: `brew install rom-tools` in a copyable code block, plus a **Re-check tools** button that calls the refreshed `/api/tools` from §2.2. |
| DolphinTool missing | `DolphinTool is not available — run npm install…` | Same pattern, plus a **Copy as-is instead** action, since a plain copy is a genuinely acceptable fallback for GC/Wii. |
| Destination file exists | `A file already exists at <path> — remove or rename it first.` | "*Smuggler's Run (USA).chd* is already on ROMSCARD." Remedy: **Replace** / **Skip**, wired to §4.3 — the user should never have to leave the app to resolve this. |
| Out of free space | `Not enough free space for this job (~2400 MB estimated, ~800 MB available…)` | Keep the numbers, add: **View library** (§4.4) to find something to delete, and name the largest few files on the card as candidates. |
| Target not writable | `ROMSCARD is not writable.` | "macOS mounted ROMSCARD read-only." Remedy: eject and reconnect, or check the card's physical write-lock switch. |
| Archive needs manual review | `Archive contains 7 files with no single ROM or disc set — needs manual review` | List the entries found and let the user pick which one is the ROM, instead of dead-ending. |
| Network/API failure | `/api/plan -> 500: …` | "Couldn't reach the ROM Manager server." Remedy: **Retry** button; the URL and status go in the collapsed cause. |

Failed **jobs** deserve the same treatment: the Queue row's `⚠ {job.error}` should be an
`ErrorPanel` with a **Retry** button (re-enqueue the same planned job) and, where the failure was
a missing tool, the same install remedy. A failed conversion the user cannot retry without
re-dropping the file is the most frustrating state in the app.

### 5.2 The app is not responsive at all

Both the Review table (7 columns, containing two `<select>`s and a path) and the Queue table
overflow on any window narrower than roughly 1100 px, with no horizontal scroll container — the
page body scrolls sideways instead.

**Fix:**
- Wrap every table in `<div class="table-scroll">` with `overflow-x: auto`, so wide content
  scrolls inside its own region rather than breaking the page.
- Below ~900 px, switch the Review and Queue tables to a stacked card-per-row layout: filename
  as the heading, and label/value pairs beneath. Each row is an independent unit of work, which
  maps cleanly to a card.
- Truncate long destination paths from the *left* (`direction: rtl` with `text-overflow: ellipsis`,
  or a JS middle-truncate) — the filename at the end is the informative part, not `/Volumes/…`.

### 5.3 Progress is honest but not legible

- The Queue progress bar is a bare `scaleX` track with the percentage in small muted text. Show
  the phase (`converting`, `verifying`, `hashing`) as a first-class label, and add an elapsed
  time; for chdman, the file-growth poll makes a rough ETA feasible once ~10 % is done.
- The whole-queue picture is missing: an aggregate bar at the top ("3 of 12 done · ~14 min
  remaining · 4.2 GB written") is what a user actually watches during a long batch.
- `useSlowFlag`'s "still working" escalation ([web/src/useSlowFlag.ts](web/src/useSlowFlag.ts))
  is a good idea that only exists on Drop and Review. Once §2.1's caching lands, plan times drop
  enough that the escalation becomes rare — keep it, but extend the same treatment to the
  library scan.

### 5.4 Smaller items, roughly in value order

- **Destructive actions need confirmation.** Library delete and Review "Replace" both destroy
  data. Name the file in the confirmation; do not use a bare `window.confirm`.
- **`aria-live="polite"` on error and status regions**, so a screen reader announces a failure
  that appears without a navigation. Currently nothing is announced.
- **Drag-and-drop flicker.** `DropPage`'s `onDragLeave` fires when the pointer crosses a child
  element, so the highlight strobes. Use a depth counter incremented on `dragenter` and
  decremented on `dragleave`.
- **Empty states should point somewhere.** "Nothing queued yet." is a dead end; "Drop files
  above, or add one by path" is not. Each of Drop, Review, Queue, and the new Library page needs
  one.
- **Warnings need severity.** Every plan warning renders identically as `⚠ text`, whether it is
  "low-confidence match" (informational) or "not enough free space" (blocking). Split into
  `info` / `warning` / `blocker`, colour accordingly, and sort blockers first.
- **Keyboard support on the file picker.** `.file-picker-button` is a `<label>` wrapping a
  hidden `<input type="file">` — it is not reachable by Tab and has no focus ring.
- **Show the detection evidence on demand, not always.** The Review table prints the full
  evidence string under every System dropdown, which is the widest column's worth of text for
  something the user reads once. Collapse to a confidence badge with the evidence in a tooltip
  or expander.
- **Persist the selected target.** `DropPage` defaults to `targets[0]` on every load; someone
  with two volumes mounted re-picks every time. Store the last used target in config.

---

## 6. Suggested order of work

1. **§3.1** bind to localhost — one line, closes a real exposure.
2. **§1.4** config backfill, **§1.1** per-file plan errors, **§1.5** upload cleanup — small,
   independent robustness fixes that stop whole-batch failures.
3. **§2.2** memoize `detectTools`, **§2.1** archive detection (single-entry extraction +
   detection cache + single-row re-plan) — the largest measurable speedups, and they make the
   Review page pleasant to use before any new UI is built on it.
4. **§1.2** per-job `.part` paths and destination claiming — do this before §4, since Replace
   depends on a sound destination-write path.
5. **§2.3** `library.jsonl` — a prerequisite for §4's index.
6. **§4** Library page and duplicate matching, server first (index → matches → routes), then the
   Review Status column, then the Library tab.
7. **§5.1** the structured error/remedy pass, informed by the real errors §4 introduces.
8. **§5.2 / §5.3** the responsive and progress work.
9. **§1.3** folder-derived `.m3u`, **§1.6** inner-content hashing, **§2.4–2.7**, **§3.2–3.5** —
   independent cleanups, any order.

Each numbered item should land with a test that fails before the fix. The suite runs real
`chdman`/`7zz` conversions against scratch directories and skips gracefully when the tools are
absent — follow that existing pattern in
[server/jobs/queue.test.ts](server/jobs/queue.test.ts) rather than mocking the tools.

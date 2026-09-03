import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  createReadStream,
  createWriteStream,
  renameSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import type { PlannedJob } from "../library/plan.js";
import { createChd, verifyChd } from "../convert/chdman.js";
import { convertToRvz } from "../convert/dolphin.js";
import { createZip, extractArchiveAsync } from "../convert/sevenzip.js";
import { generateCueForBin } from "../convert/cuegen.js";
import { CancelledError } from "../convert/errors.js";
import { groupForM3u, m3uFilenameFor, m3uContent } from "../convert/m3u.js";
import { parseCueFile, parseGdiFile, resolveCcdCompanions } from "../detect/cuesheet.js";
import { getFreeBytes } from "../library/targets.js";
import { isPathInside, estimateOutputBytes } from "../library/fsutil.js";
import { threadsPerJob } from "../library/cpuBudget.js";
import { hashFile, hashArchiveEntry, type FileHashes } from "../library/hash.js";
import { appendLibraryRecord } from "../library/libraryLog.js";
import type { DatIndex } from "../library/dat.js";
import { listArchiveEntries } from "../detect/archive.js";
import { STAGING_DIR } from "../lib/paths.js";
import type { Job } from "./types.js";

export interface ToolPaths {
  chdmanPath: string | null;
  sevenZipPath: string | null;
  dolphinToolPath: string | null;
}

const ARCHIVE_EXTS = [".zip", ".7z", ".rar"];
/** How many finished jobs the Queue list keeps before dropping the oldest (see trimHistory). */
const MAX_RETAINED_FINISHED_JOBS = 200;
const CUE_LIKE_EXTS = [".cue", ".gdi", ".ccd"];

function findFirstMatch(dir: string, exts: string[]): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const ext of exts) {
    const match = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(ext));
    if (match) return path.join(dir, match.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = findFirstMatch(path.join(dir, entry.name), exts);
      if (nested) return nested;
    }
  }
  return null;
}

function findFirstFile(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile());
  if (file) return path.join(dir, file.name);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = findFirstFile(path.join(dir, entry.name));
      if (nested) return nested;
    }
  }
  return null;
}

export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private running = new Set<string>();
  private processes = new Map<string, ChildProcess>();
  private cancelRequested = new Set<string>();
  private reservedBytes = new Map<string, number>();
  /**
   * Destination paths spoken for by a queued or running job. Two jobs writing the
   * same destination would otherwise both pass the existsSync check at the top of
   * runJob — it runs before a conversion that takes minutes — and then race each
   * other's rename, silently leaving only the later result behind.
   */
  private claimedDestinations = new Set<string>();
  /**
   * Serializes the post-completion hashing pass. Hashing reads the whole source file,
   * so N jobs finishing together would otherwise start N multi-gigabyte reads at once,
   * competing for the same disk as the N conversions that just took their run slots.
   * The work is I/O-bound, so running it one at a time costs almost no throughput and
   * keeps the bandwidth where the user can see it.
   */
  private hashChain: Promise<void> = Promise.resolve();

  constructor(
    private getMaxConcurrent: () => number,
    private getVerifyEnabled: () => boolean,
    private getTools: () => ToolPaths,
    private getDeleteSourceAfterSuccess: () => boolean = () => false,
    private getReservedCores: () => number = () => 0,
    private datIndex: DatIndex = { lookup: () => null, datFileCount: 0, romCount: 0 },
  ) {
    super();
    // /api/jobs/events registers one "update" listener per open connection, so the
    // default cap of 10 turns an eleventh browser tab into a spurious memory-leak
    // warning. They're all legitimate, and they're removed on disconnect.
    this.setMaxListeners(0);
  }

  /**
   * Per-job thread cap, so N concurrent conversions never collectively use
   * more than (available cores - reservedCores). Uses the current running
   * count (which includes this job, since it's called from inside runJob)
   * so a single job left running alone gets the full remaining budget.
   */
  private currentThreadBudget(): number {
    return threadsPerJob(Math.max(1, this.running.size), this.getReservedCores());
  }

  list(): Job[] {
    return this.order.map((id) => ({ ...this.jobs.get(id)! }));
  }

  /**
   * Forgets every finished job, returning how many were dropped. The Queue page is a
   * view of current work, not an archive — the durable record of what was processed
   * is data/library.jsonl. Jobs still queued or running are left alone.
   */
  clearCompleted(): number {
    const terminal = new Set(["done", "failed", "cancelled"]);
    const keep = this.order.filter((id) => !terminal.has(this.jobs.get(id)!.state));
    const removed = this.order.length - keep.length;

    const kept = new Set(keep);
    for (const id of this.order) {
      if (!kept.has(id)) this.jobs.delete(id);
    }
    this.order = keep;
    return removed;
  }

  /**
   * Caps retained finished jobs, oldest first, so a long session's Queue list can't
   * grow without bound. Only ever drops terminal jobs.
   */
  private trimHistory(): void {
    const terminal = new Set(["done", "failed", "cancelled"]);
    const finished = this.order.filter((id) => terminal.has(this.jobs.get(id)!.state));
    if (finished.length <= MAX_RETAINED_FINISHED_JOBS) return;

    const drop = new Set(finished.slice(0, finished.length - MAX_RETAINED_FINISHED_JOBS));
    for (const id of drop) this.jobs.delete(id);
    this.order = this.order.filter((id) => !drop.has(id));
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  enqueue(planned: PlannedJob): Job {
    if (!planned.selectedSystemId || !planned.action || !planned.destinationFolder || !planned.destinationFilename) {
      throw new Error(`Cannot enqueue ${planned.sourceName}: system, action, or destination is unresolved.`);
    }

    const destinationPath = path.join(planned.destinationFolder, planned.destinationFilename);
    if (this.claimedDestinations.has(destinationPath)) {
      throw new Error(
        `Another queued job is already writing to ${destinationPath}. Remove one of them, or rename it, before processing.`,
      );
    }

    const id = randomUUID();
    const job: Job = {
      id,
      sourcePath: planned.sourcePath,
      sourceName: planned.sourceName,
      sourceBytes: planned.sourceBytes,
      selectedSystemId: planned.selectedSystemId,
      action: planned.action,
      destinationFolder: planned.destinationFolder,
      destinationFilename: planned.destinationFilename,
      destinationPath,
      replace: planned.replace,
      replaced: null,
      state: "queued",
      percent: 0,
      phase: "queued",
      error: null,
      resultBytes: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      m3uWritten: null,
      datMatch: null,
    };

    this.jobs.set(id, job);
    this.order.push(id);
    this.claimedDestinations.add(destinationPath);
    this.emitUpdate(job);
    this.pump();
    return { ...job };
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.state === "queued") {
      job.state = "cancelled";
      job.finishedAt = new Date().toISOString();
      // This job never reaches runJob, so its destination claim is released here
      // instead — otherwise the path would stay blocked for the rest of the session.
      this.claimedDestinations.delete(job.destinationPath);
      this.emitUpdate(job);
      return true;
    }
    if (job.state === "running") {
      this.cancelRequested.add(id);
      this.processes.get(id)?.kill("SIGTERM");
      return true;
    }
    return false;
  }

  private emitUpdate(job: Job) {
    this.emit("update", { ...job });
  }

  /** Re-checks whether more queued jobs can start now — call after raising maxConcurrentJobs, since nothing else re-triggers this on its own. */
  recheckCapacity(): void {
    this.pump();
  }

  private pump() {
    const max = Math.max(1, this.getMaxConcurrent());
    while (this.running.size < max) {
      const nextId = this.order.find((id) => this.jobs.get(id)!.state === "queued");
      if (!nextId) break;
      this.running.add(nextId);
      this.runJob(nextId).finally(() => {
        this.running.delete(nextId);
        const finished = this.jobs.get(nextId);
        if (finished?.state === "done") this.maybeWriteM3u([finished.destinationFolder]);
        this.trimHistory();
        this.pump();
      });
    }
  }

  /** DVDs have no CD-style track structure, so a cue sheet's referenced data file is used directly rather than the cue sheet itself. */
  private resolveCueToDataFile(cueLikePath: string): string {
    const ext = path.extname(cueLikePath).toLowerCase();
    const discSet =
      ext === ".ccd"
        ? resolveCcdCompanions(cueLikePath)
        : ext === ".cue"
          ? parseCueFile(cueLikePath, readFileSync(cueLikePath, "utf-8"))
          : parseGdiFile(cueLikePath, readFileSync(cueLikePath, "utf-8"));
    if (discSet.trackFiles.length === 0) {
      throw new Error(`No referenced track file found in ${path.basename(cueLikePath)}.`);
    }
    return discSet.trackFiles[0];
  }

  /**
   * Resolves the source down to its actual disc-image bytes, independent of job.action — the
   * createcd-vs-createdvd decision (including the CD-sector-alignment safety net in runJob)
   * needs the real data file's size regardless of which mode was originally planned, and must
   * not have already discarded a cue sheet's track/mode metadata before that decision is made.
   * `dataPath` is the raw data file (for size checks, and the only valid createdvd input);
   * `cuePath`, when present, is what createcd should prefer — feeding it a bare data file
   * instead forces chdman to guess a single MODE1/2352 track from raw bytes, which silently
   * discards any real multi-track/mode structure a genuine multi-track disc has.
   */
  private async resolveDiscSource(
    job: Job,
    tools: ToolPaths,
    discImageExts: string[],
  ): Promise<{ dataPath: string; cuePath: string | null; cleanupDir: string | null }> {
    const ext = path.extname(job.sourcePath).toLowerCase();

    if (discImageExts.includes(ext)) {
      return { dataPath: job.sourcePath, cuePath: null, cleanupDir: null };
    }

    if (CUE_LIKE_EXTS.includes(ext)) {
      return { dataPath: this.resolveCueToDataFile(job.sourcePath), cuePath: job.sourcePath, cleanupDir: null };
    }

    if (ext === ".bin") {
      return { dataPath: job.sourcePath, cuePath: null, cleanupDir: null };
    }

    if (ARCHIVE_EXTS.includes(ext)) {
      if (!tools.sevenZipPath) throw new Error("7zz is not available to extract this archive.");
      const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-convert-"));
      await extractArchiveAsync(tools.sevenZipPath, job.sourcePath, dir, {
        registerProcess: (child) => this.processes.set(job.id, child),
      });
      const wantedExts = [...CUE_LIKE_EXTS, ...discImageExts];
      const found = findFirstMatch(dir, wantedExts);
      if (!found) {
        throw new Error(
          `This archive doesn't contain a file this action knows how to use — looked for ${wantedExts.join(", ")} anywhere inside it. ` +
            `If the game is in there under a different extension, extract it yourself and add that file directly, or pick a different action.`,
        );
      }
      if (CUE_LIKE_EXTS.includes(path.extname(found).toLowerCase())) {
        return { dataPath: this.resolveCueToDataFile(found), cuePath: found, cleanupDir: dir };
      }
      return { dataPath: found, cuePath: null, cleanupDir: dir };
    }

    throw new Error(
      `This action doesn't know how to use a "${ext}" file — it expects a disc image (${discImageExts.join(", ")}), ` +
        `a cue sheet (${CUE_LIKE_EXTS.join(", ")}), a bare .bin, or an archive (${ARCHIVE_EXTS.join(", ")}) containing one of those. ` +
        `Pick a different action for this file, or double-check it's the right one.`,
    );
  }

  private copyPlain(sourcePath: string, destPath: string, onProgress?: (percent: number, phase: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const total = statSync(sourcePath).size;
      let copied = 0;
      const read = createReadStream(sourcePath);
      const write = createWriteStream(destPath);
      read.on("data", (chunk: Buffer | string) => {
        copied += Buffer.byteLength(chunk);
        if (onProgress && total > 0) onProgress((copied / total) * 100, "copying");
      });
      read.on("error", reject);
      write.on("error", reject);
      write.on("finish", () => resolve());
      read.pipe(write);
    });
  }

  private async runKeepZip(job: Job, partPath: string, tools: ToolPaths, onProgress: (percent: number, phase: string) => void): Promise<void> {
    const ext = path.extname(job.sourcePath).toLowerCase();
    const registerProcess = (child: ChildProcess) => this.processes.set(job.id, child);

    if (ext === ".zip") {
      await this.copyPlain(job.sourcePath, partPath, onProgress);
      return;
    }

    if (!tools.sevenZipPath) throw new Error("7zz is not available to create a zip.");

    if (ext === ".7z" || ext === ".rar") {
      const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-convert-"));
      try {
        await extractArchiveAsync(tools.sevenZipPath, job.sourcePath, dir, { registerProcess });
        const inner = findFirstFile(dir);
        if (!inner) throw new Error("Archive did not contain a usable file.");
        await createZip(tools.sevenZipPath, inner, partPath, { registerProcess, onProgress, threads: this.currentThreadBudget() });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    await createZip(tools.sevenZipPath, job.sourcePath, partPath, { registerProcess, onProgress, threads: this.currentThreadBudget() });
  }

  private async runJob(id: string): Promise<void> {
    const job = this.jobs.get(id)!;
    job.state = "running";
    job.startedAt = new Date().toISOString();
    job.phase = "preparing";
    this.emitUpdate(job);

    let tmpDir: string | null = null;
    let genCueDir: string | null = null;
    // Scoped to the job id, not just the destination: two jobs aimed at the same
    // destination must never share a scratch file, or they'd interleave their writes
    // into it. enqueue() rejects that collision up front, but a unique name means a
    // stray .part from a killed process can't be picked up by a later job either.
    const partPath = `${job.destinationPath}.${job.id}.part`;

    try {
      if (this.cancelRequested.has(id)) throw new CancelledError();

      if (existsSync(job.destinationPath) && !job.replace) {
        throw new Error(`A file already exists at ${job.destinationPath} — remove or rename it first.`);
      }

      // With concurrency > 1, a free-space check in isolation could pass for
      // several jobs that collectively overrun the card, since none of them
      // know about the others' in-flight writes. Account for bytes already
      // reserved by other currently-running jobs before deciding this one fits.
      // This whole block is synchronous (no `await`), so it can't race with
      // another job's runJob() — Node won't interleave them mid-check.
      const estimatedBytes = estimateOutputBytes(job.sourceBytes, job.action);
      const freeBytes = getFreeBytes(job.destinationFolder);
      if (freeBytes !== null) {
        let reservedByOthers = 0;
        for (const [otherId, bytes] of this.reservedBytes) {
          if (otherId !== id) reservedByOthers += bytes;
        }
        const effectiveFree = freeBytes - reservedByOthers;
        if (effectiveFree < estimatedBytes + 5 * 1024 * 1024) {
          throw new Error(
            `Not enough free space for this job (~${Math.round(estimatedBytes / 1024 / 1024)} MB estimated, ~${Math.round(effectiveFree / 1024 / 1024)} MB available once other running jobs are accounted for).`,
          );
        }
      }
      this.reservedBytes.set(id, estimatedBytes);

      const tools = this.getTools();
      const registerProcess = (child: ChildProcess) => this.processes.set(id, child);
      const onProgress = (percent: number, phase: string) => {
        job.percent = percent;
        job.phase = phase;
        this.emitUpdate(job);
      };

      switch (job.action) {
        case "chd-cd":
        case "chd-dvd": {
          if (!tools.chdmanPath) throw new Error("chdman is not available.");
          const resolved = await this.resolveDiscSource(job, tools, [".iso", ".chd"]);
          tmpDir = resolved.cleanupDir;

          if (path.extname(resolved.dataPath).toLowerCase() === ".chd") {
            // Already a CHD (bare, or found inside an archive) — nothing to convert, mirrors
            // the same already-in-target-format fast path keep-zip already takes for .zip.
            job.phase = "copying";
            this.emitUpdate(job);
            await this.copyPlain(resolved.dataPath, partPath, onProgress);
            break;
          }

          // plan.ts already prefers createcd for a CD-sector-aligned PS2 source, but that
          // depends on detection having measured the real content size — an archive with more
          // than one entry (e.g. a scene .7z with an .nfo alongside the .iso) currently skips
          // that measurement and falls through to the ps2 default of chd-dvd. Check the actual
          // resolved data file's bytes here too, since that's always accurate regardless of how
          // detection went, so this never fails on a merely mislabeled action.
          let chdMode: "createcd" | "createdvd" = job.action === "chd-cd" ? "createcd" : "createdvd";
          if (chdMode === "createdvd") {
            const dataBytes = statSync(resolved.dataPath).size;
            if (dataBytes > 0 && dataBytes % 2352 === 0 && dataBytes % 2048 !== 0) {
              chdMode = "createcd";
              job.action = "chd-cd"; // keep the Queue page's displayed action truthful
            }
          }

          // createdvd always needs the raw data file — it can't parse a cue sheet at all.
          // createcd should prefer a real cue when resolveDiscSource found one; a bare data
          // file forces chdman to guess a single MODE1/2352 track from raw bytes, which is
          // both unreliable and — confirmed against a real multi-track disc — dramatically
          // slower than giving it the track/mode info it needs up front. Synthesize a cue via
          // the same sector-mode detection generateCueForBin already uses for standalone .bin
          // sources whenever no real cue is available.
          let inputPath = resolved.dataPath;
          if (chdMode === "createcd") {
            if (resolved.cuePath) {
              inputPath = resolved.cuePath;
            } else {
              // chdman resolves a cue's FILE line relative to the .cue's own directory, not
              // cwd (confirmed against a real chdman 0.289 run) — generateCueForBin already
              // accounts for that with a proper path.relative() reference, so cwd here is
              // just a sane default, not load-bearing for resolving the bin reference.
              const gen = generateCueForBin(resolved.dataPath, statSync(resolved.dataPath).size);
              inputPath = gen.cuePath;
              genCueDir = gen.tmpDir;
            }
          }
          const inputDir = path.dirname(inputPath);

          job.phase = "converting";
          this.emitUpdate(job);
          await createChd(tools.chdmanPath, inputPath, partPath, chdMode, {
            onProgress,
            registerProcess,
            cwd: inputDir,
            threads: this.currentThreadBudget(),
            estimatedOutputBytes: estimatedBytes,
          });
          if (this.getVerifyEnabled()) {
            if (this.cancelRequested.has(id)) throw new CancelledError();
            job.phase = "verifying";
            job.percent = 0;
            this.emitUpdate(job);
            await verifyChd(tools.chdmanPath, partPath, { onProgress, registerProcess, cwd: inputDir });
          }
          break;
        }
        case "rvz": {
          const resolved = await this.resolveDiscSource(job, tools, [".iso", ".gcm", ".rvz"]);
          tmpDir = resolved.cleanupDir;

          if (path.extname(resolved.dataPath).toLowerCase() === ".rvz") {
            // Already an RVZ (bare, or found inside an archive) — nothing to convert, mirrors
            // the same already-in-target-format fast path keep-zip already takes for .zip.
            job.phase = "copying";
            this.emitUpdate(job);
            await this.copyPlain(resolved.dataPath, partPath, onProgress);
            break;
          }

          if (!tools.dolphinToolPath) throw new Error("DolphinTool is not available — run `npm install` to fetch the bundled binary.");
          job.phase = "converting";
          this.emitUpdate(job);
          await convertToRvz(tools.dolphinToolPath, resolved.dataPath, partPath, {
            onProgress,
            registerProcess,
            cwd: path.dirname(resolved.dataPath),
          });
          break;
        }
        case "keep-zip": {
          job.phase = "compressing";
          this.emitUpdate(job);
          await this.runKeepZip(job, partPath, tools, onProgress);
          break;
        }
        case "copy": {
          job.phase = "copying";
          this.emitUpdate(job);
          await this.copyPlain(job.sourcePath, partPath, onProgress);
          break;
        }
      }

      this.processes.delete(id);
      if (this.cancelRequested.has(id)) throw new CancelledError();

      // Re-checked here, not just at the top: a conversion takes minutes, and the file
      // could have been put there in the meantime by another tool or a second card
      // insertion. renameSync would overwrite it without a word.
      if (existsSync(job.destinationPath) && !job.replace) {
        throw new Error(`A file appeared at ${job.destinationPath} while this job was running — it was left untouched.`);
      }

      // Replacing is done in this order deliberately: the existing file is moved aside
      // (not deleted) only once the new one is fully converted and sitting in .part, and
      // it's only deleted once the rename into its place has succeeded. A conversion
      // that fails, or a rename that fails, therefore leaves the card exactly as it was.
      let displacedPath: string | null = null;
      if (job.replace && existsSync(job.destinationPath)) {
        displacedPath = `${job.destinationPath}.replaced-${Date.now()}`;
        renameSync(job.destinationPath, displacedPath);
      }

      try {
        renameSync(partPath, job.destinationPath);
      } catch (err) {
        // Put the original back — the user asked to replace it, not to lose it.
        if (displacedPath) {
          try {
            renameSync(displacedPath, job.destinationPath);
          } catch {
            // best effort; the .replaced- file is still on disk either way
          }
        }
        throw err;
      }

      if (displacedPath) {
        try {
          unlinkSync(displacedPath);
          job.replaced = job.destinationFilename;
        } catch {
          // The new file is in place, which is what matters; a leftover .replaced- file
          // is cosmetic, and deleting it is not worth failing a successful job over.
        }
      }
      job.resultBytes = statSync(job.destinationPath).size;
      job.state = "done";
      job.percent = 100;
      job.phase = "done";
      job.finishedAt = new Date().toISOString();
      this.emitUpdate(job);

      // Hashing runs in the background after "done" is already reported, so it never
      // delays completion feedback, freeing the run slot for the next queued job, or the
      // .m3u playlist write — but it must happen before cleanupSource, which may delete
      // the source, so that stays chained onto it rather than running independently.
      // Queued behind any hashing already in flight (see hashChain).
      this.hashChain = this.hashChain.then(async () => {
        job.phase = "hashing";
        this.emitUpdate(job);
        await this.recordLibraryEntry(job);
        this.cleanupSource(job);
        job.phase = "done";
        this.emitUpdate(job);
      }).catch((err) => {
        // recordLibraryEntry and cleanupSource both swallow their own failures, so this
        // only fires if an "update" listener threw. Absorb it regardless: a rejected
        // hashChain would silently stop every later job from being hashed at all.
        console.error("Post-job bookkeeping failed:", err instanceof Error ? err.message : err);
      });
    } catch (err) {
      this.processes.delete(id);
      if (existsSync(partPath)) {
        try {
          unlinkSync(partPath);
        } catch {
          // best effort — a stray .part file is a minor annoyance, not worth failing the error path over
        }
      }
      job.finishedAt = new Date().toISOString();
      if (err instanceof CancelledError || this.cancelRequested.has(id)) {
        job.state = "cancelled";
        job.error = null;
      } else {
        job.state = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      }
      this.emitUpdate(job);
    } finally {
      this.cancelRequested.delete(id);
      this.reservedBytes.delete(id);
      this.claimedDestinations.delete(job.destinationPath);
      for (const dir of [tmpDir, genCueDir]) {
        if (!dir) continue;
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  /**
   * Hashes the original source file, appends a record to data/library.json,
   * and checks it against any loaded DAT files — purely informational, never
   * renames anything (see PLAN.md: v1 keeps original filenames; this is the
   * foundation a future rename command can build on without re-hashing).
   * Best-effort: a hashing failure logs but never fails the job itself.
   */
  /**
   * What to hash for this job: the ROM itself wherever we can reach it, not the
   * container it arrived in.
   *
   * A DAT indexes the ROM inside an archive, so hashing a .zip/.7z produces hashes
   * that can never match — and for cartridge systems the source is almost always
   * archived, which made DAT matching useless exactly where it's most wanted.
   *
   * Only single-entry archives are unwrapped. A multi-entry archive is a disc set
   * (or a scene release with extra files), where there's no one file that stands for
   * the whole thing, so the container's own hash stays the honest answer.
   */
  private hashTargetFor(job: Job): { hashes: Promise<FileHashes>; hashedName: string } {
    const ext = path.extname(job.sourcePath).toLowerCase();
    const sevenZipPath = this.getTools().sevenZipPath;

    if (ARCHIVE_EXTS.includes(ext) && sevenZipPath) {
      try {
        const files = listArchiveEntries(sevenZipPath, job.sourcePath).filter((e) => !e.isDirectory);
        if (files.length === 1) {
          return {
            hashes: hashArchiveEntry(sevenZipPath, job.sourcePath, files[0].name),
            hashedName: files[0].name,
          };
        }
      } catch {
        // Couldn't list the archive — fall through and hash the container.
      }
    }

    return { hashes: hashFile(job.sourcePath), hashedName: job.sourceName };
  }

  private async recordLibraryEntry(job: Job): Promise<void> {
    try {
      const target = this.hashTargetFor(job);
      const hashes = await target.hashes;
      const datMatch = this.datIndex.lookup(hashes);

      appendLibraryRecord({
        timestamp: job.finishedAt ?? new Date().toISOString(),
        originalName: job.sourceName,
        hashes,
        hashedName: target.hashedName,
        system: job.selectedSystemId,
        action: job.action,
        destination: job.destinationPath,
        sizeBefore: job.sourceBytes,
        sizeAfter: job.resultBytes ?? 0,
        datMatch,
      });

      if (datMatch) {
        job.datMatch = datMatch;
        this.emitUpdate(job);
      }
    } catch (err) {
      console.error(`Failed to record library entry for ${job.sourceName}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Removes the source file after a successful write. A staged upload
   * (staging/) is the app's own internal copy — always safe to delete once
   * the destination write succeeds. A path-based source is the user's own
   * file elsewhere on disk, so it's only touched when they've explicitly
   * opted into deleteSourceAfterSuccess.
   */
  private cleanupSource(job: Job): void {
    const isStagedCopy = isPathInside(job.sourcePath, STAGING_DIR);
    if (!isStagedCopy && !this.getDeleteSourceAfterSuccess()) return;
    try {
      unlinkSync(job.sourcePath);
      if (isStagedCopy) {
        // Each upload gets its own UUID subdirectory (see stagedUploadPath) — remove it
        // too now that it's empty. rmdirSync only succeeds on an empty directory, so
        // this is a safe no-op for anything else (including pre-existing flat-layout
        // staged files, whose parent is STAGING_DIR itself and is never removed here).
        const parentDir = path.dirname(job.sourcePath);
        if (parentDir !== STAGING_DIR) rmdirSync(parentDir);
      }
    } catch {
      // best effort — a leftover source file or directory is harmless
    }
  }

  /**
   * Writes/refreshes .m3u playlists for any multi-disc group the destination folder
   * actually contains. Idempotent — safe to call after every job.
   *
   * Built from the folder's real contents rather than this session's job list. The
   * job list is empty after every restart, so adding Disc 2 in a later session than
   * Disc 1 previously produced no playlist at all (groupForM3u needs two discs to
   * emit a group) and gave the user no sign it had been skipped. Reading the folder
   * also picks up discs put there by any other tool.
   *
   * Scoped to the folders the just-finished jobs wrote to, so this doesn't rescan
   * every destination on the card after every single job.
   */
  private maybeWriteM3u(folders: Iterable<string>) {
    for (const folder of new Set(folders)) {
      let filenames: string[];
      try {
        filenames = readdirSync(folder, { withFileTypes: true })
          .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && !entry.name.toLowerCase().endsWith(".m3u"))
          .map((entry) => entry.name);
      } catch {
        continue; // folder unreadable or gone (card pulled) — nothing to write
      }

      const groups = groupForM3u(filenames.map((filename) => ({ folder, filename })));

      for (const [key, group] of groups) {
        if (group.discs.length < 2) continue;
        const m3uPath = path.join(group.folder, m3uFilenameFor(key));
        try {
          writeFileSync(m3uPath, m3uContent(group.discs), "utf-8");
        } catch {
          // Non-fatal — the individual disc files are already written correctly either way.
          continue;
        }
        // Reflect the playlist on any of this session's jobs that are part of it, so
        // the Queue page can say so. Jobs from earlier sessions simply aren't here.
        for (const id of this.order) {
          const job = this.jobs.get(id)!;
          if (job.state === "done" && job.destinationFolder === group.folder && group.discs.some((d) => d.filename === job.destinationFilename)) {
            job.m3uWritten = m3uPath;
          }
        }
      }
    }
  }
}

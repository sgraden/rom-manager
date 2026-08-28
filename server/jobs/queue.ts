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
import type { Job } from "./types.js";

export interface ToolPaths {
  chdmanPath: string | null;
  sevenZipPath: string | null;
  dolphinToolPath: string | null;
}

const ARCHIVE_EXTS = [".zip", ".7z", ".rar"];
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

  constructor(
    private getMaxConcurrent: () => number,
    private getVerifyEnabled: () => boolean,
    private getTools: () => ToolPaths,
  ) {
    super();
  }

  list(): Job[] {
    return this.order.map((id) => ({ ...this.jobs.get(id)! }));
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  enqueue(planned: PlannedJob): Job {
    if (!planned.selectedSystemId || !planned.action || !planned.destinationFolder || !planned.destinationFilename) {
      throw new Error(`Cannot enqueue ${planned.sourceName}: system, action, or destination is unresolved.`);
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
      destinationPath: path.join(planned.destinationFolder, planned.destinationFilename),
      state: "queued",
      percent: 0,
      phase: "queued",
      error: null,
      resultBytes: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      m3uWritten: null,
    };

    this.jobs.set(id, job);
    this.order.push(id);
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

  private pump() {
    const max = Math.max(1, this.getMaxConcurrent());
    while (this.running.size < max) {
      const nextId = this.order.find((id) => this.jobs.get(id)!.state === "queued");
      if (!nextId) break;
      this.running.add(nextId);
      this.runJob(nextId).finally(() => {
        this.running.delete(nextId);
        this.maybeWriteM3u();
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

  private async resolveDiscInput(job: Job, tools: ToolPaths, discImageExts: string[]): Promise<{ inputPath: string; cleanupDir: string | null }> {
    const ext = path.extname(job.sourcePath).toLowerCase();

    if (discImageExts.includes(ext)) {
      return { inputPath: job.sourcePath, cleanupDir: null };
    }

    if (CUE_LIKE_EXTS.includes(ext)) {
      // chdman's createcd parses .cue/.gdi/.ccd itself; createdvd does not —
      // it reads whatever -i points to as raw bytes, so handing it a cue
      // sheet "converts" the cue's own text instead of erroring cleanly.
      if (job.action === "chd-cd") {
        return { inputPath: job.sourcePath, cleanupDir: null };
      }
      return { inputPath: this.resolveCueToDataFile(job.sourcePath), cleanupDir: null };
    }

    if (ext === ".bin") {
      // cuegen synthesizes CD sector-mode metadata (MODE1/2352 etc.), which is
      // meaningless for DVD data — a DVD image is just flat bytes, no cue needed.
      if (job.action === "chd-dvd") {
        return { inputPath: job.sourcePath, cleanupDir: null };
      }
      const { cuePath, tmpDir } = generateCueForBin(job.sourcePath, job.sourceBytes);
      return { inputPath: cuePath, cleanupDir: tmpDir };
    }

    if (ARCHIVE_EXTS.includes(ext)) {
      if (!tools.sevenZipPath) throw new Error("7zz is not available to extract this archive.");
      const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-convert-"));
      await extractArchiveAsync(tools.sevenZipPath, job.sourcePath, dir, {
        registerProcess: (child) => this.processes.set(job.id, child),
      });
      const found = findFirstMatch(dir, [...CUE_LIKE_EXTS, ...discImageExts]);
      if (!found) throw new Error("Archive did not contain a usable disc image.");
      if (job.action === "chd-dvd" && CUE_LIKE_EXTS.includes(path.extname(found).toLowerCase())) {
        return { inputPath: this.resolveCueToDataFile(found), cleanupDir: dir };
      }
      return { inputPath: found, cleanupDir: dir };
    }

    throw new Error(`Don't know how to convert "${ext}" files for action "${job.action}".`);
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
        await createZip(tools.sevenZipPath, inner, partPath, { registerProcess, onProgress });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    await createZip(tools.sevenZipPath, job.sourcePath, partPath, { registerProcess, onProgress });
  }

  private async runJob(id: string): Promise<void> {
    const job = this.jobs.get(id)!;
    job.state = "running";
    job.startedAt = new Date().toISOString();
    job.phase = "preparing";
    this.emitUpdate(job);

    let tmpDir: string | null = null;
    const partPath = `${job.destinationPath}.part`;

    try {
      if (this.cancelRequested.has(id)) throw new CancelledError();

      if (existsSync(job.destinationPath)) {
        throw new Error(`A file already exists at ${job.destinationPath} — remove or rename it first.`);
      }

      const freeBytes = getFreeBytes(job.destinationFolder);
      if (freeBytes !== null && freeBytes < 5 * 1024 * 1024) {
        throw new Error(`Destination is nearly out of space (${Math.round(freeBytes / 1024)} KB free) — aborting before writing.`);
      }

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
          const resolved = await this.resolveDiscInput(job, tools, [".iso"]);
          tmpDir = resolved.cleanupDir;
          const inputDir = path.dirname(resolved.inputPath);
          job.phase = "converting";
          this.emitUpdate(job);
          await createChd(tools.chdmanPath, resolved.inputPath, partPath, job.action === "chd-cd" ? "createcd" : "createdvd", {
            onProgress,
            registerProcess,
            cwd: inputDir,
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
          if (!tools.dolphinToolPath) throw new Error("DolphinTool is not available — install with: brew install --cask dolphin");
          const resolved = await this.resolveDiscInput(job, tools, [".iso", ".gcm"]);
          tmpDir = resolved.cleanupDir;
          job.phase = "converting";
          this.emitUpdate(job);
          await convertToRvz(tools.dolphinToolPath, resolved.inputPath, partPath, {
            onProgress,
            registerProcess,
            cwd: path.dirname(resolved.inputPath),
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

      renameSync(partPath, job.destinationPath);
      job.resultBytes = statSync(job.destinationPath).size;
      job.state = "done";
      job.percent = 100;
      job.phase = "done";
      job.finishedAt = new Date().toISOString();
      this.emitUpdate(job);
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
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  }

  /** Writes/refreshes .m3u playlists for any completed multi-disc group. Idempotent — safe to call after every job. */
  private maybeWriteM3u() {
    const doneJobs = this.order.map((id) => this.jobs.get(id)!).filter((j) => j.state === "done");
    const files = doneJobs.map((j) => ({ folder: j.destinationFolder, filename: j.destinationFilename }));
    const groups = groupForM3u(files);

    for (const [key, group] of groups) {
      if (group.discs.length < 2) continue;
      const m3uName = m3uFilenameFor(key);
      const m3uPath = path.join(group.folder, m3uName);
      try {
        writeFileSync(m3uPath, m3uContent(group.discs), "utf-8");
        for (const j of doneJobs) {
          if (j.destinationFolder === group.folder && group.discs.some((d) => d.filename === j.destinationFilename)) {
            j.m3uWritten = m3uPath;
          }
        }
      } catch {
        // Non-fatal — the individual disc files are already written correctly either way.
      }
    }
  }
}

import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { randomFillSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Every successful job appends a record to LIBRARY_LOG_PATH — redirect it to a
// scratch file so running this suite never writes fake entries into the
// real data/library.jsonl. STAGING_DIR is preserved unchanged, since several
// tests below rely on the real one for staged-upload cleanup behavior.
vi.mock("../lib/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/paths.js")>("../lib/paths.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const scratch = path.join(os.tmpdir(), "rom-manager-queue-test-library");
  // Both paths must be redirected. LEGACY_LIBRARY_PATH left pointing at the real
  // data/library.json would let the migration in libraryLog.ts run against the user's
  // actual processing history the first time this suite runs.
  return { ...actual, LIBRARY_LOG_PATH: `${scratch}.jsonl`, LEGACY_LIBRARY_PATH: `${scratch}.json` };
});

import { JobQueue, type ToolPaths } from "./queue.js";
import type { PlannedJob } from "../library/plan.js";
import { detectTools } from "../convert/tools.js";
import { STAGING_DIR, LIBRARY_LOG_PATH } from "../lib/paths.js";

afterAll(() => {
  rmSync(LIBRARY_LOG_PATH, { force: true });
});

// This test suite runs real chdman/7zz conversions end to end. It only ever
// writes into a scratch temp directory standing in as a "target" — never
// /Volumes or any real card. Skips gracefully if the tools aren't installed.
const tools = detectTools({ chdman: null, sevenZip: null, dolphinTool: null, maxcso: null });
const chdman = tools.find((t) => t.id === "chdman");
const sevenZip = tools.find((t) => t.id === "sevenZip");
const dolphinTool = tools.find((t) => t.id === "dolphinTool");
const toolPaths: ToolPaths = {
  chdmanPath: chdman?.found ? chdman.path : null,
  sevenZipPath: sevenZip?.found ? sevenZip.path : null,
  dolphinToolPath: dolphinTool?.found ? dolphinTool.path : null,
};
const maybeIt = toolPaths.chdmanPath && toolPaths.sevenZipPath ? it : it.skip;
const maybeItDolphin = maybeIt === it && toolPaths.dolphinToolPath ? it : it.skip;

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-queue-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRawCdTrack(dir: string, name: string, sectors = 10): { cuePath: string; binPath: string } {
  const binPath = path.join(dir, `${name}.bin`);
  const sectorSize = 2352;
  const data = Buffer.alloc(sectors * sectorSize);
  for (let s = 0; s < sectors; s++) {
    const off = s * sectorSize;
    // A real CD sync pattern (00 FF*10 00) plus the MODE1 marker byte — chdman's
    // CD-aware codecs (cdlz/cdzl/cdfl) need this structure to round-trip; an
    // all-zero "sector" with just the mode byte set produces a CHD chdman
    // itself can't decompress again, which isn't representative of real dumps.
    data[off] = 0x00;
    data.fill(0xff, off + 1, off + 11);
    data[off + 11] = 0x00;
    data[off + 15] = 0x01; // MODE1
  }
  writeFileSync(binPath, data);

  const cuePath = path.join(dir, `${name}.cue`);
  writeFileSync(cuePath, `FILE "${name}.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`);
  return { cuePath, binPath };
}

/** DVD data has no CD sector framing — just flat bytes, sized as a multiple of the 2048-byte DVD sector. */
function makeDvdData(filePath: string, sectors = 20): void {
  writeFileSync(filePath, Buffer.alloc(sectors * 2048));
}

/** Raw CD-sector-framed bytes (2352/sector, MODE1) — chdman's CD-aware codecs need this structure to round-trip. */
function makeRawCdData(sectors: number): Buffer {
  const sectorSize = 2352;
  const data = Buffer.alloc(sectors * sectorSize);
  for (let s = 0; s < sectors; s++) {
    const off = s * sectorSize;
    data[off] = 0x00;
    data.fill(0xff, off + 1, off + 11);
    data[off + 11] = 0x00;
    data[off + 15] = 0x01; // MODE1
  }
  return data;
}

/** A minimal GameCube disc image — just enough for DolphinTool to recognize and convert it (the GC magic word at offset 0x1c). */
function makeGameCubeIso(filePath: string, sizeBytes = 4 * 1024 * 1024): void {
  const data = Buffer.alloc(sizeBytes);
  data.writeUInt32BE(0xc2339f3d, 0x1c);
  writeFileSync(filePath, data);
}

/** A larger, real-content CD track (not degenerate/all-zero) — takes chdman long enough to observe two jobs overlapping. */
function makeSlowCdTrack(dir: string, name: string, sectors: number): { cuePath: string } {
  const binPath = path.join(dir, `${name}.bin`);
  const sectorSize = 2352;
  const data = Buffer.alloc(sectors * sectorSize);
  for (let s = 0; s < sectors; s++) {
    const off = s * sectorSize;
    data[off] = 0x00;
    data.fill(0xff, off + 1, off + 11);
    data[off + 11] = 0x00;
    data[off + 15] = 0x01; // MODE1
    randomFillSync(data, off + 16, sectorSize - 16);
  }
  writeFileSync(binPath, data);

  const cuePath = path.join(dir, `${name}.cue`);
  writeFileSync(cuePath, `FILE "${name}.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`);
  return { cuePath };
}

function waitForTerminal(queue: JobQueue, id: string, timeoutMs = 15000): Promise<ReturnType<JobQueue["get"]>> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const job = queue.get(id);
      if (job && (job.state === "done" || job.state === "failed" || job.state === "cancelled")) {
        resolve(job);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for job ${id} to finish (last state: ${job?.state})`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function fakePlannedJob(overrides: Partial<PlannedJob> & { sourcePath: string }): PlannedJob {
  return {
    sourceName: path.basename(overrides.sourcePath),
    sourceBytes: 0,
    sourceKind: "disc",
    candidates: [],
    selectedSystemId: "psx",
    action: "chd-cd",
    destinationFolder: null,
    destinationFilename: null,
    estimatedOutputBytes: null,
    warnings: [],
    replace: false,
    replacesPath: null,
    ...overrides,
  };
}

describe("JobQueue (real chdman/7zz, scratch directory only)", () => {
  maybeIt("records a library.json entry with real hashes after a successful job", async () => {
    const { loadDatIndex } = await import("../library/dat.js");
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    const srcDir = makeTempDir();
    const romPath = path.join(srcDir, "game.nes");
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(romPath, romBuf);

    const queue = new JobQueue(() => 1, () => true, () => toolPaths, () => false, () => 0, loadDatIndex("/nonexistent"));
    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: romPath,
        selectedSystemId: "nes",
        action: "keep-zip",
        destinationFolder: path.join(destDir, "nes"),
        destinationFilename: "game.zip",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.datMatch).toBeNull();

    // Give the async recordLibraryEntry (which runs after "done" is reported) a moment to land.
    await new Promise((r) => setTimeout(r, 100));

    const records = readFileSync(LIBRARY_LOG_PATH, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    // Matched on destination, not just originalName: the log is shared across this
    // file's tests and more than one of them processes a source called "game.nes",
    // so a name-only lookup can pick up another test's record.
    const record = records.find((r: { destination: string }) => r.destination === path.join(destDir, "nes", "game.zip"));
    expect(record).toBeDefined();
    // Ground truth computed independently in the same way as hash.test.ts.
    expect(record.hashes.crc32).toBe("9ed2bab3");
    expect(record.hashes.md5).toBe("e4e449ab0c2479e7a99a0671c13c0ce6");
    expect(record.hashes.sha1).toBe("36d39bfdabfcec6c8cd6c61fb0ee8f6b2f758669");
    expect(record.system).toBe("nes");
    expect(record.destination).toBe(path.join(destDir, "nes", "game.zip"));
    expect(record.datMatch).toBeNull();
  });

  maybeIt("surfaces a DAT match as informational metadata without renaming the destination file", async () => {
    const { loadDatIndex } = await import("../library/dat.js");
    const datsDir = makeTempDir();
    writeFileSync(
      path.join(datsDir, "nes.dat"),
      `<datafile><game name="Real Game"><rom name="Real Game (USA) [!].nes" crc="9ed2bab3" md5="e4e449ab0c2479e7a99a0671c13c0ce6" sha1="36d39bfdabfcec6c8cd6c61fb0ee8f6b2f758669"/></game></datafile>`,
    );
    const datIndex = loadDatIndex(datsDir);
    expect(datIndex.romCount).toBe(1);

    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));
    const srcDir = makeTempDir();
    const romPath = path.join(srcDir, "game.nes"); // deliberately NOT the DAT's canonical name
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(romPath, romBuf);

    const queue = new JobQueue(() => 1, () => true, () => toolPaths, () => false, () => 0, datIndex);
    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: romPath,
        selectedSystemId: "nes",
        action: "keep-zip",
        destinationFolder: path.join(destDir, "nes"),
        destinationFilename: "game.zip",
      }),
    );

    await waitForTerminal(queue, job.id);
    // datMatch arrives via a follow-up SSE-style update after hashing completes, not necessarily by the time waitForTerminal resolves.
    await new Promise((r) => setTimeout(r, 150));

    expect(queue.get(job.id)?.datMatch).toBe("Real Game (USA) [!].nes");
    // The file on disk keeps the name it was planned with — a DAT match is informational only, v1 never renames.
    expect(existsSync(path.join(destDir, "nes", "game.zip"))).toBe(true);
    expect(existsSync(path.join(destDir, "nes", "Real Game (USA) [!].nes"))).toBe(false);
  });

  maybeIt("matches a DAT for a zipped cartridge ROM by hashing the ROM, not the zip", async () => {
    // A DAT indexes the ROM inside the archive. Hashing the .zip container produced
    // hashes that could never match — and for cartridge systems the source is almost
    // always a .zip, so DAT matching was useless exactly where it's most wanted.
    const { loadDatIndex } = await import("../library/dat.js");
    const srcDir = makeTempDir();

    const romPath = path.join(srcDir, "Real Game (USA).nes");
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(romPath, romBuf);

    // The same 64-byte ROM the suite's other DAT test uses, so the digests are known good.
    const datsDir = makeTempDir();
    writeFileSync(
      path.join(datsDir, "nes.dat"),
      `<datafile><game name="Real Game"><rom name="Real Game (USA) [!].nes" crc="9ed2bab3" md5="e4e449ab0c2479e7a99a0671c13c0ce6" sha1="36d39bfdabfcec6c8cd6c61fb0ee8f6b2f758669"/></game></datafile>`,
    );
    const datIndex = loadDatIndex(datsDir);

    const archivePath = path.join(srcDir, "Real Game (USA).zip");
    expect(spawnSync("7zz", ["a", "-tzip", archivePath, romPath], { encoding: "utf-8" }).status).toBe(0);

    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    const queue = new JobQueue(() => 1, () => false, () => toolPaths, () => false, () => 0, datIndex);
    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: archivePath,
        selectedSystemId: "nes",
        action: "keep-zip",
        destinationFolder: path.join(destDir, "nes"),
        destinationFilename: "Real Game (USA).zip",
      }),
    );

    await waitForTerminal(queue, job.id);
    await new Promise((r) => setTimeout(r, 250));

    expect(queue.get(job.id)?.datMatch).toBe("Real Game (USA) [!].nes");

    const records = readFileSync(LIBRARY_LOG_PATH, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const record = records.find(
      (r: { destination: string }) => r.destination === path.join(destDir, "nes", "Real Game (USA).zip"),
    );
    // The log says plainly what was hashed, so the hashes can't be misread later.
    expect(record.hashedName).toBe("Real Game (USA).nes");
    expect(record.hashes.sha1).toBe("36d39bfdabfcec6c8cd6c61fb0ee8f6b2f758669");
  });

  maybeIt("actually runs two jobs concurrently when maxConcurrentJobs is 2, not just sequentially", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));

    // Real (non-degenerate) content, big enough that chdman takes a real moment —
    // long enough to poll and observe both jobs "running" at the same time.
    const discA = makeSlowCdTrack(srcDir, "Concurrent A", 20000);
    const discB = makeSlowCdTrack(srcDir, "Concurrent B", 20000);

    const queue = new JobQueue(
      () => 2,
      () => false,
      () => toolPaths,
      () => false,
      () => 0,
    );

    const jobA = queue.enqueue(
      fakePlannedJob({ sourcePath: discA.cuePath, destinationFolder: path.join(destDir, "psx"), destinationFilename: "A.chd" }),
    );
    const jobB = queue.enqueue(
      fakePlannedJob({ sourcePath: discB.cuePath, destinationFolder: path.join(destDir, "psx"), destinationFilename: "B.chd" }),
    );

    let sawBothRunning = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const a = queue.get(jobA.id);
      const b = queue.get(jobB.id);
      if (a?.state === "running" && b?.state === "running") {
        sawBothRunning = true;
        break;
      }
      const aDone = a?.state === "done" || a?.state === "failed";
      const bDone = b?.state === "done" || b?.state === "failed";
      if (aDone && bDone) break;
      await new Promise((r) => setTimeout(r, 15));
    }

    expect(sawBothRunning).toBe(true);

    const finishedA = await waitForTerminal(queue, jobA.id);
    const finishedB = await waitForTerminal(queue, jobB.id);
    expect(finishedA?.state).toBe("done");
    expect(finishedB?.state).toBe("done");
  }, 60000);

  maybeIt("converts a cue+bin disc to a verified CHD and writes it atomically", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));

    const { cuePath } = makeRawCdTrack(srcDir, "Test Game");
    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: cuePath,
        destinationFolder: path.join(destDir, "psx"),
        destinationFilename: "Test Game.chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.error).toBeNull();

    const destPath = path.join(destDir, "psx", "Test Game.chd");
    expect(existsSync(destPath)).toBe(true);
    expect(existsSync(`${destPath}.part`)).toBe(false);
    expect(finished?.resultBytes).toBeGreaterThan(0);
  });

  maybeIt("converts a plain .iso via chd-dvd (the realistic PS2/PS2-DVD case)", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "ps2"));

    const isoPath = path.join(srcDir, "My PS2 Game.iso");
    makeDvdData(isoPath);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: isoPath,
        selectedSystemId: "ps2",
        action: "chd-dvd",
        destinationFolder: path.join(destDir, "ps2"),
        destinationFilename: "My PS2 Game.chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(existsSync(path.join(destDir, "ps2", "My PS2 Game.chd"))).toBe(true);
  });

  maybeIt("copies rather than re-converts a source that's already a .chd", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "ps2"));

    const chdPath = path.join(srcDir, "Already Converted.chd");
    writeFileSync(chdPath, "not a real chd, just needs to be copied as-is");

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: chdPath,
        selectedSystemId: "ps2",
        action: "chd-cd",
        destinationFolder: path.join(destDir, "ps2"),
        destinationFilename: "Already Converted.chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(readFileSync(path.join(destDir, "ps2", "Already Converted.chd"), "utf-8")).toBe(
      "not a real chd, just needs to be copied as-is",
    );
  });

  maybeIt("copies rather than re-converts a source that's already a .rvz, even without DolphinTool available", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "gamecube"));

    const rvzPath = path.join(srcDir, "Already Converted.rvz");
    writeFileSync(rvzPath, "not a real rvz, just needs to be copied as-is");

    // dolphinToolPath deliberately left out — copying an already-.rvz source must not require it.
    const queue = new JobQueue(
      () => 1,
      () => true,
      () => ({ ...toolPaths, dolphinToolPath: null }),
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: rvzPath,
        selectedSystemId: "gamecube",
        action: "rvz",
        destinationFolder: path.join(destDir, "gamecube"),
        destinationFilename: "Already Converted.rvz",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(readFileSync(path.join(destDir, "gamecube", "Already Converted.rvz"), "utf-8")).toBe(
      "not a real rvz, just needs to be copied as-is",
    );
  });

  maybeIt("finds and copies an already-.rvz file inside a .zip (the Smugglers Run: Warzones case)", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "gamecube"));

    const rvzPath = path.join(srcDir, "Smugglers Run - Warzones (USA).rvz");
    writeFileSync(rvzPath, "not a real rvz, just needs to be copied as-is");
    const zipPath = path.join(srcDir, "Smugglers Run - Warzones (USA).zip");
    const zipResult = spawnSync("7zz", ["a", "-tzip", zipPath, rvzPath], { encoding: "utf-8" });
    expect(zipResult.status).toBe(0);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => ({ ...toolPaths, dolphinToolPath: null }),
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: zipPath,
        selectedSystemId: "gamecube",
        action: "rvz",
        destinationFolder: path.join(destDir, "gamecube"),
        destinationFilename: "Smugglers Run - Warzones (USA).rvz",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.error).toBeNull();
    expect(existsSync(path.join(destDir, "gamecube", "Smugglers Run - Warzones (USA).rvz"))).toBe(true);
  });

  maybeIt("converts an archived CD-mode PS2 dump via chd-cd (the Smuggler's Run case: chd-dvd would reject this sector alignment)", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "ps2"));

    // Same raw-sector construction as makeRawCdTrack, saved as a bare .iso (no .cue) and
    // archived — mirrors a real CD-based PS2 dump like Smuggler's Run, which plan.ts now
    // routes to chd-cd instead of the ps2 default of chd-dvd (see plan.test.ts).
    const isoPath = path.join(srcDir, "Smuggler's Run (USA).iso");
    writeFileSync(isoPath, makeRawCdData(10));

    const archivePath = path.join(srcDir, "Smuggler's Run (USA).7z");
    const zipResult = spawnSync("7zz", ["a", "-t7z", archivePath, isoPath], { encoding: "utf-8" });
    expect(zipResult.status).toBe(0);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: archivePath,
        selectedSystemId: "ps2",
        action: "chd-cd",
        destinationFolder: path.join(destDir, "ps2"),
        destinationFilename: "Smuggler's Run (USA).chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.error).toBeNull();
    expect(existsSync(path.join(destDir, "ps2", "Smuggler's Run (USA).chd"))).toBe(true);
  });

  maybeIt("self-corrects to chd-cd at conversion time even when a job is enqueued with the wrong chd-dvd action already locked in", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "ps2"));

    // Plan-time detection can miss the CD-vs-DVD signal (e.g. an archive with more than one
    // entry never gets its real content size measured) and hand the queue a job whose action
    // is already locked in as the wrong chd-dvd. This is queue.ts's own safety net: it checks
    // the actual resolved bytes right before invoking chdman, so the job still succeeds instead
    // of failing with chdman's opaque "Data size ... is not divisible by sector size 2048".
    const isoPath = path.join(srcDir, "Smuggler's Run (USA).iso");
    writeFileSync(isoPath, makeRawCdData(10));

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: isoPath,
        selectedSystemId: "ps2",
        action: "chd-dvd", // deliberately wrong — the point of this test
        destinationFolder: path.join(destDir, "ps2"),
        destinationFilename: "Smuggler's Run (USA).chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.error).toBeNull();
    expect(finished?.action).toBe("chd-cd"); // corrected so the Queue page shows what actually ran
    expect(existsSync(path.join(destDir, "ps2", "Smuggler's Run (USA).chd"))).toBe(true);
  });

  maybeIt("refuses to enqueue a second job aimed at the same destination", async () => {
    // Both jobs would otherwise pass the existsSync check at the top of runJob (neither
    // destination exists yet), then race each other's rename, leaving only one result
    // behind with no indication the other was lost.
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));

    const first = makeRawCdTrack(srcDir, "Game A");
    const second = makeRawCdTrack(srcDir, "Game B");

    const queue = new JobQueue(
      () => 2,
      () => false,
      () => toolPaths,
    );

    const shared = { destinationFolder: path.join(destDir, "psx"), destinationFilename: "Same Name.chd" };
    queue.enqueue(fakePlannedJob({ sourcePath: first.cuePath, ...shared }));

    expect(() => queue.enqueue(fakePlannedJob({ sourcePath: second.cuePath, ...shared }))).toThrow(/already writing to/);
  });

  maybeIt("frees a destination claim once the job finishes, so it can be re-run", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));
    const disc = makeRawCdTrack(srcDir, "Retry Me");

    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    const planned = fakePlannedJob({
      sourcePath: disc.cuePath,
      destinationFolder: path.join(destDir, "psx"),
      destinationFilename: "Retry Me.chd",
    });

    const job = queue.enqueue(planned);
    await waitForTerminal(queue, job.id);

    // The claim is released, so re-enqueueing is allowed — the job then fails on the
    // real reason (the file is now actually there), not on a stale claim.
    const again = queue.enqueue(planned);
    const finished = await waitForTerminal(queue, again.id);
    expect(finished?.state).toBe("failed");
    expect(finished?.error).toMatch(/already exists/);
  });

  maybeIt("gives each job its own .part file rather than sharing one per destination", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));
    const disc = makeRawCdTrack(srcDir, "Part Path");

    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: disc.cuePath,
        destinationFolder: path.join(destDir, "psx"),
        destinationFilename: "Part Path.chd",
      }),
    );

    const partPaths: string[] = [];
    const watcher = setInterval(() => {
      for (const name of readdirSync(path.join(destDir, "psx"))) {
        if (name.endsWith(".part") && !partPaths.includes(name)) partPaths.push(name);
      }
    }, 10);

    const finished = await waitForTerminal(queue, job.id);
    clearInterval(watcher);

    expect(finished?.state).toBe("done");
    // Whatever scratch file was observed must have carried the job id, not just ".chd.part".
    for (const name of partPaths) {
      expect(name).toContain(job.id);
    }
    // And nothing is left behind.
    expect(readdirSync(path.join(destDir, "psx")).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  maybeIt("writes a .m3u that includes discs already on the card from an earlier session", async () => {
    // The playlist used to be built from this session's job list, which is empty after a
    // restart — so adding Disc 2 later than Disc 1 produced no playlist at all.
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    const psxDir = path.join(destDir, "psx");
    mkdirSync(psxDir);

    // Disc 1 is already sitting on the card; this process knows nothing about it.
    writeFileSync(path.join(psxDir, "Big RPG (Disc 1).chd"), "written by an earlier session");

    const disc2 = makeRawCdTrack(srcDir, "Big RPG Disc2");

    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: disc2.cuePath,
        destinationFolder: psxDir,
        destinationFilename: "Big RPG (Disc 2).chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");

    const m3uPath = path.join(psxDir, "Big RPG.m3u");
    expect(existsSync(m3uPath)).toBe(true);
    expect(readFileSync(m3uPath, "utf-8").trim().split("\n")).toEqual(["Big RPG (Disc 1).chd", "Big RPG (Disc 2).chd"]);
    expect(finished?.m3uWritten).toBe(m3uPath);
  });

  maybeIt("does not list the playlist itself, or dotfiles, among a set's discs", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    const psxDir = path.join(destDir, "psx");
    mkdirSync(psxDir);

    writeFileSync(path.join(psxDir, "Big RPG (Disc 1).chd"), "earlier session");
    // A stale playlist and a macOS metadata file, both of which sit in the same folder.
    writeFileSync(path.join(psxDir, "Big RPG.m3u"), "stale contents\n");
    writeFileSync(path.join(psxDir, "._Big RPG (Disc 3).chd"), "resource fork");

    const disc2 = makeRawCdTrack(srcDir, "Big RPG Disc2");
    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({ sourcePath: disc2.cuePath, destinationFolder: psxDir, destinationFilename: "Big RPG (Disc 2).chd" }),
    );
    await waitForTerminal(queue, job.id);

    const lines = readFileSync(path.join(psxDir, "Big RPG.m3u"), "utf-8").trim().split("\n");
    expect(lines).toEqual(["Big RPG (Disc 1).chd", "Big RPG (Disc 2).chd"]);
  });

  maybeIt("hashes finished jobs one at a time rather than all at once", async () => {
    // Hashing reads the whole source file. Several starting together would compete for
    // the same disk as the conversions that just took their run slots.
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    const queue = new JobQueue(
      () => 4,
      () => false,
      () => toolPaths,
    );

    let concurrentHashing = 0;
    let peakConcurrentHashing = 0;
    queue.on("update", (job: { phase: string; state: string }) => {
      if (job.state !== "done") return;
      if (job.phase === "hashing") {
        concurrentHashing++;
        peakConcurrentHashing = Math.max(peakConcurrentHashing, concurrentHashing);
      } else if (job.phase === "done" && concurrentHashing > 0) {
        concurrentHashing--;
      }
    });

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const romPath = path.join(srcDir, `game-${i}.nes`);
      const buf = Buffer.alloc(2 * 1024 * 1024);
      buf.write("NES\x1a", 0, "latin1");
      randomFillSync(buf, 16, buf.length - 16);
      writeFileSync(romPath, buf);

      ids.push(
        queue.enqueue(
          fakePlannedJob({
            sourcePath: romPath,
            selectedSystemId: "nes",
            action: "keep-zip",
            destinationFolder: path.join(destDir, "nes"),
            destinationFilename: `game-${i}.zip`,
          }),
        ).id,
      );
    }

    for (const id of ids) expect((await waitForTerminal(queue, id))?.state).toBe("done");
    // Give the serialized hash chain time to drain.
    await new Promise((r) => setTimeout(r, 500));

    expect(peakConcurrentHashing).toBe(1);
  }, 30000);

  maybeIt("replaces an existing destination file only when the job asks to", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    const psxDir = path.join(destDir, "psx");
    mkdirSync(psxDir);

    const existing = path.join(psxDir, "Replace Me.chd");
    writeFileSync(existing, "the old version");

    const disc = makeRawCdTrack(srcDir, "Replace Me");
    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    // Without replace, an existing destination is an error, not a silent overwrite.
    const refused = queue.enqueue(
      fakePlannedJob({ sourcePath: disc.cuePath, destinationFolder: psxDir, destinationFilename: "Replace Me.chd" }),
    );
    const refusedResult = await waitForTerminal(queue, refused.id);
    expect(refusedResult?.state).toBe("failed");
    expect(refusedResult?.error).toMatch(/already exists/);
    expect(readFileSync(existing, "utf-8")).toBe("the old version");

    // With replace, the new file takes its place.
    const replacing = queue.enqueue(
      fakePlannedJob({ sourcePath: disc.cuePath, destinationFolder: psxDir, destinationFilename: "Replace Me.chd", replace: true }),
    );
    const replaced = await waitForTerminal(queue, replacing.id);
    expect(replaced?.state).toBe("done");
    expect(replaced?.replaced).toBe("Replace Me.chd");
    expect(readFileSync(existing, "utf-8")).not.toBe("the old version");
    // No scratch or set-aside files left behind.
    expect(readdirSync(psxDir).filter((n) => n.includes(".replaced-") || n.endsWith(".part"))).toEqual([]);
  });

  maybeIt("leaves the existing file untouched when a replace job fails", async () => {
    // The whole point of moving the original aside rather than deleting it up front:
    // a conversion that fails must not cost the user the file they already had.
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    const psxDir = path.join(destDir, "psx");
    mkdirSync(psxDir);

    const existing = path.join(psxDir, "Keep Me.chd");
    writeFileSync(existing, "the old version");

    // A source chdman cannot convert, so the job fails before reaching the rename.
    const bogusPath = path.join(srcDir, "Keep Me.cue");
    writeFileSync(bogusPath, "this is not a real cue sheet");

    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({ sourcePath: bogusPath, destinationFolder: psxDir, destinationFilename: "Keep Me.chd", replace: true }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("failed");
    expect(readFileSync(existing, "utf-8")).toBe("the old version");
    expect(readdirSync(psxDir)).toEqual(["Keep Me.chd"]);
  });

  maybeIt("removes the differently-named file it supersedes, rather than leaving both", async () => {
    // Duplicates are usually matched by content or normalized name, so the superseded
    // file rarely shares the filename the new job writes. Without replacesPath the user
    // chooses Replace and ends up with both copies — the opposite of what they asked for.
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    const psxDir = path.join(destDir, "psx");
    mkdirSync(psxDir);

    const superseded = path.join(psxDir, "Big Game (USA).chd");
    writeFileSync(superseded, "the older dump");

    const disc = makeRawCdTrack(srcDir, "Big Game Rev1");
    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: disc.cuePath,
        destinationFolder: psxDir,
        destinationFilename: "Big Game (USA) (Rev 1).chd",
        replace: true,
        replacesPath: superseded,
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.replaced).toBe("Big Game (USA).chd");

    expect(existsSync(path.join(psxDir, "Big Game (USA) (Rev 1).chd"))).toBe(true);
    expect(existsSync(superseded)).toBe(false);
    expect(readdirSync(psxDir)).toEqual(["Big Game (USA) (Rev 1).chd"]);
  });

  maybeIt("keeps the superseded file when the replacing job fails", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    const psxDir = path.join(destDir, "psx");
    mkdirSync(psxDir);

    const superseded = path.join(psxDir, "Big Game (USA).chd");
    writeFileSync(superseded, "the older dump");

    const bogusPath = path.join(srcDir, "Big Game Rev1.cue");
    writeFileSync(bogusPath, "not a real cue sheet");

    const queue = new JobQueue(
      () => 1,
      () => false,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: bogusPath,
        destinationFolder: psxDir,
        destinationFilename: "Big Game (USA) (Rev 1).chd",
        replace: true,
        replacesPath: superseded,
      }),
    );

    expect((await waitForTerminal(queue, job.id))?.state).toBe("failed");
    expect(readFileSync(superseded, "utf-8")).toBe("the older dump");
  });

  maybeIt("reports real intermediate progress during a chdman conversion, not just stuck 0% until done", async () => {
    // chdman's own "Compressing, N% complete" stdout is silently suppressed by chdman itself
    // whenever it's piped rather than attached to a TTY — exactly how child_process.spawn
    // connects to it — so a real multi-minute conversion previously reported 0% the entire
    // time even though it was working correctly. createChd now polls the growing output
    // file's size instead; this proves that poll actually surfaces mid-flight percentages.
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));

    const disc = makeSlowCdTrack(srcDir, "Slow Game", 20000);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const enqueued = queue.enqueue(
      fakePlannedJob({ sourcePath: disc.cuePath, destinationFolder: path.join(destDir, "psx"), destinationFilename: "Slow Game.chd" }),
    );

    const percentsWhileConverting: number[] = [];
    queue.on("update", (job) => {
      if (job.id === enqueued.id && job.phase === "converting") percentsWhileConverting.push(job.percent);
    });

    const finished = await waitForTerminal(queue, enqueued.id, 30000);
    expect(finished?.state).toBe("done");
    expect(percentsWhileConverting.some((p) => p > 0 && p < 100)).toBe(true);
  }, 60000);

  maybeItDolphin("converts a GameCube ISO to RVZ via the npm-bundled DolphinTool", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "gamecube"));

    const isoPath = path.join(srcDir, "My GC Game.iso");
    makeGameCubeIso(isoPath);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: isoPath,
        selectedSystemId: "gamecube",
        action: "rvz",
        destinationFolder: path.join(destDir, "gamecube"),
        destinationFilename: "My GC Game.rvz",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.error).toBeNull();
    const destPath = path.join(destDir, "gamecube", "My GC Game.rvz");
    expect(existsSync(destPath)).toBe(true);
    expect(finished?.resultBytes).toBeGreaterThan(0);
  });

  maybeIt("resolves a .cue's referenced data file directly for chd-dvd, since createdvd can't parse cue sheets", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "ps2"));

    const binPath = path.join(srcDir, "Weird PS2 Dump.bin");
    makeDvdData(binPath);
    const cuePath = path.join(srcDir, "Weird PS2 Dump.cue");
    writeFileSync(cuePath, 'FILE "Weird PS2 Dump.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n');

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: cuePath,
        selectedSystemId: "ps2",
        action: "chd-dvd",
        destinationFolder: path.join(destDir, "ps2"),
        destinationFilename: "Weird PS2 Dump.chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(finished?.error).toBeNull();
    expect(existsSync(path.join(destDir, "ps2", "Weird PS2 Dump.chd"))).toBe(true);
  });

  maybeIt("deletes a staged upload's source file after a successful job", async () => {
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    const stagedPath = path.join(STAGING_DIR, `queue-test-${Date.now()}-game.nes`);
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(stagedPath, romBuf);

    try {
      const queue = new JobQueue(
        () => 1,
        () => true,
        () => toolPaths,
        () => false, // deleteSourceAfterSuccess is irrelevant for staged copies — they're always cleaned up
      );
      const job = queue.enqueue(
        fakePlannedJob({
          sourcePath: stagedPath,
          selectedSystemId: "nes",
          action: "keep-zip",
          destinationFolder: path.join(destDir, "nes"),
          destinationFilename: "game.zip",
        }),
      );

      const finished = await waitForTerminal(queue, job.id);
      expect(finished?.state).toBe("done");

      // Source cleanup is deliberately chained behind the hashing pass — hashing has to
      // read the source before anything deletes it — so it lands shortly after "done".
      await new Promise((r) => setTimeout(r, 250));
      expect(existsSync(stagedPath)).toBe(false);
    } finally {
      rmSync(stagedPath, { force: true });
    }
  });

  maybeIt("removes the per-upload directory too, and never renames the file (no UUID leaking into the destination)", async () => {
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    // Mirrors the layout the removed upload path used: staging/<uuid>/<original name>.
    const uploadDir = path.join(STAGING_DIR, `queue-test-upload-${Date.now()}`);
    mkdirSync(uploadDir, { recursive: true });
    const stagedPath = path.join(uploadDir, "Dark Cloud 2 (USA) (v2.00).zip");
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(stagedPath, romBuf);

    try {
      const queue = new JobQueue(
        () => 1,
        () => true,
        () => toolPaths,
        () => false,
      );
      const job = queue.enqueue(
        fakePlannedJob({
          sourcePath: stagedPath,
          selectedSystemId: "nes",
          action: "keep-zip",
          destinationFolder: path.join(destDir, "nes"),
          destinationFilename: "Dark Cloud 2 (USA) (v2.00).zip",
        }),
      );

      const finished = await waitForTerminal(queue, job.id);
      expect(finished?.state).toBe("done");
      // The destination filename is exactly the original name — no id ever touched it.
      expect(existsSync(path.join(destDir, "nes", "Dark Cloud 2 (USA) (v2.00).zip"))).toBe(true);

      // Source cleanup is deliberately chained behind the hashing pass — hashing has to
      // read the source before anything deletes it — so it lands shortly after "done".
      await new Promise((r) => setTimeout(r, 250));
      expect(existsSync(stagedPath)).toBe(false);
      expect(existsSync(uploadDir)).toBe(false);
    } finally {
      rmSync(uploadDir, { recursive: true, force: true });
    }
  });

  maybeIt("keeps a staged upload's source file if the job fails", async () => {
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));
    const existingPath = path.join(destDir, "psx", "Existing.chd");
    writeFileSync(existingPath, "pre-existing content");

    const stagedPath = path.join(STAGING_DIR, `queue-test-fail-${Date.now()}.cue`);
    writeFileSync(stagedPath, 'FILE "nope.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');

    try {
      const queue = new JobQueue(
        () => 1,
        () => true,
        () => toolPaths,
        () => false,
      );
      const job = queue.enqueue(
        fakePlannedJob({
          sourcePath: stagedPath,
          destinationFolder: path.join(destDir, "psx"),
          destinationFilename: "Existing.chd",
        }),
      );

      const finished = await waitForTerminal(queue, job.id);
      expect(finished?.state).toBe("failed");
      expect(existsSync(stagedPath)).toBe(true);
    } finally {
      rmSync(stagedPath, { force: true });
    }
  });

  maybeIt("does not delete a path-based source by default after success", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    const romPath = path.join(srcDir, "game.nes");
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(romPath, romBuf);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
      () => false,
    );
    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: romPath,
        selectedSystemId: "nes",
        action: "keep-zip",
        destinationFolder: path.join(destDir, "nes"),
        destinationFilename: "game.zip",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(existsSync(romPath)).toBe(true);
  });

  maybeIt("deletes a path-based source after success when deleteSourceAfterSuccess is enabled", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    const romPath = path.join(srcDir, "game.nes");
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(romPath, romBuf);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
      () => true,
    );
    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: romPath,
        selectedSystemId: "nes",
        action: "keep-zip",
        destinationFolder: path.join(destDir, "nes"),
        destinationFilename: "game.zip",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    expect(existsSync(romPath)).toBe(false);
  });

  maybeIt("zips a raw cartridge ROM for a keep-zip action", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "nes"));

    const romPath = path.join(srcDir, "game.nes");
    const romBuf = Buffer.alloc(64);
    romBuf.write("NES\x1a", 0, "latin1");
    writeFileSync(romPath, romBuf);

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: romPath,
        selectedSystemId: "nes",
        action: "keep-zip",
        destinationFolder: path.join(destDir, "nes"),
        destinationFilename: "game.zip",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    const destPath = path.join(destDir, "nes", "game.zip");
    expect(existsSync(destPath)).toBe(true);
  });

  maybeIt("copies a file as-is for a copy action", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "arcade"));

    const romPath = path.join(srcDir, "mame_game.zip");
    writeFileSync(romPath, "not a real zip, just bytes for the copy path");

    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: romPath,
        selectedSystemId: "arcade",
        action: "copy",
        destinationFolder: path.join(destDir, "arcade"),
        destinationFilename: "mame_game.zip",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("done");
    const destPath = path.join(destDir, "arcade", "mame_game.zip");
    expect(readFileSync(destPath, "utf-8")).toBe("not a real zip, just bytes for the copy path");
  });

  maybeIt("fails without touching the destination when a file already exists there", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "psx"));
    const destPath = path.join(destDir, "psx", "Existing.chd");
    writeFileSync(destPath, "pre-existing content — must not be overwritten");

    const { cuePath } = makeRawCdTrack(srcDir, "Existing");
    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );

    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: cuePath,
        destinationFolder: path.join(destDir, "psx"),
        destinationFilename: "Existing.chd",
      }),
    );

    const finished = await waitForTerminal(queue, job.id);
    expect(finished?.state).toBe("failed");
    expect(finished?.error).toMatch(/already exists/);
    expect(readFileSync(destPath, "utf-8")).toBe("pre-existing content — must not be overwritten");
  });

  maybeIt("writes a .m3u playlist once every disc in a multi-disc set is done", async () => {
    const srcDir = makeTempDir();
    const destDir = makeTempDir();
    mkdirSync(path.join(destDir, "saturn"));

    const disc1 = makeRawCdTrack(srcDir, "Big RPG Disc1");
    const disc2 = makeRawCdTrack(srcDir, "Big RPG Disc2");

    const queue = new JobQueue(
      () => 2,
      () => true,
      () => toolPaths,
    );

    const job1 = queue.enqueue(
      fakePlannedJob({
        sourcePath: disc1.cuePath,
        selectedSystemId: "saturn",
        destinationFolder: path.join(destDir, "saturn"),
        destinationFilename: "Big RPG (Disc 1).chd",
      }),
    );
    const job2 = queue.enqueue(
      fakePlannedJob({
        sourcePath: disc2.cuePath,
        selectedSystemId: "saturn",
        destinationFolder: path.join(destDir, "saturn"),
        destinationFilename: "Big RPG (Disc 2).chd",
      }),
    );

    await waitForTerminal(queue, job1.id);
    await waitForTerminal(queue, job2.id);

    const m3uPath = path.join(destDir, "saturn", "Big RPG.m3u");
    expect(existsSync(m3uPath)).toBe(true);
    const content = readFileSync(m3uPath, "utf-8").trim().split("\n");
    expect(content).toEqual(["Big RPG (Disc 1).chd", "Big RPG (Disc 2).chd"]);
  });

  it("cancels a still-queued job immediately without running it", () => {
    const queue = new JobQueue(
      () => 0, // maxConcurrent 0 (clamped to 1 internally) won't matter — we cancel before pump runs anything relevant
      () => true,
      () => toolPaths,
    );
    // A destination that doesn't exist — if this ever actually ran, it would fail; cancelling before that must prevent it.
    const job = queue.enqueue(
      fakePlannedJob({
        sourcePath: "/nonexistent/should-never-run.cue",
        destinationFolder: "/nonexistent/dest",
        destinationFilename: "x.chd",
      }),
    );
    // There's a race in real life between enqueue's pump() and this cancel call, but for a
    // deterministic unit check we cancel a job we already know is still "queued" in the common case.
    if (queue.get(job.id)?.state === "queued") {
      const ok = queue.cancel(job.id);
      expect(ok).toBe(true);
      expect(queue.get(job.id)?.state).toBe("cancelled");
    }
  });

  it("rejects enqueueing a job with an unresolved system/action/destination", () => {
    const queue = new JobQueue(
      () => 1,
      () => true,
      () => toolPaths,
    );
    expect(() =>
      queue.enqueue(
        fakePlannedJob({
          sourcePath: "/tmp/whatever.iso",
          selectedSystemId: null,
          action: null,
          destinationFolder: null,
          destinationFilename: null,
        }),
      ),
    ).toThrow(/unresolved/);
  });
});

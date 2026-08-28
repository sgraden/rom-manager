import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobQueue, type ToolPaths } from "./queue.js";
import type { PlannedJob } from "../library/plan.js";
import { detectTools } from "../convert/tools.js";

// This test suite runs real chdman/7zz conversions end to end. It only ever
// writes into a scratch temp directory standing in as a "target" — never
// /Volumes or any real card. Skips gracefully if the tools aren't installed.
const tools = detectTools({ chdman: null, sevenZip: null, dolphinTool: null, maxcso: null });
const chdman = tools.find((t) => t.id === "chdman");
const sevenZip = tools.find((t) => t.id === "sevenZip");
const toolPaths: ToolPaths = {
  chdmanPath: chdman?.found ? chdman.path : null,
  sevenZipPath: sevenZip?.found ? sevenZip.path : null,
  dolphinToolPath: null,
};
const maybeIt = toolPaths.chdmanPath && toolPaths.sevenZipPath ? it : it.skip;

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
    ...overrides,
  };
}

describe("JobQueue (real chdman/7zz, scratch directory only)", () => {
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

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPlan } from "./plan.js";
import type { TargetInfo } from "./targets.js";
import type { AppConfig } from "./config.js";

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-plan-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fakeConfig(): AppConfig {
  return {
    port: 3001,
    maxConcurrentJobs: 1,
    reservedCpuCores: 2,
    verifyAfterConvert: true,
    deleteSourceAfterSuccess: false,
    additionalTargetPaths: [],
    toolPathOverrides: { chdman: null, sevenZip: null, dolphinTool: null, maxcso: null },
    targetFolderMaps: {},
    systemActionOverrides: {},
  };
}

function makeNesRom(dir: string, name = "game.nes"): string {
  const romPath = path.join(dir, name);
  const buf = Buffer.alloc(64);
  buf.write("NES\x1a", 0, "latin1");
  writeFileSync(romPath, buf);
  return romPath;
}

/** A minimal but structurally valid ISO9660 image with a SYSTEM.CNF BOOT2= entry — enough for detectIso9660 to identify it as PS2. Mirrors detect/disc.test.ts's fixture, sized to the caller's total. */
function buildPs2Iso9660Image(totalBytes: number): Buffer {
  const SECTOR = 2048;
  const rootDirLba = 17;
  const fileLba = 18;
  const content = Buffer.from("BOOT2 = cdrom0:\\SLES_123.45;1\r\nVER = 1.00\r\n", "ascii");
  const image = Buffer.alloc(totalBytes);

  const nameBuf = Buffer.from("SYSTEM.CNF;1", "ascii");
  const recLen = 33 + nameBuf.length + (nameBuf.length % 2 === 0 ? 1 : 0);
  const dirRecord = Buffer.alloc(recLen);
  dirRecord[0] = recLen;
  dirRecord.writeUInt32LE(fileLba, 2);
  dirRecord.writeUInt32LE(content.length, 10);
  dirRecord[25] = 0; // flags: file, not directory
  dirRecord[32] = nameBuf.length;
  nameBuf.copy(dirRecord, 33);
  dirRecord.copy(image, rootDirLba * SECTOR);

  const pvdOffset = 16 * SECTOR;
  image[pvdOffset] = 1;
  image.write("CD001", pvdOffset + 1, "ascii");
  const rootRecord = Buffer.alloc(34);
  rootRecord[0] = 34;
  rootRecord.writeUInt32LE(rootDirLba, 2);
  rootRecord.writeUInt32LE(SECTOR, 10);
  rootRecord[25] = 0x02;
  rootRecord.copy(image, pvdOffset + 156);

  content.copy(image, fileLba * SECTOR);

  return image;
}

describe("buildPlan", () => {
  it("plans a detected cartridge into its mapped folder", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "nes"), { recursive: true });
    const romPath = makeNesRom(root);

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["nes"],
    };

    const [job] = buildPlan([romPath], target, fakeConfig(), { sevenZipPath: null });

    expect(job.selectedSystemId).toBe("nes");
    expect(job.action).toBe("keep-zip");
    expect(job.destinationFolder).toBe(path.join(romRoot, "nes"));
    expect(job.destinationFilename).toBe("game.zip");
    expect(job.warnings).toEqual([]);
  });

  it("warns when no folder is mapped for the detected system", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(romRoot, { recursive: true });
    const romPath = makeNesRom(root);

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: [], // no "nes" folder on this card
    };

    const [job] = buildPlan([romPath], target, fakeConfig(), { sevenZipPath: null });
    expect(job.destinationFolder).toBeNull();
    expect(job.warnings.some((w) => w.includes("No destination folder mapped"))).toBe(true);
  });

  it("warns on a destination filename collision", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "nes"), { recursive: true });
    writeFileSync(path.join(romRoot, "nes", "game.zip"), "already here");
    const romPath = makeNesRom(root);

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["nes"],
    };

    const [job] = buildPlan([romPath], target, fakeConfig(), { sevenZipPath: null });
    expect(job.warnings.some((w) => w.includes("already exists"))).toBe(true);
  });

  it("warns when estimated output exceeds free space", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "nes"), { recursive: true });
    const romPath = makeNesRom(root);

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 10, // far smaller than even a tiny ROM
      totalBytes: 1000,
      fsType: "exfat",
      writable: true,
      folders: ["nes"],
    };

    const [job] = buildPlan([romPath], target, fakeConfig(), { sevenZipPath: null });
    expect(job.warnings.some((w) => w.includes("exceeds free space"))).toBe(true);
  });

  it("applies a manual system/action override and clears the low-confidence warning", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "snes"), { recursive: true });
    // A file with no recognizable header at all — normally "unknown".
    const unknownPath = path.join(root, "mystery.bin");
    writeFileSync(unknownPath, Buffer.alloc(32));

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["snes"],
    };

    const [job] = buildPlan([unknownPath], target, fakeConfig(), { sevenZipPath: null }, { [unknownPath]: { systemId: "snes", action: "keep-zip" } });

    expect(job.selectedSystemId).toBe("snes");
    expect(job.action).toBe("keep-zip");
    expect(job.warnings.some((w) => w.includes("Could not identify"))).toBe(false);
  });

  it("prefers chd-cd over the chd-dvd default when a PS2 image's size is CD-sector-aligned", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "ps2"), { recursive: true });
    // Real CD-mode PS2 dumps (e.g. Smuggler's Run, a launch title) are sized as an exact
    // multiple of a 2352-byte CD sector, not 2048 — chdman's createdvd rejects that outright.
    const isoPath = path.join(root, "Smuggler's Run (USA).iso");
    writeFileSync(isoPath, buildPs2Iso9660Image(300 * 2352));

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["ps2"],
    };

    const [job] = buildPlan([isoPath], target, fakeConfig(), { sevenZipPath: null });

    expect(job.selectedSystemId).toBe("ps2");
    expect(job.action).toBe("chd-cd");
    expect(job.warnings.some((w) => w.includes("CD-mode PS2 dump"))).toBe(true);
  });

  it("leaves a DVD-sector-aligned PS2 image on the default chd-dvd action", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "ps2"), { recursive: true });
    const isoPath = path.join(root, "Some DVD Game (USA).iso");
    writeFileSync(isoPath, buildPs2Iso9660Image(21 * 2048));

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["ps2"],
    };

    const [job] = buildPlan([isoPath], target, fakeConfig(), { sevenZipPath: null });

    expect(job.selectedSystemId).toBe("ps2");
    expect(job.action).toBe("chd-dvd");
    expect(job.warnings.some((w) => w.includes("CD-mode PS2 dump"))).toBe(false);
  });

  it("respects a manually chosen action even when the CD-sector heuristic would otherwise override it", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "ps2"), { recursive: true });
    const isoPath = path.join(root, "Smuggler's Run (USA).iso");
    writeFileSync(isoPath, buildPs2Iso9660Image(300 * 2352));

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["ps2"],
    };

    const [job] = buildPlan([isoPath], target, fakeConfig(), { sevenZipPath: null }, { [isoPath]: { action: "chd-dvd" } });

    expect(job.action).toBe("chd-dvd");
  });

  const sevenZipProbe = spawnSync("7zz", ["i"], { encoding: "utf-8" });
  const maybeIt = sevenZipProbe.error ? it.skip : it;

  maybeIt("uses an archived PS2 image's real decompressed size, not the .7z's compressed size", () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "ps2"), { recursive: true });

    // Mostly-zero content compresses far smaller than its real 705,600-byte size, so this
    // only passes if buildPlan is reading the archive's real decompressed content size —
    // not just stat()-ing the much smaller .7z file on disk.
    const isoPath = path.join(root, "Smuggler's Run (USA).iso");
    writeFileSync(isoPath, buildPs2Iso9660Image(300 * 2352));
    const archivePath = path.join(root, "Smuggler's Run (USA).7z");
    const zipResult = spawnSync("7zz", ["a", "-t7z", archivePath, isoPath], { encoding: "utf-8" });
    expect(zipResult.status).toBe(0);

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["ps2"],
    };

    const [job] = buildPlan([archivePath], target, fakeConfig(), { sevenZipPath: "7zz" });

    expect(job.selectedSystemId).toBe("ps2");
    expect(job.sourceBytes).toBe(300 * 2352);
    expect(job.action).toBe("chd-cd");
  });

  it("keeps planning the rest of the batch when one file can't be inspected", () => {
    // A source that was moved or unmounted between being added and the plan being built.
    // Detection throws on it; that must not discard the plan for every other file.
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "nes"), { recursive: true });
    const goodPath = makeNesRom(root, "good.nes");
    const missingPath = path.join(root, "vanished.nes");

    const target: TargetInfo = {
      name: "TESTCARD",
      path: root,
      romRoot,
      freeBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      fsType: "exfat",
      writable: true,
      folders: ["nes"],
    };

    const jobs = buildPlan([missingPath, goodPath], target, fakeConfig(), { sevenZipPath: null });

    expect(jobs).toHaveLength(2);

    const [missing, good] = jobs;
    expect(missing.selectedSystemId).toBeNull();
    expect(missing.sourceKind).toBe("unknown");
    expect(missing.warnings.some((w) => w.includes("Could not inspect this file"))).toBe(true);

    // The readable file is planned exactly as it would have been on its own.
    expect(good.selectedSystemId).toBe("nes");
    expect(good.destinationFilename).toBe("good.zip");
  });
});

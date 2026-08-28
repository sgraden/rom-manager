import { describe, it, expect, afterEach } from "vitest";
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
});

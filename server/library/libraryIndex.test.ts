import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TargetInfo } from "./targets.js";
import type { AppConfig } from "./config.js";

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-libindex-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.resetModules();
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

function fakeTarget(romRoot: string, folders: string[]): TargetInfo {
  return {
    name: "TESTCARD",
    path: path.dirname(romRoot),
    romRoot,
    freeBytes: 1_000_000_000,
    totalBytes: 2_000_000_000,
    fsType: "exfat",
    writable: true,
    folders,
  };
}

/** Loads the index module with the library log redirected to a scratch file. */
async function loadIndex(logPath: string) {
  vi.doMock("../lib/paths.js", () => ({ LIBRARY_LOG_PATH: logPath, LEGACY_LIBRARY_PATH: `${logPath}.legacy` }));
  return import("./libraryIndex.js");
}

describe("buildLibraryIndex", () => {
  it("reports what is on the card, grouped by system folder", async () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "psx"), { recursive: true });
    mkdirSync(path.join(romRoot, "snes"), { recursive: true });
    writeFileSync(path.join(romRoot, "psx", "Game A.chd"), "x".repeat(100));
    writeFileSync(path.join(romRoot, "psx", "Game B.chd"), "x".repeat(200));
    writeFileSync(path.join(romRoot, "snes", "Cart.zip"), "x".repeat(50));

    const { buildLibraryIndex } = await loadIndex(path.join(root, "library.jsonl"));
    const index = buildLibraryIndex(fakeTarget(romRoot, ["psx", "snes"]), fakeConfig());

    expect(index.fileCount).toBe(3);
    expect(index.totalBytes).toBe(350);

    const psx = index.groups.find((g) => g.folder === "psx")!;
    expect(psx.systemId).toBe("psx"); // matched by folder alias
    expect(psx.entries.map((e) => e.filename)).toEqual(["Game A.chd", "Game B.chd"]);
    expect(psx.totalBytes).toBe(300);
  });

  it("includes files this app never wrote — the card is the source of truth", async () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "psx"), { recursive: true });
    writeFileSync(path.join(romRoot, "psx", "Put here by another tool.chd"), "x");

    const { buildLibraryIndex } = await loadIndex(path.join(root, "library.jsonl"));
    const index = buildLibraryIndex(fakeTarget(romRoot, ["psx"]), fakeConfig());

    const entry = index.groups[0].entries[0];
    expect(entry.filename).toBe("Put here by another tool.chd");
    expect(entry.record).toBeNull(); // nothing to enrich it with, and that's fine
  });

  it("joins the processing log onto files it did write", async () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "psx"), { recursive: true });
    const destination = path.join(romRoot, "psx", "Known Game.chd");
    writeFileSync(destination, "x");

    const logPath = path.join(root, "library.jsonl");
    writeFileSync(
      logPath,
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        originalName: "Known Game (USA).cue",
        hashes: { crc32: "abcd1234", md5: "m", sha1: "s" },
        hashedName: "Known Game (USA).cue",
        system: "psx",
        action: "chd-cd",
        destination,
        sizeBefore: 700,
        sizeAfter: 300,
        datMatch: "Known Game (USA)",
      }) + "\n",
    );

    const { buildLibraryIndex } = await loadIndex(logPath);
    const index = buildLibraryIndex(fakeTarget(romRoot, ["psx"]), fakeConfig());

    const entry = index.groups[0].entries[0];
    expect(entry.record?.originalName).toBe("Known Game (USA).cue");
    expect(entry.record?.datMatch).toBe("Known Game (USA)");
    expect(entry.record?.hashes.crc32).toBe("abcd1234");
  });

  it("skips playlists and dotfiles, which aren't games", async () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "psx"), { recursive: true });
    writeFileSync(path.join(romRoot, "psx", "Game (Disc 1).chd"), "x");
    writeFileSync(path.join(romRoot, "psx", "Game.m3u"), "Game (Disc 1).chd\n");
    writeFileSync(path.join(romRoot, "psx", "._Game (Disc 1).chd"), "resource fork");

    const { buildLibraryIndex } = await loadIndex(path.join(root, "library.jsonl"));
    const index = buildLibraryIndex(fakeTarget(romRoot, ["psx"]), fakeConfig());

    expect(index.groups[0].entries.map((e) => e.filename)).toEqual(["Game (Disc 1).chd"]);
  });

  it("surfaces folders that map to no system, sorted after the ones that do", async () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "psx"), { recursive: true });
    mkdirSync(path.join(romRoot, "mystery-folder"), { recursive: true });
    writeFileSync(path.join(romRoot, "psx", "Game.chd"), "x");
    writeFileSync(path.join(romRoot, "mystery-folder", "Unknown.bin"), "x");

    const { buildLibraryIndex } = await loadIndex(path.join(root, "library.jsonl"));
    const index = buildLibraryIndex(fakeTarget(romRoot, ["psx", "mystery-folder"]), fakeConfig());

    expect(index.groups.map((g) => g.folder)).toEqual(["psx", "mystery-folder"]);
    expect(index.groups[1].systemId).toBeNull();
  });

  it("ignores an empty or unreadable folder rather than failing the whole index", async () => {
    const root = makeTempDir();
    const romRoot = path.join(root, "roms");
    mkdirSync(path.join(romRoot, "psx"), { recursive: true });
    mkdirSync(path.join(romRoot, "empty"), { recursive: true });
    writeFileSync(path.join(romRoot, "psx", "Game.chd"), "x");

    const { buildLibraryIndex } = await loadIndex(path.join(root, "library.jsonl"));
    // "gone" was listed but no longer exists on disk.
    const index = buildLibraryIndex(fakeTarget(romRoot, ["psx", "empty", "gone"]), fakeConfig());

    expect(index.groups.map((g) => g.folder)).toEqual(["psx"]);
    expect(index.fileCount).toBe(1);
  });
});

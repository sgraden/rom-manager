import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LibraryRecord } from "./libraryLog.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.resetModules();
});

function makePaths(): { logPath: string; legacyPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-library-test-"));
  dirs.push(dir);
  return { logPath: path.join(dir, "library.jsonl"), legacyPath: path.join(dir, "library.json") };
}

/** Mocks the paths module and returns the freshly-imported log module bound to it. */
async function loadWith(logPath: string, legacyPath: string) {
  vi.doMock("../lib/paths.js", () => ({ LIBRARY_LOG_PATH: logPath, LEGACY_LIBRARY_PATH: legacyPath }));
  return import("./libraryLog.js");
}

function makeRecord(overrides: Partial<LibraryRecord> = {}): LibraryRecord {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    originalName: "game.nes",
    hashes: { crc32: "deadbeef", md5: "d41d8cd98f00b204e9800998ecf8427e", sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
    hashedName: "game.nes",
    system: "nes",
    action: "keep-zip" as const,
    destination: "/roms/nes/game.zip",
    sizeBefore: 1024,
    sizeAfter: 512,
    datMatch: null,
    ...overrides,
  };
}

function readLines(logPath: string): LibraryRecord[] {
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LibraryRecord);
}

describe("appendLibraryRecord", () => {
  it("creates the log with one record when it doesn't exist yet", async () => {
    const { logPath, legacyPath } = makePaths();
    const { appendLibraryRecord } = await loadWith(logPath, legacyPath);

    appendLibraryRecord(makeRecord());

    const saved = readLines(logPath);
    expect(saved).toHaveLength(1);
    expect(saved[0].originalName).toBe("game.nes");
    expect(saved[0].hashes.crc32).toBe("deadbeef");
  });

  it("appends to existing records rather than overwriting them", async () => {
    const { logPath, legacyPath } = makePaths();
    const { appendLibraryRecord } = await loadWith(logPath, legacyPath);

    appendLibraryRecord(makeRecord({ originalName: "first.nes" }));
    appendLibraryRecord(makeRecord({ originalName: "second.nes" }));

    expect(readLines(logPath).map((r) => r.originalName)).toEqual(["first.nes", "second.nes"]);
  });

  it("writes exactly one line per record, so an append never rewrites history", async () => {
    const { logPath, legacyPath } = makePaths();
    const { appendLibraryRecord } = await loadWith(logPath, legacyPath);

    for (let i = 0; i < 5; i++) appendLibraryRecord(makeRecord({ originalName: `game-${i}.nes` }));

    const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);
    // Appending must not have touched the earlier bytes.
    expect(JSON.parse(lines[0]).originalName).toBe("game-0.nes");
  });

  it("records a null datMatch as null, and a real match as the canonical name", async () => {
    const { logPath, legacyPath } = makePaths();
    const { appendLibraryRecord } = await loadWith(logPath, legacyPath);

    appendLibraryRecord(makeRecord({ datMatch: "Game (USA) [!].nes" }));
    expect(readLines(logPath)[0].datMatch).toBe("Game (USA) [!].nes");
  });
});

describe("readLibraryRecords", () => {
  it("reads back everything that was appended", async () => {
    const { logPath, legacyPath } = makePaths();
    const { appendLibraryRecord, readLibraryRecords } = await loadWith(logPath, legacyPath);

    appendLibraryRecord(makeRecord({ originalName: "a.nes" }));
    appendLibraryRecord(makeRecord({ originalName: "b.nes" }));

    expect(readLibraryRecords().map((r) => r.originalName)).toEqual(["a.nes", "b.nes"]);
  });

  it("returns an empty list when nothing has been logged yet", async () => {
    const { logPath, legacyPath } = makePaths();
    const { readLibraryRecords } = await loadWith(logPath, legacyPath);
    expect(readLibraryRecords()).toEqual([]);
  });

  it("skips a damaged line and keeps every intact one", async () => {
    // The whole point of the line-based format: corruption stays local.
    const { logPath, legacyPath } = makePaths();
    const good = JSON.stringify(makeRecord({ originalName: "intact.nes" }));
    writeFileSync(logPath, `${good}\n{ truncated mid-writ\n${good.replace("intact", "also-intact")}\n`);

    const { readLibraryRecords } = await loadWith(logPath, legacyPath);
    expect(readLibraryRecords().map((r) => r.originalName)).toEqual(["intact.nes", "also-intact.nes"]);
  });
});

describe("legacy library.json migration", () => {
  it("converts an existing JSON-array log into the line-based one", async () => {
    const { logPath, legacyPath } = makePaths();
    writeFileSync(legacyPath, JSON.stringify([makeRecord({ originalName: "old-1.nes" }), makeRecord({ originalName: "old-2.nes" })], null, 2));

    const { appendLibraryRecord, readLibraryRecords } = await loadWith(logPath, legacyPath);
    appendLibraryRecord(makeRecord({ originalName: "new.nes" }));

    expect(readLibraryRecords().map((r) => r.originalName)).toEqual(["old-1.nes", "old-2.nes", "new.nes"]);
    // Renamed aside rather than deleted — it is the only copy of that history.
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
  });

  it("leaves a corrupt legacy file in place rather than destroying it", async () => {
    const { logPath, legacyPath } = makePaths();
    writeFileSync(legacyPath, "{ not valid json");

    const { appendLibraryRecord, readLibraryRecords } = await loadWith(logPath, legacyPath);
    expect(() => appendLibraryRecord(makeRecord())).not.toThrow();

    expect(readLibraryRecords()).toHaveLength(1);
    expect(existsSync(legacyPath)).toBe(true); // still there to be salvaged by hand
  });

  it("does not re-migrate once the new log exists", async () => {
    const { logPath, legacyPath } = makePaths();
    writeFileSync(legacyPath, JSON.stringify([makeRecord({ originalName: "old.nes" })]));
    writeFileSync(logPath, JSON.stringify(makeRecord({ originalName: "already-migrated.nes" })) + "\n");

    const { readLibraryRecords } = await loadWith(logPath, legacyPath);
    expect(readLibraryRecords().map((r) => r.originalName)).toEqual(["already-migrated.nes"]);
  });
});

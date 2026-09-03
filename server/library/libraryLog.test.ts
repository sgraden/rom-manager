import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LibraryRecord } from "./libraryLog.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.resetModules();
});

function makeLibraryPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-library-test-"));
  dirs.push(dir);
  return path.join(dir, "library.json");
}

function makeRecord(overrides: Partial<LibraryRecord> = {}): LibraryRecord {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    originalName: "game.nes",
    hashes: { crc32: "deadbeef", md5: "d41d8cd98f00b204e9800998ecf8427e", sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" },
    system: "nes",
    action: "keep-zip" as const,
    destination: "/roms/nes/game.zip",
    sizeBefore: 1024,
    sizeAfter: 512,
    datMatch: null,
    ...overrides,
  };
}

describe("appendLibraryRecord", () => {
  it("creates library.json with one record when it doesn't exist yet", async () => {
    const libraryPath = makeLibraryPath();
    vi.doMock("../lib/paths.js", () => ({ LIBRARY_PATH: libraryPath }));
    const { appendLibraryRecord } = await import("./libraryLog.js");

    appendLibraryRecord(makeRecord());

    const saved = JSON.parse(readFileSync(libraryPath, "utf-8"));
    expect(saved).toHaveLength(1);
    expect(saved[0].originalName).toBe("game.nes");
    expect(saved[0].hashes.crc32).toBe("deadbeef");
  });

  it("appends to existing records rather than overwriting them", async () => {
    const libraryPath = makeLibraryPath();
    vi.doMock("../lib/paths.js", () => ({ LIBRARY_PATH: libraryPath }));
    const { appendLibraryRecord } = await import("./libraryLog.js");

    appendLibraryRecord(makeRecord({ originalName: "first.nes" }));
    appendLibraryRecord(makeRecord({ originalName: "second.nes" }));

    const saved = JSON.parse(readFileSync(libraryPath, "utf-8"));
    expect(saved).toHaveLength(2);
    expect(saved.map((r: { originalName: string }) => r.originalName)).toEqual(["first.nes", "second.nes"]);
  });

  it("records a null datMatch as null, and a real match as the canonical name", async () => {
    const libraryPath = makeLibraryPath();
    vi.doMock("../lib/paths.js", () => ({ LIBRARY_PATH: libraryPath }));
    const { appendLibraryRecord } = await import("./libraryLog.js");

    appendLibraryRecord(makeRecord({ datMatch: "Game (USA) [!].nes" }));

    const saved = JSON.parse(readFileSync(libraryPath, "utf-8"));
    expect(saved[0].datMatch).toBe("Game (USA) [!].nes");
  });

  it("starts a fresh log instead of throwing when the existing file is corrupt", async () => {
    const libraryPath = makeLibraryPath();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(libraryPath, "{ not valid json");
    vi.doMock("../lib/paths.js", () => ({ LIBRARY_PATH: libraryPath }));
    const { appendLibraryRecord } = await import("./libraryLog.js");

    expect(() => appendLibraryRecord(makeRecord())).not.toThrow();
    const saved = JSON.parse(readFileSync(libraryPath, "utf-8"));
    expect(saved).toHaveLength(1);
  });
});

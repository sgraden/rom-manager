import { describe, it, expect } from "vitest";
import path from "node:path";
import { normalizeGameName, findDuplicate, type DuplicateCandidate } from "./duplicates.js";
import type { LibraryEntry, LibraryIndex } from "./libraryIndex.js";
import type { LibraryRecord } from "./libraryLog.js";

const PSX_FOLDER = "/Volumes/CARD/roms/psx";

function makeEntry(filename: string, record: Partial<LibraryRecord> | null = null): LibraryEntry {
  return {
    folder: "psx",
    filename,
    fullPath: path.join(PSX_FOLDER, filename),
    sizeBytes: 1024,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    systemId: "psx",
    record: record
      ? ({
          timestamp: "2026-01-01T00:00:00.000Z",
          originalName: filename,
          hashes: { crc32: "00000000", md5: "0".repeat(32), sha1: "0".repeat(40) },
          hashedName: filename,
          system: "psx",
          action: "chd-cd",
          destination: path.join(PSX_FOLDER, filename),
          sizeBefore: 2048,
          sizeAfter: 1024,
          datMatch: null,
          ...record,
        } as LibraryRecord)
      : null,
  };
}

function makeIndex(entries: LibraryEntry[]): LibraryIndex {
  return {
    targetName: "CARD",
    romRoot: "/Volumes/CARD/roms",
    groups: [{ systemId: "psx", folder: "psx", entries, totalBytes: 0 }],
    fileCount: entries.length,
    totalBytes: 0,
    freeBytes: null,
  };
}

function candidate(destinationFilename: string, extra: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return { destinationFilename, destinationFolder: PSX_FOLDER, ...extra };
}

describe("normalizeGameName", () => {
  it("ignores extension, region tags and punctuation", () => {
    expect(normalizeGameName("Final Fantasy VII (USA).chd")).toBe(normalizeGameName("final-fantasy-vii.chd"));
    expect(normalizeGameName("Game (USA) (En,Fr,Es) (Rev 1).zip")).toBe(normalizeGameName("Game.zip"));
  });

  it("keeps disc numbers, so discs of one set never collapse together", () => {
    const disc1 = normalizeGameName("Final Fantasy VII (USA) (Disc 1).chd");
    const disc2 = normalizeGameName("Final Fantasy VII (USA) (Disc 2).chd");
    expect(disc1).not.toBe(disc2);
    // ...and recognises the same disc written differently.
    expect(normalizeGameName("Final Fantasy VII [Disk 1].chd")).toBe(disc1);
    expect(normalizeGameName("Final Fantasy VII (CD 1).chd")).toBe(disc1);
  });
});

describe("findDuplicate", () => {
  it("returns null when the folder holds nothing like it", () => {
    const index = makeIndex([makeEntry("Some Other Game (USA).chd")]);
    expect(findDuplicate(candidate("Final Fantasy VII (USA).chd"), index)).toBeNull();
  });

  it("matches on a normalized filename", () => {
    const index = makeIndex([makeEntry("Final Fantasy VII (USA) (Rev 1).chd")]);
    const match = findDuplicate(candidate("Final Fantasy VII (USA).chd"), index);
    expect(match?.tier).toBe("name");
    expect(match?.entry.filename).toBe("Final Fantasy VII (USA) (Rev 1).chd");
  });

  it("does not treat Disc 1 and Disc 2 of a set as duplicates", () => {
    const index = makeIndex([makeEntry("Final Fantasy VII (USA) (Disc 1).chd")]);
    expect(findDuplicate(candidate("Final Fantasy VII (USA) (Disc 2).chd"), index)).toBeNull();
    // The same disc, though, is a duplicate.
    expect(findDuplicate(candidate("Final Fantasy VII (USA) (Disc 1).chd"), index)?.tier).toBe("name");
  });

  it("prefers a content-hash match over a name match, and says so", () => {
    const sha1 = "a".repeat(40);
    const index = makeIndex([
      makeEntry("Totally Different Name.chd", { hashes: { crc32: "1", md5: "2", sha1 } }),
      makeEntry("Final Fantasy VII (USA).chd"),
    ]);

    const match = findDuplicate(candidate("Final Fantasy VII (USA).chd", { hashes: { crc32: "1", md5: "2", sha1 } }), index);
    expect(match?.tier).toBe("exact");
    expect(match?.entry.filename).toBe("Totally Different Name.chd");
    expect(match?.reason).toContain("Identical contents");
  });

  it("falls back to a DAT match when hashes differ but the game is the same", () => {
    const index = makeIndex([makeEntry("FF7 (redump dump).chd", { datMatch: "Final Fantasy VII (USA) (Disc 1)" })]);

    const match = findDuplicate(
      candidate("Some Other Dump.chd", { hashes: { crc32: "9", md5: "9", sha1: "9".repeat(40) }, datMatch: "Final Fantasy VII (USA) (Disc 1)" }),
      index,
    );
    expect(match?.tier).toBe("likely");
    expect(match?.entry.filename).toBe("FF7 (redump dump).chd");
  });

  it("never matches a file in a different system's folder", () => {
    // A PS1 disc and a Saturn disc sharing a name are not duplicates of each other.
    const saturnEntry: LibraryEntry = { ...makeEntry("Same Name (USA).chd"), folder: "saturn", fullPath: "/Volumes/CARD/roms/saturn/Same Name (USA).chd" };
    const index = makeIndex([saturnEntry]);
    expect(findDuplicate(candidate("Same Name (USA).chd"), index)).toBeNull();
  });

  it("returns null when the destination folder isn't resolved yet", () => {
    const index = makeIndex([makeEntry("Final Fantasy VII (USA).chd")]);
    expect(findDuplicate({ destinationFilename: "Final Fantasy VII (USA).chd", destinationFolder: null }, index)).toBeNull();
  });
});

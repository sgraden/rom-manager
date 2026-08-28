import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSevenZipListing, listArchiveEntries, extractArchive } from "./archive.js";

// Captured from a real `7zz l -slt` run against a two-entry zip (one file, one nested file).
const SAMPLE_SLT_OUTPUT = `
7-Zip (z) 26.02 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-06-25
 64-bit locale=en_US.UTF-8 Threads:8 OPEN_MAX:1048576

Scanning the drive for archives:
1 file, 308 bytes (1 KiB)

Listing archive: test.zip

--
Path = test.zip
Type = zip
Physical Size = 308

----------
Path = game.nes
Folder = -
Size = 6
Packed Size = 6
Modified = 2026-08-28 14:10:08.2396481
Created =
Accessed =
Attributes =  -rw-r--r--
Encrypted = -
Comment =
CRC = 363A3020
Method = Store
Characteristics = NTFS
Host OS = Unix
Version = 10
Volume Index = 0
Offset = 0

Path = subdir/nested.txt
Folder = -
Size = 6
Packed Size = 6
Modified = 2026-08-28 14:10:08.2457992
Created =
Accessed =
Attributes =  -rw-r--r--
Encrypted = -
Comment =
CRC = DD3861A8
Method = Store
Characteristics = NTFS
Host OS = Unix
Version = 10
Volume Index = 0
Offset = 44
`;

describe("parseSevenZipListing", () => {
  it("extracts entries and excludes the archive's own header block", () => {
    const entries = parseSevenZipListing(SAMPLE_SLT_OUTPUT);
    expect(entries).toEqual([
      { name: "game.nes", isDirectory: false, size: 6 },
      { name: "subdir/nested.txt", isDirectory: false, size: 6 },
    ]);
  });

  it("marks Folder = + entries as directories", () => {
    const output = `Path = emptydir\nFolder = +\nSize = 0\n`;
    expect(parseSevenZipListing(output)).toEqual([{ name: "emptydir", isDirectory: true, size: 0 }]);
  });

  it("returns an empty array for output with no entries", () => {
    expect(parseSevenZipListing("no matches found\n")).toEqual([]);
  });
});

const sevenZipProbe = spawnSync("7zz", ["i"], { encoding: "utf-8" });
const has7zz = !sevenZipProbe.error;
const maybeIt = has7zz ? it : it.skip;

describe("listArchiveEntries / extractArchive (integration, requires 7zz on PATH)", () => {
  maybeIt("lists and extracts a real zip", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-archive-test-"));
    try {
      const romPath = path.join(dir, "game.nes");
      writeFileSync(romPath, "NES\x1a" + "x".repeat(60));
      const zipPath = path.join(dir, "game.zip");
      const zipResult = spawnSync("7zz", ["a", "-tzip", zipPath, romPath], { encoding: "utf-8" });
      expect(zipResult.status).toBe(0);

      const entries = listArchiveEntries("7zz", zipPath);
      expect(entries.map((e) => e.name)).toContain("game.nes");

      const extractDir = path.join(dir, "extracted");
      mkdirSync(extractDir);
      extractArchive("7zz", zipPath, extractDir);
      const extractedContent = spawnSync("cat", [path.join(extractDir, "game.nes")], { encoding: "utf-8" }).stdout;
      expect(extractedContent.startsWith("NES\x1a")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

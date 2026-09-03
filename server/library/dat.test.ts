import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDatRoms, loadDatIndex } from "./dat.js";

const SAMPLE_DAT = `<?xml version="1.0"?>
<!DOCTYPE datafile PUBLIC "-//Logiqx//DTD ROM Management Datafile//EN" "http://www.logiqx.com/Dats/datafile.dtd">
<datafile>
	<header>
		<name>Sony - PlayStation</name>
	</header>
	<game name="Final Fantasy VII (USA) (Disc 1)">
		<description>Final Fantasy VII (USA) (Disc 1)</description>
		<rom name="Final Fantasy VII (USA) (Disc 1).bin" size="733367328" crc="ABCD1234" md5="d41d8cd98f00b204e9800998ecf8427e" sha1="da39a3ee5e6b4b0d3255bfef95601890afd80709"/>
	</game>
	<game name="Kirby &amp; The Amazing Mirror (USA)">
		<rom name="Kirby &amp; The Amazing Mirror (USA).gba" size="16777216" crc="11223344" md5="0cc175b9c0f1b6a831c399e269772661" sha1="86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"/>
	</game>
</datafile>
`;

describe("parseDatRoms", () => {
  it("extracts name/crc/md5/sha1 from each rom tag", () => {
    const roms = parseDatRoms(SAMPLE_DAT);
    expect(roms).toHaveLength(2);
    expect(roms[0]).toEqual({
      name: "Final Fantasy VII (USA) (Disc 1).bin",
      crc32: "abcd1234",
      md5: "d41d8cd98f00b204e9800998ecf8427e",
      sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    });
  });

  it("unescapes XML entities in the rom name", () => {
    const roms = parseDatRoms(SAMPLE_DAT);
    expect(roms[1].name).toBe("Kirby & The Amazing Mirror (USA).gba");
  });

  it("returns an empty array for XML with no rom tags", () => {
    expect(parseDatRoms("<datafile><header><name>Empty</name></header></datafile>")).toEqual([]);
  });

  it("skips a rom tag with no name attribute rather than crashing", () => {
    expect(parseDatRoms('<rom crc="12345678" size="10"/>')).toEqual([]);
  });
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDatsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-dats-test-"));
  dirs.push(dir);
  return dir;
}

describe("loadDatIndex", () => {
  it("is always-null when the folder doesn't exist", () => {
    const index = loadDatIndex("/nonexistent/dats/dir");
    expect(index.datFileCount).toBe(0);
    expect(index.lookup({ crc32: "abcd1234", md5: "x", sha1: "y" })).toBeNull();
  });

  it("is always-null when the folder is empty", () => {
    const dir = makeDatsDir();
    const index = loadDatIndex(dir);
    expect(index.datFileCount).toBe(0);
    expect(index.lookup({ crc32: "abcd1234", md5: "d41d8cd98f00b204e9800998ecf8427e", sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" })).toBeNull();
  });

  it("matches by crc32, case-insensitively", () => {
    const dir = makeDatsDir();
    writeFileSync(path.join(dir, "psx.dat"), SAMPLE_DAT);
    const index = loadDatIndex(dir);
    expect(index.datFileCount).toBe(1);
    expect(index.romCount).toBe(2);
    expect(index.lookup({ crc32: "ABCD1234", md5: "nope", sha1: "nope" })).toBe("Final Fantasy VII (USA) (Disc 1).bin");
  });

  it("falls back to sha1 when crc32 doesn't match", () => {
    const dir = makeDatsDir();
    writeFileSync(path.join(dir, "psx.dat"), SAMPLE_DAT);
    const index = loadDatIndex(dir);
    expect(index.lookup({ crc32: "ffffffff", md5: "nope", sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709" })).toBe(
      "Final Fantasy VII (USA) (Disc 1).bin",
    );
  });

  it("returns null when nothing matches any hash", () => {
    const dir = makeDatsDir();
    writeFileSync(path.join(dir, "psx.dat"), SAMPLE_DAT);
    const index = loadDatIndex(dir);
    expect(index.lookup({ crc32: "00000000", md5: "00000000000000000000000000000000", sha1: "0000000000000000000000000000000000000000" })).toBeNull();
  });

  it("merges roms from multiple .dat files and ignores non-.dat files", () => {
    const dir = makeDatsDir();
    writeFileSync(path.join(dir, "psx.dat"), SAMPLE_DAT);
    writeFileSync(path.join(dir, "readme.txt"), "not a dat file");
    const index = loadDatIndex(dir);
    expect(index.datFileCount).toBe(1);
    expect(index.romCount).toBe(2);
  });
});

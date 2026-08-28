import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCueFile, parseGdiFile, resolveCcdCompanions } from "./cuesheet.js";

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("parseCueFile", () => {
  it("resolves a FILE line to an existing track", () => {
    const dir = makeTempDir();
    const binPath = path.join(dir, "Game (USA).bin");
    writeFileSync(binPath, "");
    const cuePath = path.join(dir, "Game (USA).cue");
    const content = 'FILE "Game (USA).bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';
    writeFileSync(cuePath, content);

    const result = parseCueFile(cuePath, content);
    expect(result.trackFiles).toEqual([binPath]);
    expect(result.missingTrackFiles).toEqual([]);
  });

  it("reports a track file that doesn't exist", () => {
    const dir = makeTempDir();
    const cuePath = path.join(dir, "Game.cue");
    const content = 'FILE "Game.bin" BINARY\n';
    writeFileSync(cuePath, content);

    const result = parseCueFile(cuePath, content);
    expect(result.trackFiles).toEqual([]);
    expect(result.missingTrackFiles).toEqual([path.join(dir, "Game.bin")]);
  });
});

describe("parseGdiFile", () => {
  it("resolves bare (unquoted) track filenames", () => {
    const dir = makeTempDir();
    const track1 = path.join(dir, "track01.bin");
    const track2 = path.join(dir, "track02.raw");
    writeFileSync(track1, "");
    writeFileSync(track2, "");
    const gdiPath = path.join(dir, "Game.gdi");
    const content = "2\n1 0 4 2048 track01.bin 0\n2 45000 0 2352 track02.raw 0\n";
    writeFileSync(gdiPath, content);

    const result = parseGdiFile(gdiPath, content);
    expect(result.trackFiles.sort()).toEqual([track1, track2].sort());
    expect(result.missingTrackFiles).toEqual([]);
  });
});

describe("resolveCcdCompanions", () => {
  it("finds an existing .img and reports a missing .sub", () => {
    const dir = makeTempDir();
    const ccdPath = path.join(dir, "Game.ccd");
    writeFileSync(ccdPath, "[CloneCD]\n");
    const imgPath = path.join(dir, "Game.img");
    writeFileSync(imgPath, "");

    const result = resolveCcdCompanions(ccdPath);
    expect(result.trackFiles).toEqual([imgPath]);
    expect(result.missingTrackFiles).toEqual([path.join(dir, "Game.sub")]);
  });
});

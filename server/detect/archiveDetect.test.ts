import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPath, clearDetectionCache } from "./index.js";
import { detectTools } from "../convert/tools.js";

const sevenZip = detectTools({ chdman: null, sevenZip: null, dolphinTool: null, maxcso: null }).find((t) => t.id === "sevenZip");
const sevenZipPath = sevenZip?.found ? sevenZip.path : null;
const maybeIt = sevenZipPath ? it : it.skip;

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-archdet-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
beforeEach(() => clearDetectionCache());

/**
 * A GameCube image whose magic sits at offset 0x1c — well inside the streamed prefix —
 * followed by `padMb` of incompressible padding, so a full decompression is measurably
 * more expensive than reading the prefix.
 */
function makeGameCubeIso(filePath: string, padMb: number): void {
  const head = Buffer.alloc(1024 * 1024);
  head.writeUInt32BE(0xc2339f3d, 0x1c);
  const pad = Buffer.alloc(1024 * 1024);
  const parts = [head];
  for (let i = 0; i < padMb; i++) {
    randomFillSync(pad);
    parts.push(Buffer.from(pad));
  }
  writeFileSync(filePath, Buffer.concat(parts));
}

describe("archive detection", () => {
  maybeIt("identifies an archived disc image without decompressing the whole archive", () => {
    const dir = makeTempDir();
    const isoPath = path.join(dir, "My GC Game.iso");
    makeGameCubeIso(isoPath, 24);

    const archivePath = path.join(dir, "My GC Game.7z");
    expect(spawnSync("7zz", ["a", "-t7z", "-mx1", archivePath, isoPath], { encoding: "utf-8" }).status).toBe(0);

    const started = Date.now();
    const result = detectPath(archivePath, { sevenZipPath });
    const elapsed = Date.now() - started;

    expect(result.kind).toBe("disc");
    expect(result.candidates[0].systemId).toBe("gamecube");
    expect(result.candidates[0].confidence).toBeGreaterThan(0.9);
    expect(result.candidates[0].evidence).toContain("inside archive");
    // contentBytes must be the decompressed size, not the archive's compressed size.
    expect(result.contentBytes).toBe(25 * 1024 * 1024);

    // The prefix stream stops after 8MB; a full extract would have to write 25MB to
    // disk first. Generous bound — this is guarding against the O(entry) behaviour
    // coming back, not asserting a precise runtime.
    expect(elapsed).toBeLessThan(3000);
  });

  maybeIt("still identifies a cue-based disc set, which needs its sibling tracks on disk", () => {
    const dir = makeTempDir();
    const name = "Multi Track Game";
    const binPath = path.join(dir, `${name}.bin`);

    // Raw CD sectors carrying a Sega Saturn IP.BIN marker in the first sector's data area.
    const sectorSize = 2352;
    const data = Buffer.alloc(20 * sectorSize);
    for (let s = 0; s < 20; s++) {
      const off = s * sectorSize;
      data.fill(0xff, off + 1, off + 11);
      data[off + 15] = 0x01;
    }
    data.write("SEGA SEGASATURN ", 16, "latin1");
    writeFileSync(binPath, data);

    const cuePath = path.join(dir, `${name}.cue`);
    writeFileSync(cuePath, `FILE "${name}.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`);

    const archivePath = path.join(dir, `${name}.7z`);
    expect(spawnSync("7zz", ["a", "-t7z", archivePath, cuePath, binPath], { encoding: "utf-8" }).status).toBe(0);

    const result = detectPath(archivePath, { sevenZipPath });
    expect(result.kind).toBe("disc");
    expect(result.candidates[0].systemId).toBe("saturn");
  });

  maybeIt("caches by content identity, and re-detects once the file changes", () => {
    const dir = makeTempDir();
    const isoPath = path.join(dir, "Cached Game.iso");
    makeGameCubeIso(isoPath, 8);
    const archivePath = path.join(dir, "Cached Game.7z");
    expect(spawnSync("7zz", ["a", "-t7z", "-mx1", archivePath, isoPath], { encoding: "utf-8" }).status).toBe(0);

    const first = detectPath(archivePath, { sevenZipPath });
    const second = detectPath(archivePath, { sevenZipPath });
    // Same object identity proves the second call never re-ran 7zz.
    expect(second).toBe(first);

    // Touching the file changes its mtime, which is part of the cache key.
    const later = new Date(Date.now() + 5000);
    utimesSync(archivePath, later, later);
    expect(detectPath(archivePath, { sevenZipPath })).not.toBe(first);
  });

  maybeIt("does not let one file's cached result answer for another", () => {
    const dir = makeTempDir();
    const gcPath = path.join(dir, "gc.iso");
    makeGameCubeIso(gcPath, 1);

    const nesPath = path.join(dir, "cart.nes");
    const nes = Buffer.alloc(64);
    nes.write("NES\x1a", 0, "latin1");
    writeFileSync(nesPath, nes);

    expect(detectPath(gcPath, { sevenZipPath }).candidates[0].systemId).toBe("gamecube");
    expect(detectPath(nesPath, { sevenZipPath }).candidates[0].systemId).toBe("nes");
    expect(detectPath(gcPath, { sevenZipPath }).candidates[0].systemId).toBe("gamecube");
  });
});

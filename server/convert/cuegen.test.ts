import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateCueForBin } from "./cuegen.js";

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-cuegen-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("generateCueForBin", () => {
  it("reads MODE1/2352 from the sector header when the size is a multiple of 2352", () => {
    const dir = makeTempDir();
    const binPath = path.join(dir, "track.bin");
    const buf = Buffer.alloc(2352 * 2);
    buf[15] = 0x01; // MODE1 marker in the first sector's header
    writeFileSync(binPath, buf);

    const result = generateCueForBin(binPath, buf.length);
    expect(result.mode).toBe("MODE1/2352");
    expect(result.confident).toBe(true);
    dirs.push(result.tmpDir);
  });

  it("reads MODE2/2352 from the sector header", () => {
    const dir = makeTempDir();
    const binPath = path.join(dir, "track.bin");
    const buf = Buffer.alloc(2352 * 2);
    buf[15] = 0x02;
    writeFileSync(binPath, buf);

    const result = generateCueForBin(binPath, buf.length);
    expect(result.mode).toBe("MODE2/2352");
    dirs.push(result.tmpDir);
  });

  it("falls back to MODE1/2048 for a plain-sector-size file", () => {
    const dir = makeTempDir();
    const binPath = path.join(dir, "track.bin");
    const buf = Buffer.alloc(2048 * 3);
    writeFileSync(binPath, buf);

    const result = generateCueForBin(binPath, buf.length);
    expect(result.mode).toBe("MODE1/2048");
    expect(result.confident).toBe(true);
    dirs.push(result.tmpDir);
  });

  it("flags low confidence when the size matches neither convention", () => {
    const dir = makeTempDir();
    const binPath = path.join(dir, "track.bin");
    const buf = Buffer.alloc(12345);
    writeFileSync(binPath, buf);

    const result = generateCueForBin(binPath, buf.length);
    expect(result.confident).toBe(false);
    dirs.push(result.tmpDir);
  });

  it("writes a cue file that references the bin via a path relative to the cue's own directory", () => {
    // chdman 0.289 resolves a cue's FILE reference relative to the .cue file's own location,
    // always — never the process's cwd, and never treating an embedded absolute path as
    // already-absolute. Since the generated .cue lives in its own scratch tmpDir rather than
    // next to binPath, the FILE line must be a proper path.relative() between the two.
    const dir = makeTempDir();
    const binPath = path.join(dir, "track.bin");
    writeFileSync(binPath, Buffer.alloc(2048));

    const result = generateCueForBin(binPath, 2048);
    dirs.push(result.tmpDir);
    const content = readFileSync(result.cuePath, "utf-8");
    const expectedRelative = path.relative(result.tmpDir, binPath);
    expect(content).toContain(`FILE "${expectedRelative}" BINARY`);
    expect(content).toContain("MODE1/2048");
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateCueForBin } from "./cuegen.js";
import { detectTools } from "./tools.js";

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-cuegen-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tools = detectTools({ chdman: null, sevenZip: null, dolphinTool: null, maxcso: null });
const chdman = tools.find((t) => t.id === "chdman");
const chdmanPath = chdman?.found ? chdman.path : null;
const maybeIt = chdmanPath ? it : it.skip;

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

  maybeIt("produces a cue chdman can actually use, even when the bin lives outside os.tmpdir()'s tree entirely", () => {
    // Real bug: os.tmpdir() on macOS is under /var, itself a symlink to /private/var.
    // path.relative() computed against its *logical* string undercounts the ".." needed
    // by exactly the symlink's depth, since the OS resolves ".." against the *real*
    // physical tree when chdman actually opens the file — it fails with "couldn't find
    // bin file" for a path that's textually plausible but physically one level off. The
    // sibling-tmpdir case above doesn't expose this: both sides share the same symlinked
    // prefix, which cancels out. A bin file outside os.tmpdir() entirely does not.
    const outsideDir = path.join(process.cwd(), ".cuegen-symlink-test-scratch");
    mkdirSync(outsideDir, { recursive: true });
    dirs.push(outsideDir);

    const binPath = path.join(outsideDir, "track.bin");
    const sectorSize = 2352;
    const data = Buffer.alloc(5 * sectorSize);
    for (let s = 0; s < 5; s++) {
      const off = s * sectorSize;
      data[off] = 0x00;
      data.fill(0xff, off + 1, off + 11);
      data[off + 11] = 0x00;
      data[off + 15] = 0x01; // MODE1
    }
    writeFileSync(binPath, data);

    const result = generateCueForBin(binPath, data.length);
    dirs.push(result.tmpDir);

    const chdPath = path.join(outsideDir, "out.chd");
    const chdmanResult = spawnSync(chdmanPath!, ["createcd", "-i", result.cuePath, "-o", chdPath, "-f"], { encoding: "utf-8" });
    expect(chdmanResult.status).toBe(0);
    expect(existsSync(chdPath)).toBe(true);
  });
});

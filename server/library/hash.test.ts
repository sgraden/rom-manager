import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { hashFile, hashArchiveEntry } from "./hash.js";
import { detectTools } from "../convert/tools.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("hashFile", () => {
  it("computes correct CRC32/MD5/SHA-1 for a known input", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-hash-test-"));
    dirs.push(dir);
    const filePath = path.join(dir, "sample.bin");
    writeFileSync(filePath, "rom-manager-hash-test");

    const hashes = await hashFile(filePath);

    // Ground truth computed independently via node:crypto / zlib.crc32 directly.
    expect(hashes.crc32).toBe("b91ab2e5");
    expect(hashes.md5).toBe("7651d92c99ad8d5c13d0fc6b2ca7bc01");
    expect(hashes.sha1).toBe("7a21002e40b394157780cf590db3741568ab01e3");
  });

  it("produces hashes of the standard length (8/32/40 hex chars)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-hash-test-"));
    dirs.push(dir);
    const filePath = path.join(dir, "empty.bin");
    writeFileSync(filePath, "");

    const hashes = await hashFile(filePath);
    expect(hashes.crc32).toHaveLength(8);
    expect(hashes.md5).toHaveLength(32);
    expect(hashes.sha1).toHaveLength(40);
  });

  it("produces the same hashes across multiple chunks as a single-shot buffer would", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-hash-test-"));
    dirs.push(dir);
    const filePath = path.join(dir, "large.bin");
    // Larger than a single stream chunk (default highWaterMark is 64KB), to exercise
    // the incremental crc32(chunk, previousValue) accumulation across multiple reads.
    const data = Buffer.alloc(200_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    writeFileSync(filePath, data);

    const hashes = await hashFile(filePath);

    const crypto = await import("node:crypto");
    const zlib = await import("node:zlib");
    expect(hashes.crc32).toBe(zlib.crc32(data).toString(16).padStart(8, "0"));
    expect(hashes.md5).toBe(crypto.createHash("md5").update(data).digest("hex"));
    expect(hashes.sha1).toBe(crypto.createHash("sha1").update(data).digest("hex"));
  });
});

describe("hashArchiveEntry", () => {
  const sevenZip = detectTools({ chdman: null, sevenZip: null, dolphinTool: null, maxcso: null }).find((t) => t.id === "sevenZip");
  const sevenZipPath = sevenZip?.found ? sevenZip.path : null;
  const maybeIt = sevenZipPath ? it : it.skip;

  maybeIt("hashes the ROM inside an archive, not the archive itself", async () => {
    // This is what makes DAT matching work for cartridge systems, where the source
    // is almost always a .zip — the DAT indexes the ROM, not the container.
    const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-hasharch-test-"));
    try {
      const romPath = path.join(dir, "game.nes");
      const rom = Buffer.alloc(4096);
      rom.write("NES\x1a", 0, "latin1");
      randomFillSync(rom, 16, rom.length - 16);
      writeFileSync(romPath, rom);

      const archivePath = path.join(dir, "game.zip");
      expect(spawnSync("7zz", ["a", "-tzip", archivePath, romPath], { encoding: "utf-8" }).status).toBe(0);

      const fromArchive = await hashArchiveEntry(sevenZipPath!, archivePath, "game.nes");
      const fromFile = await hashFile(romPath);
      expect(fromArchive).toEqual(fromFile);

      // And it is genuinely different from hashing the container, which is the bug.
      const containerHashes = await hashFile(archivePath);
      expect(fromArchive.sha1).not.toBe(containerHashes.sha1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeIt("rejects rather than resolving to a bogus digest when the entry isn't there", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-hasharch-test-"));
    try {
      const romPath = path.join(dir, "game.nes");
      writeFileSync(romPath, "rom");
      const archivePath = path.join(dir, "game.zip");
      spawnSync("7zz", ["a", "-tzip", archivePath, romPath], { encoding: "utf-8" });

      await expect(hashArchiveEntry(sevenZipPath!, archivePath, "not-in-here.nes")).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

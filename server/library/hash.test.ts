import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile } from "./hash.js";

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

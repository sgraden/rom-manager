import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

export interface FileHashes {
  crc32: string;
  md5: string;
  sha1: string;
}

/**
 * Computes CRC32, MD5, and SHA-1 in a single pass over the file — one read,
 * three digests, so this stays cheap even against multi-gigabyte disc images.
 * zlib.crc32(chunk, previousValue) accumulates across chunks natively.
 */
export function hashStream(stream: Readable): Promise<FileHashes> {
  return new Promise((resolve, reject) => {
    const md5 = createHash("md5");
    const sha1 = createHash("sha1");
    let crc32 = 0;

    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      md5.update(buf);
      sha1.update(buf);
      crc32 = zlib.crc32(buf, crc32);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve({
        crc32: crc32.toString(16).padStart(8, "0"),
        md5: md5.digest("hex"),
        sha1: sha1.digest("hex"),
      });
    });
  });
}

export function hashFile(filePath: string): Promise<FileHashes> {
  return hashStream(createReadStream(filePath));
}

/**
 * Hashes one entry's decompressed bytes without extracting it to disk, by hashing
 * 7zz's stdout as it streams.
 *
 * This is what DAT matching actually needs: a DAT indexes the ROM inside the archive,
 * so hashing the .zip/.7z container instead produces hashes that can never match
 * anything — which is the common case for cartridge systems, where the source is
 * almost always archived.
 */
export function hashArchiveEntry(sevenZipPath: string, archivePath: string, entryName: string): Promise<FileHashes> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath, ["e", "-so", archivePath, entryName]);

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf-8")).slice(-2000);
    });

    // 7zz exits 0 when its entry filter matches nothing, writing no bytes — which
    // would otherwise hash cleanly as the empty digest and be recorded as if it were
    // the ROM's. Counting alongside the hash catches that; a second "data" listener
    // sees the same chunks as the hasher's.
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });

    const hashing = hashStream(child.stdout);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`7-Zip exited with code ${code} while reading ${entryName}: ${stderr.trim()}`));
        return;
      }
      if (bytes === 0) {
        reject(new Error(`No bytes read for ${entryName} inside ${archivePath} — the entry may not exist.`));
        return;
      }
      hashing.then(resolve, reject);
    });
  });
}

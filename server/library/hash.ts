import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
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
export function hashFile(filePath: string): Promise<FileHashes> {
  return new Promise((resolve, reject) => {
    const md5 = createHash("md5");
    const sha1 = createHash("sha1");
    let crc32 = 0;

    const stream = createReadStream(filePath);
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

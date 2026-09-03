import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import type { ByteReader } from "./types.js";

export class FileReader implements ByteReader {
  private fd: number;
  readonly size: number;

  constructor(filePath: string) {
    this.fd = openSync(filePath, "r");
    this.size = fstatSync(this.fd).size;
  }

  readAt(offset: number, length: number): Buffer | null {
    if (offset < 0 || offset >= this.size || length <= 0) return null;
    const toRead = Math.min(length, this.size - offset);
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(this.fd, buf, 0, toRead, offset);
    return buf.subarray(0, bytesRead);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** In-memory ByteReader for tests — avoids writing a temp file per test case. */
export class BufferReader implements ByteReader {
  constructor(private readonly buf: Buffer) {}

  get size(): number {
    return this.buf.length;
  }

  readAt(offset: number, length: number): Buffer | null {
    if (offset < 0 || offset >= this.buf.length || length <= 0) return null;
    return this.buf.subarray(offset, Math.min(offset + length, this.buf.length));
  }
}

/**
 * A ByteReader over the first `prefix.length` bytes of something larger — used for
 * archive entries, which are streamed to a bounded buffer rather than extracted in
 * full (see readArchiveEntryPrefix).
 *
 * `size` reports the entry's real total size, not the prefix's, because probes
 * legitimately branch on it (detectIpBinStrings clamps its read to it, cuegen's
 * sector-mode check divides by it). Reads past the prefix return null — the same
 * thing a genuine EOF returns — so a probe that needs bytes we don't have simply
 * finds no match. Callers must treat "no confident match" as possible truncation
 * and fall back to reading the whole entry.
 */
export class PrefixReader implements ByteReader {
  constructor(
    private readonly prefix: Buffer,
    readonly size: number,
  ) {}

  readAt(offset: number, length: number): Buffer | null {
    if (offset < 0 || offset >= this.prefix.length || length <= 0) return null;
    return this.prefix.subarray(offset, Math.min(offset + length, this.prefix.length));
  }
}

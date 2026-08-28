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

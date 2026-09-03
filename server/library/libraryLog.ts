import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LIBRARY_PATH } from "../lib/paths.js";
import type { FileHashes } from "./hash.js";

export interface LibraryRecord {
  timestamp: string;
  originalName: string;
  hashes: FileHashes;
  system: string;
  action: string;
  destination: string;
  sizeBefore: number;
  sizeAfter: number;
  /** Canonical name from a DAT match, if any DAT files are present in config/dats/ — informational only, never used to rename. */
  datMatch: string | null;
}

/**
 * Appends one record to data/library.json. Synchronous read-modify-write —
 * deliberate, so two jobs finishing close together (under concurrency) can't
 * race and clobber each other; Node won't interleave this with another
 * job's own synchronous append.
 */
export function appendLibraryRecord(record: LibraryRecord): void {
  let records: LibraryRecord[] = [];
  if (existsSync(LIBRARY_PATH)) {
    try {
      const raw = readFileSync(LIBRARY_PATH, "utf-8");
      records = raw.trim() ? (JSON.parse(raw) as LibraryRecord[]) : [];
    } catch {
      // Corrupt/unreadable file — start a fresh log rather than losing the ability to record anything further.
      records = [];
    }
  }
  records.push(record);
  writeFileSync(LIBRARY_PATH, JSON.stringify(records, null, 2) + "\n", "utf-8");
}

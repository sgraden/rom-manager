import { existsSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { LIBRARY_LOG_PATH, LEGACY_LIBRARY_PATH } from "../lib/paths.js";
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
 * Converts a pre-JSONL data/library.json (a single JSON array) into the line-based
 * log, once. Written to a temp file and renamed so an interrupted migration can't
 * leave a half-converted log behind, and the original is only removed after the new
 * file is safely in place.
 */
function migrateLegacyLog(): void {
  if (existsSync(LIBRARY_LOG_PATH) || !existsSync(LEGACY_LIBRARY_PATH)) return;

  let records: LibraryRecord[];
  try {
    const raw = readFileSync(LEGACY_LIBRARY_PATH, "utf-8");
    records = raw.trim() ? (JSON.parse(raw) as LibraryRecord[]) : [];
  } catch {
    // Unreadable or corrupt legacy log — leave it on disk untouched (it may still be
    // salvageable by hand) and start the new one empty rather than failing the job.
    return;
  }

  const tmpPath = `${LIBRARY_LOG_PATH}.migrating`;
  writeFileSync(tmpPath, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf-8");
  renameSync(tmpPath, LIBRARY_LOG_PATH);

  // Renamed aside, never deleted. This is the user's only copy of their processing
  // history — hashes they'd have to re-read every file to reproduce — so migration
  // must not be the step that loses it if anything about the conversion was wrong.
  try {
    renameSync(LEGACY_LIBRARY_PATH, `${LEGACY_LIBRARY_PATH}.migrated`);
  } catch {
    // best effort — the legacy file is ignored from here on either way
  }
}

/**
 * Appends one record to data/library.jsonl.
 *
 * One line per record, appended in place. The previous format re-read, re-parsed and
 * re-serialized the whole log on every job, which is quadratic as the library grows
 * and — worse — put the entire history at risk on every write, since a crash partway
 * through writeFileSync truncates all of it. An append risks only its own line.
 *
 * Synchronous, deliberately: two jobs finishing close together under concurrency
 * can't interleave, because Node won't suspend a synchronous append partway.
 */
export function appendLibraryRecord(record: LibraryRecord): void {
  migrateLegacyLog();
  appendFileSync(LIBRARY_LOG_PATH, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Reads the whole log back. A malformed line is skipped rather than failing the read:
 * the format's entire advantage is that damage stays local to one line, and the
 * Library page showing every intact record beats it showing an error.
 */
export function readLibraryRecords(): LibraryRecord[] {
  migrateLegacyLog();
  if (!existsSync(LIBRARY_LOG_PATH)) return [];

  let raw: string;
  try {
    raw = readFileSync(LIBRARY_LOG_PATH, "utf-8");
  } catch {
    return [];
  }

  const records: LibraryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as LibraryRecord);
    } catch {
      // skip the damaged line, keep the rest
    }
  }
  return records;
}

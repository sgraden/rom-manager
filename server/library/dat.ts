import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { FileHashes } from "./hash.js";

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, code: string) => {
    if (code[0] === "#") {
      const codePoint = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return XML_ENTITIES[code] ?? match;
  });
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? unescapeXml(match[1]) : null;
}

export interface DatRomEntry {
  name: string;
  crc32: string | null;
  md5: string | null;
  sha1: string | null;
}

/**
 * Extracts every <rom .../> tag's name/crc/md5/sha1 attributes from a
 * No-Intro/Redump-style DAT XML file. A small regex-based parser rather than
 * a full XML library — the DAT format used here is just flat, predictable
 * self-closing <rom> tags, and a real parser would be a dependency for
 * something this constrained.
 */
export function parseDatRoms(xml: string): DatRomEntry[] {
  const entries: DatRomEntry[] = [];
  const romTagPattern = /<rom\b[^>]*\/?>/gi;
  for (const tagMatch of xml.matchAll(romTagPattern)) {
    const tag = tagMatch[0];
    const name = attr(tag, "name");
    if (!name) continue;
    entries.push({
      name,
      crc32: attr(tag, "crc")?.toLowerCase() ?? null,
      md5: attr(tag, "md5")?.toLowerCase() ?? null,
      sha1: attr(tag, "sha1")?.toLowerCase() ?? null,
    });
  }
  return entries;
}

export interface DatIndex {
  /** Canonical rom name for a matching hash, or null if nothing in config/dats/ matches (including when the folder is empty). */
  lookup(hashes: FileHashes): string | null;
  readonly datFileCount: number;
  readonly romCount: number;
}

const EMPTY_INDEX: DatIndex = { lookup: () => null, datFileCount: 0, romCount: 0 };

/** Loads every .dat file in datsDir into a hash -> canonical-name map. Returns an always-null index if the folder is missing or empty. */
export function loadDatIndex(datsDir: string): DatIndex {
  if (!existsSync(datsDir)) return EMPTY_INDEX;

  const datFiles = readdirSync(datsDir).filter((f) => f.toLowerCase().endsWith(".dat"));
  if (datFiles.length === 0) return EMPTY_INDEX;

  const byHash = new Map<string, string>();
  let romCount = 0;

  for (const file of datFiles) {
    let xml: string;
    try {
      xml = readFileSync(path.join(datsDir, file), "utf-8");
    } catch {
      continue; // unreadable file — skip rather than fail the whole index
    }
    for (const rom of parseDatRoms(xml)) {
      romCount++;
      if (rom.crc32) byHash.set(`crc32:${rom.crc32}`, rom.name);
      if (rom.md5) byHash.set(`md5:${rom.md5}`, rom.name);
      if (rom.sha1) byHash.set(`sha1:${rom.sha1}`, rom.name);
    }
  }

  return {
    datFileCount: datFiles.length,
    romCount,
    lookup(hashes: FileHashes): string | null {
      // hashFile() always produces lowercase hex, but normalize defensively here too —
      // a DAT can use any casing, and this is the one place that actually matters.
      return (
        byHash.get(`crc32:${hashes.crc32.toLowerCase()}`) ??
        byHash.get(`sha1:${hashes.sha1.toLowerCase()}`) ??
        byHash.get(`md5:${hashes.md5.toLowerCase()}`) ??
        null
      );
    },
  };
}

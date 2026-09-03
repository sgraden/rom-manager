import path from "node:path";
import type { FileHashes } from "./hash.js";
import type { LibraryEntry, LibraryIndex } from "./libraryIndex.js";

/**
 * How a candidate was matched against something already on the card, strongest first.
 *
 * The tier is always reported alongside the match, because it is what makes the answer
 * trustworthy: "same bytes" and "same-ish name" warrant very different confidence from
 * the user before they choose to replace a file.
 */
export type MatchTier = "exact" | "likely" | "name";

export interface DuplicateMatch {
  tier: MatchTier;
  /** Plain-language reason, shown next to the Replace/Skip choice. */
  reason: string;
  entry: LibraryEntry;
}

// Region, language, revision and similar bracketed tags. Deliberately does NOT strip
// disc tokens — see DISC_TOKEN below.
const TAG_TOKEN = /[[(][^\])]*[)\]]/g;
// Matches m3u.ts's DISC_TOKEN. (Disc 1) and (Disc 2) are different games' worth of
// data, never duplicates of one another, so this token is preserved while other tags
// are stripped.
const DISC_TOKEN = /\s*[[(]\s*(?:disc|disk|cd)\s*(\d+)\s*[)\]]/i;

/**
 * A filename reduced to the part that identifies the game: extension gone, region and
 * revision tags gone, punctuation and case flattened — but any disc number preserved
 * and normalized, so multi-disc sets stay distinguishable.
 */
export function normalizeGameName(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, "");

  const discMatch = withoutExt.match(DISC_TOKEN);
  const discSuffix = discMatch ? ` disc${parseInt(discMatch[1], 10)}` : "";

  const base = withoutExt
    .replace(DISC_TOKEN, " ")
    .replace(TAG_TOKEN, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return base + discSuffix;
}

export interface DuplicateCandidate {
  /** The filename this source would land under at the destination. */
  destinationFilename: string;
  /** The folder it would land in, or null when the system isn't mapped yet. */
  destinationFolder: string | null;
  /** Content hashes, when they're already known — hashing a multi-gigabyte source just to check is too slow to do inline. */
  hashes?: FileHashes | null;
  /** Canonical DAT name for this source, when one is known. */
  datMatch?: string | null;
}

/**
 * Finds the strongest reason to believe `candidate` is already on the card.
 *
 * Tiers, in order:
 *  1. `exact`  — same content hash as a file this app recorded writing. Unambiguous.
 *  2. `likely` — both resolve to the same canonical DAT name. Catches the same game
 *                under a differently-named dump.
 *  3. `name`   — same normalized filename. The weakest signal, and the only one
 *                available for files this app didn't write.
 *
 * Returns null when nothing matches.
 */
export function findDuplicate(candidate: DuplicateCandidate, index: LibraryIndex): DuplicateMatch | null {
  // Only ever compare against the folder this file would actually land in. A PS1 disc
  // and a Saturn disc that happen to share a name are not duplicates.
  const entries = candidate.destinationFolder
    ? index.groups.flatMap((g) => g.entries).filter((e) => path.dirname(e.fullPath) === candidate.destinationFolder)
    : [];
  if (entries.length === 0) return null;

  if (candidate.hashes) {
    const sha1 = candidate.hashes.sha1.toLowerCase();
    const hit = entries.find((e) => e.record?.hashes.sha1.toLowerCase() === sha1);
    if (hit) {
      return { tier: "exact", reason: `Identical contents (matching SHA-1) to ${hit.filename}.`, entry: hit };
    }
  }

  if (candidate.datMatch) {
    const hit = entries.find((e) => e.record?.datMatch === candidate.datMatch);
    if (hit) {
      return { tier: "likely", reason: `Same game as ${hit.filename} — both match the DAT entry "${candidate.datMatch}".`, entry: hit };
    }
  }

  const normalized = normalizeGameName(candidate.destinationFilename);
  if (normalized) {
    const hit = entries.find((e) => normalizeGameName(e.filename) === normalized);
    if (hit) {
      return { tier: "name", reason: `A file with the same name is already there: ${hit.filename}.`, entry: hit };
    }
  }

  return null;
}

import path from "node:path";
import type { ConvertAction } from "./systems.js";

const ILLEGAL_EXFAT_CHARS = /["*/:<>?\\|]/g;

/** Makes a filename safe to write to an exFAT volume: no illegal chars, no trailing dot/space, capped length. */
export function sanitizeExfatName(name: string): string {
  let safe = name.replace(ILLEGAL_EXFAT_CHARS, "_").replace(/[. ]+$/, "");
  if (safe.length === 0) safe = "_";

  if (Buffer.byteLength(safe, "utf-8") > 255) {
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    // Trim conservatively (per-character, not per-byte) — good enough since this only
    // matters for pathological filenames, and exactness isn't worth the complexity here.
    safe = stem.slice(0, 255 - ext.length) + ext;
  }

  return safe;
}

const ACTION_SIZE_MULTIPLIER: Record<ConvertAction, number> = {
  "chd-cd": 0.6,
  "chd-dvd": 0.65,
  rvz: 0.55,
  "keep-zip": 1,
  copy: 1,
};

/** A rough, clearly-labeled-as-estimated size for planning purposes — actual conversion (phase 4) reports the real size. */
export function estimateOutputBytes(sourceBytes: number, action: ConvertAction): number {
  return Math.round(sourceBytes * ACTION_SIZE_MULTIPLIER[action]);
}

/**
 * A conservative upper bound for free-space checks specifically — never shown to the user
 * as "the estimate", only used to decide whether a job is safe to start. CHD/RVZ compression
 * is highly content-dependent: a disc that's mostly already-compressed video/audio (FMV-heavy
 * compilations especially) can compress poorly or even come out slightly *larger* than the
 * source, since every hunk still carries its own checksum/metadata overhead regardless of
 * whether the underlying bytes actually shrank (observed as high as ~104% of source in
 * practice). The typical multiplier above isn't safe to gate available space against — this
 * one assumes near-zero savings instead, with headroom above that one real data point. copy
 * is always exactly 1:1 already; keep-zip's zip overhead on small cartridge ROMs is negligible
 * in absolute terms, so neither needs adjusting here.
 */
const WORST_CASE_MULTIPLIER: Partial<Record<ConvertAction, number>> = {
  "chd-cd": 1.1,
  "chd-dvd": 1.1,
  rvz: 1.1,
};

export function estimateWorstCaseBytes(sourceBytes: number, action: ConvertAction): number {
  const multiplier = WORST_CASE_MULTIPLIER[action] ?? ACTION_SIZE_MULTIPLIER[action];
  return Math.round(sourceBytes * multiplier);
}

/** True if `candidate` is `dir` itself or something inside it. */
export function isPathInside(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const ACTION_EXTENSION: Record<ConvertAction, string | null> = {
  "chd-cd": ".chd",
  "chd-dvd": ".chd",
  rvz: ".rvz",
  "keep-zip": ".zip",
  copy: null, // keep the source's own extension
};

/** The filename a source will land under at the destination, given the action that will run on it. */
export function outputFilenameFor(sourceName: string, action: ConvertAction): string {
  const forcedExt = ACTION_EXTENSION[action];
  if (forcedExt === null) return sanitizeExfatName(sourceName);

  const stem = path.basename(sourceName, path.extname(sourceName));
  return sanitizeExfatName(`${stem}${forcedExt}`);
}

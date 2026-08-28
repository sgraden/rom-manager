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

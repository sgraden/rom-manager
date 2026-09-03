import { readdirSync, statSync, rmSync } from "node:fs";
import path from "node:path";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes staged-upload directories left behind by uploads that never finished.
 * Each upload gets its own UUID subdirectory (see stagedUploadPath), and a
 * successful job deletes its own; an upload interrupted by a crash or a hard
 * process kill can't, so they'd otherwise accumulate forever.
 *
 * Age-gated rather than unconditional: an upload could be in flight right now,
 * and this runs at startup while nothing else has claimed anything yet, so only
 * directories older than `maxAgeMs` are considered abandoned. Returns how many
 * were removed, for the startup log.
 */
export function sweepStaleStagingDirs(stagingDir: string, maxAgeMs = ONE_DAY_MS, now = Date.now()): number {
  let entries;
  try {
    entries = readdirSync(stagingDir, { withFileTypes: true });
  } catch {
    return 0; // staging/ doesn't exist yet — nothing to sweep
  }

  let removed = 0;
  for (const entry of entries) {
    // Only ever touch subdirectories. Files sitting directly in staging/ are from
    // the app's older flat layout (or the user's own doing) and aren't ours to delete.
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(stagingDir, entry.name);
    try {
      if (now - statSync(dirPath).mtimeMs < maxAgeMs) continue;
      rmSync(dirPath, { recursive: true, force: true });
      removed++;
    } catch {
      // best effort — an unreadable or in-use directory just stays put
    }
  }
  return removed;
}

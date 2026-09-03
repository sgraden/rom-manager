import { existsSync } from "node:fs";
import path from "node:path";

export interface DiscSet {
  cueLikePath: string;
  /** Absolute paths to referenced track files that actually exist. */
  trackFiles: string[];
  /** Absolute paths to referenced track files that were expected but not found. */
  missingTrackFiles: string[];
}

function resolveTracks(cueLikePath: string, dir: string, names: string[]): DiscSet {
  const trackFiles: string[] = [];
  const missingTrackFiles: string[] = [];
  for (const name of names) {
    const full = path.isAbsolute(name) ? name : path.join(dir, name);
    if (existsSync(full)) trackFiles.push(full);
    else missingTrackFiles.push(full);
  }
  return { cueLikePath, trackFiles, missingTrackFiles };
}

const CUE_FILE_LINE = /^\s*FILE\s+"([^"]+)"/i;

export function parseCueFile(cuePath: string, content: string): DiscSet {
  const dir = path.dirname(cuePath);
  const trackFiles: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(CUE_FILE_LINE);
    if (match) trackFiles.push(match[1]);
  }
  return resolveTracks(cuePath, dir, trackFiles);
}

/**
 * A GDI track line: `trackNo startLBA trackType sectorSize filename offset`, e.g.
 * `3 45000 4 2352 track03.bin 0`. The filename is quoted when it contains spaces.
 * The trailing offset is optional — some real .gdi files omit it.
 *
 * Matched positionally rather than by hunting for the first quoted string or the
 * first token ending in .bin/.raw/.iso, either of which picks up the wrong token on
 * a line carrying any other quoted field.
 */
const GDI_TRACK_LINE = /^\s*\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))(?:\s+\d+)?\s*$/;

export function parseGdiFile(gdiPath: string, content: string): DiscSet {
  const dir = path.dirname(gdiPath);
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const trackFiles: string[] = [];
  // First line is the track count, not a track entry.
  for (const line of lines.slice(1)) {
    const match = line.match(GDI_TRACK_LINE);
    if (!match) continue; // comment, blank, or something that isn't a track entry
    trackFiles.push(match[1] ?? match[2]);
  }
  return resolveTracks(gdiPath, dir, trackFiles);
}

/** .ccd files don't reference their data files by name — the convention is <basename>.img / <basename>.sub alongside. */
export function resolveCcdCompanions(ccdPath: string): DiscSet {
  const dir = path.dirname(ccdPath);
  const base = path.basename(ccdPath, path.extname(ccdPath));
  return resolveTracks(ccdPath, dir, [`${base}.img`, `${base}.sub`]);
}

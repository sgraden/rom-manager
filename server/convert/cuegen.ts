import { openSync, readSync, closeSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface CueGenResult {
  cuePath: string;
  /** The generated .cue's own directory — caller must clean this up when done. */
  tmpDir: string;
  mode: string;
  /** False when the mode was guessed rather than read from the sector header — surface a warning. */
  confident: boolean;
}

function readFirstBytes(filePath: string, length: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * Synthesizes a single-track .cue for a bare .bin with no accompanying cue
 * sheet at all. Sector mode is read from the first sector's mode byte
 * (offset 0x0F in a raw 2352-byte sector) when the file size is a multiple
 * of 2352; otherwise it falls back to a 2048-byte-sector guess. A wrong
 * guess here produces a CHD that won't boot, so `confident` should be
 * surfaced to the user rather than silently trusted.
 *
 * The cue's FILE line uses a path relative to the generated .cue's own
 * directory, not binPath's full path — confirmed against a real chdman 0.289
 * run that it resolves a cue's FILE reference relative to the .cue file's
 * own location, always, regardless of the process's cwd; an absolute value
 * there gets naively joined onto that directory anyway, producing a broken
 * double path. Since this generated .cue lives in its own fresh scratch
 * tmpDir rather than next to binPath, a plain basename won't reach it —
 * path.relative() is required.
 *
 * Both sides are realpath'd first: os.tmpdir() on macOS is under /var, which
 * is itself a symlink to /private/var. path.relative() works on the literal
 * string, so it undercounts the "../" needed by exactly the symlink's depth
 * — the OS resolves ".." against the real physical tree when chdman actually
 * opens the file, landing one directory short of where the string points and
 * failing with "couldn't find bin file". Confirmed against a real chdman run
 * with the tmpDir's logical vs. real path: only the realpath'd version reaches
 * the file the traversal is actually supposed to land on.
 */
export function generateCueForBin(binPath: string, binSizeBytes: number): CueGenResult {
  let mode: string;
  let confident = true;

  if (binSizeBytes > 0 && binSizeBytes % 2352 === 0) {
    const header = readFirstBytes(binPath, 16);
    const modeByte = header.length >= 16 ? header[15] : undefined;
    if (modeByte === 0x02) {
      mode = "MODE2/2352";
    } else if (modeByte === 0x01) {
      mode = "MODE1/2352";
    } else {
      mode = "MODE1/2352";
      confident = false;
    }
  } else if (binSizeBytes > 0 && binSizeBytes % 2048 === 0) {
    mode = "MODE1/2048";
  } else {
    mode = "MODE1/2352";
    confident = false;
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "rom-manager-cuegen-"));
  const cuePath = path.join(tmpDir, "generated.cue");
  const relativeBinPath = path.relative(realpathSync(tmpDir), realpathSync(binPath));
  const cueContent = `FILE "${relativeBinPath}" BINARY\n  TRACK 01 ${mode}\n    INDEX 01 00:00:00\n`;
  writeFileSync(cuePath, cueContent, "utf-8");

  return { cuePath, tmpDir, mode, confident };
}

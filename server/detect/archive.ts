import { spawnSync } from "node:child_process";

export interface ArchiveEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * Parses `7zz l -slt` output. Entries are blank-line-separated blocks of
 * `Key = Value` lines; the very first block describes the archive itself and is excluded.
 *
 * .zip listings mark each entry with `Folder = +/-`. .7z listings omit that field entirely
 * and mark directories via a `D` flag at the start of `Attributes` instead (e.g.
 * "D drwxr-xr-x" vs "A -rw-r--r--") — both are checked so both container formats work; the
 * archive's own metadata block has neither and is correctly excluded either way.
 */
export function parseSevenZipListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];

  for (const block of output.split(/\r?\n\r?\n/)) {
    const pathMatch = block.match(/^Path = (.+)$/m);
    if (!pathMatch) continue;

    const folderMatch = block.match(/^Folder = ([+-])$/m);
    const attributesMatch = block.match(/^Attributes = (\S+)/m);
    let isDirectory: boolean;
    if (folderMatch) {
      isDirectory = folderMatch[1] === "+";
    } else if (attributesMatch) {
      isDirectory = attributesMatch[1] === "D";
    } else {
      continue;
    }

    const sizeMatch = block.match(/^Size = (\d+)$/m);
    entries.push({
      name: pathMatch[1],
      isDirectory,
      size: sizeMatch ? Number(sizeMatch[1]) : 0,
    });
  }

  return entries;
}

export function listArchiveEntries(sevenZipPath: string, archivePath: string): ArchiveEntry[] {
  const result = spawnSync(sevenZipPath, ["l", "-slt", archivePath], { encoding: "utf-8", timeout: 15000 });
  if (result.error) {
    throw new Error(`Failed to run ${sevenZipPath}: ${result.error.message}`);
  }
  return parseSevenZipListing(result.stdout ?? "");
}

/**
 * Extracts an entire archive, preserving its internal directory structure. Needed
 * when the entries reference each other — a .cue and the .bin tracks it names have
 * to land together. For a single self-contained entry, prefer readArchiveEntryPrefix
 * or extractArchiveEntry, both of which avoid decompressing everything.
 *
 * Deliberately untimed: a large disc image legitimately takes minutes to decompress,
 * and the previous 120s cap killed real extractions — reporting it as "exit null",
 * since a timed-out spawnSync has no exit code, which told the user nothing.
 */
export function extractArchive(sevenZipPath: string, archivePath: string, destDir: string): void {
  const result = spawnSync(sevenZipPath, ["x", "-y", `-o${destDir}`, archivePath], {
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(`Failed to run ${sevenZipPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`7-Zip extract failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
}

/**
 * Streams the first `maxBytes` of one entry to memory without extracting the rest of
 * the archive. `-so` writes the entry to stdout; capping spawnSync's maxBuffer makes
 * Node close the pipe once that much has arrived, which SIGPIPEs 7zz and stops the
 * decompression early — so this is O(prefix), not O(entry). Measured against a 600MB
 * entry: ~90ms here versus ~830ms (plus 600MB written and deleted) for a full extract.
 *
 * The ENOBUFS/SIGPIPE outcome is the expected success path for any entry larger than
 * the cap, and Node still hands back the bytes that made it through. Returns null when
 * 7zz genuinely failed and produced nothing usable.
 */
export function readArchiveEntryPrefix(sevenZipPath: string, archivePath: string, entryName: string, maxBytes: number): Buffer | null {
  const result = spawnSync(sevenZipPath, ["e", "-so", archivePath, entryName], {
    maxBuffer: maxBytes,
    timeout: 60000,
  });

  const stdout = result.stdout as Buffer | null;
  if (!stdout || stdout.length === 0) return null;
  return stdout;
}

/** Extracts a single named entry (flattened, no directory structure) rather than the whole archive. */
export function extractArchiveEntry(sevenZipPath: string, archivePath: string, destDir: string, entryName: string): void {
  const result = spawnSync(sevenZipPath, ["e", "-y", `-o${destDir}`, archivePath, entryName], {
    encoding: "utf-8",
  });
  if (result.error) {
    throw new Error(`Failed to run ${sevenZipPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`7-Zip extract failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
}

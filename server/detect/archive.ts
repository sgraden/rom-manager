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

export function extractArchive(sevenZipPath: string, archivePath: string, destDir: string): void {
  const result = spawnSync(sevenZipPath, ["x", "-y", `-o${destDir}`, archivePath], {
    encoding: "utf-8",
    timeout: 120000,
  });
  if (result.error) {
    throw new Error(`Failed to run ${sevenZipPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`7-Zip extract failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
}

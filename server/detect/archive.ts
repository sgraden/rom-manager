import { spawnSync } from "node:child_process";

export interface ArchiveEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * Parses `7zz l -slt` output. Entries are blank-line-separated blocks of
 * `Key = Value` lines; the very first block describes the archive itself
 * (no `Folder =` line) and is excluded by requiring that field.
 */
export function parseSevenZipListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];

  for (const block of output.split(/\r?\n\r?\n/)) {
    const pathMatch = block.match(/^Path = (.+)$/m);
    const folderMatch = block.match(/^Folder = ([+-])$/m);
    if (!pathMatch || !folderMatch) continue;

    const sizeMatch = block.match(/^Size = (\d+)$/m);
    entries.push({
      name: pathMatch[1],
      isDirectory: folderMatch[1] === "+",
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

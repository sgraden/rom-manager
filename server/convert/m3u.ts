// Matches a disc-number token like "(Disc 1)", "[Disk 2]", "(CD 3)" anywhere in a filename.
const DISC_TOKEN = /\s*[[(]\s*(?:disc|disk|cd)\s*(\d+)\s*[)\]]/i;

export interface OutputFile {
  folder: string;
  filename: string;
}

interface M3uGroup {
  folder: string;
  discs: { num: number; filename: string }[];
}

/** Groups converted output files by stripping their disc-number token, keyed by "folder::baseName". */
export function groupForM3u(files: OutputFile[]): Map<string, M3uGroup> {
  const groups = new Map<string, M3uGroup>();

  for (const file of files) {
    const match = file.filename.match(DISC_TOKEN);
    if (!match) continue;

    const baseName = file.filename.replace(DISC_TOKEN, "").trim();
    const key = `${file.folder}::${baseName}`;
    const discNum = parseInt(match[1], 10);

    const existing = groups.get(key);
    if (existing) {
      if (!existing.discs.some((d) => d.filename === file.filename)) {
        existing.discs.push({ num: discNum, filename: file.filename });
      }
    } else {
      groups.set(key, { folder: file.folder, discs: [{ num: discNum, filename: file.filename }] });
    }
  }

  return groups;
}

export function m3uFilenameFor(key: string): string {
  const baseName = key.split("::").slice(1).join("::");
  const stem = baseName.replace(/\.[^.]+$/, "");
  return `${stem}.m3u`;
}

export function m3uContent(discs: { num: number; filename: string }[]): string {
  return (
    [...discs]
      .sort((a, b) => a.num - b.num)
      .map((d) => d.filename)
      .join("\n") + "\n"
  );
}

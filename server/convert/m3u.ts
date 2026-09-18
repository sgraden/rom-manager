import { parseDiscToken } from "../library/discGroup.js";

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
    const token = parseDiscToken(file.filename);
    if (!token) continue;

    const key = `${file.folder}::${token.baseName}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.discs.some((d) => d.filename === file.filename)) {
        existing.discs.push({ num: token.discNum, filename: file.filename });
      }
    } else {
      groups.set(key, { folder: file.folder, discs: [{ num: token.discNum, filename: file.filename }] });
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

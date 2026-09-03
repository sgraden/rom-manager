import path from "node:path";
import os from "node:os";
import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { FileReader } from "./fileReader.js";
import { detectCartridgeSignatures } from "./signatures.js";
import { detectDiscMagic, detectIso9660, detectIpBinStrings } from "./disc.js";
import { parseCueFile, parseGdiFile, resolveCcdCompanions, type DiscSet } from "./cuesheet.js";
import { listArchiveEntries, extractArchive } from "./archive.js";
import { systemsForExtension } from "./extensions.js";
import type { DetectionCandidate, DetectionResult } from "./types.js";

export interface DetectOptions {
  /** Resolved path to the 7zz binary, or null if it wasn't found (archives can't be inspected). */
  sevenZipPath: string | null;
}

const ARCHIVE_EXTS = new Set([".zip", ".7z", ".rar"]);
const CUE_LIKE_EXTS = new Set([".cue", ".gdi", ".ccd"]);
// .chd is included here too: it's already-converted, but its container format
// isn't parsed as ISO9660 in v1, so it only ever gets extension-fallback candidates.
const DISC_EXTS = new Set([".iso", ".bin", ".img", ".cdi", ".nrg", ".chd"]);

export function detectPath(filePath: string, options: DetectOptions): DetectionResult {
  const ext = path.extname(filePath).toLowerCase();

  if (ARCHIVE_EXTS.has(ext)) return detectArchive(filePath, options);
  if (CUE_LIKE_EXTS.has(ext)) return detectCueLike(filePath, ext);
  return detectPlainFile(filePath, ext);
}

function rankByConfidence(candidates: DetectionCandidate[]): DetectionCandidate[] {
  return [...candidates].sort((a, b) => b.confidence - a.confidence);
}

function runDiscProbes(reader: FileReader): DetectionCandidate[] {
  const candidates: DetectionCandidate[] = [];
  const magic = detectDiscMagic(reader);
  if (magic) candidates.push(magic);
  candidates.push(...detectIso9660(reader));
  candidates.push(...detectIpBinStrings(reader));
  return candidates;
}

function detectPlainFile(filePath: string, ext: string): DetectionResult {
  const reader = new FileReader(filePath);
  try {
    let candidates: DetectionCandidate[] = [];
    const isDiscExt = DISC_EXTS.has(ext);

    if (isDiscExt) {
      candidates = runDiscProbes(reader);
    }
    if (candidates.length === 0) {
      candidates = detectCartridgeSignatures(reader, ext);
    }
    if (candidates.length === 0) {
      candidates = systemsForExtension(ext).map((systemId) => ({
        systemId,
        confidence: 0.3,
        evidence: `Extension ${ext} is used by this system (no byte-level signature matched)`,
      }));
    }

    const kind = candidates.length === 0 ? "unknown" : isDiscExt ? "disc" : "cartridge";
    return { kind, candidates: rankByConfidence(candidates) };
  } finally {
    reader.close();
  }
}

function detectCueLike(cuePath: string, ext: string): DetectionResult {
  let discSet: DiscSet;
  if (ext === ".ccd") {
    discSet = resolveCcdCompanions(cuePath);
  } else {
    const content = readFileSync(cuePath, "utf-8");
    discSet = ext === ".cue" ? parseCueFile(cuePath, content) : parseGdiFile(cuePath, content);
  }

  if (discSet.trackFiles.length === 0) {
    return {
      kind: "unknown",
      candidates: [],
      warnings: [
        `No referenced track file(s) found next to ${path.basename(cuePath)}` +
          (discSet.missingTrackFiles.length ? `: missing ${discSet.missingTrackFiles.map((f) => path.basename(f)).join(", ")}` : ""),
      ],
    };
  }

  const reader = new FileReader(discSet.trackFiles[0]);
  try {
    const candidates = runDiscProbes(reader);
    const warnings = discSet.missingTrackFiles.length
      ? [`Referenced track file(s) missing: ${discSet.missingTrackFiles.map((f) => path.basename(f)).join(", ")}`]
      : undefined;

    return {
      kind: "disc",
      candidates: rankByConfidence(candidates),
      warnings,
      relatedFiles: discSet.trackFiles,
    };
  } finally {
    reader.close();
  }
}

function detectArchive(archivePath: string, options: DetectOptions): DetectionResult {
  if (!options.sevenZipPath) {
    return { kind: "archive", candidates: [], warnings: ["7zz not found — cannot inspect archive contents"] };
  }

  const entries = listArchiveEntries(options.sevenZipPath, archivePath).filter((e) => !e.isDirectory);
  if (entries.length === 0) {
    return { kind: "archive", candidates: [], warnings: ["Archive appears to contain no files"] };
  }

  const cueEntry = entries.find((e) => /\.(cue|gdi|ccd)$/i.test(e.name));

  // A single ROM, or a disc set (identified by a .cue/.gdi/.ccd among the
  // entries), can be resolved exactly by extracting and re-running detection
  // on the extracted file. Anything else is left for manual review rather
  // than guessed at from filenames alone.
  if (entries.length !== 1 && !cueEntry) {
    return {
      kind: "archive",
      candidates: [],
      warnings: [`Archive contains ${entries.length} files with no single ROM or disc set — needs manual review`],
    };
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "rom-manager-detect-"));
  try {
    extractArchive(options.sevenZipPath, archivePath, tmpDir);
    const targetName = cueEntry ? cueEntry.name : entries[0].name;
    const targetPath = path.join(tmpDir, targetName);
    if (!existsSync(targetPath)) {
      return { kind: "archive", candidates: [], warnings: [`Extracted archive did not contain expected entry ${targetName}`] };
    }

    const inner = detectPath(targetPath, options);
    return {
      kind: inner.kind,
      candidates: inner.candidates.map((c) => ({ ...c, evidence: `(inside archive) ${c.evidence}` })),
      warnings: inner.warnings,
      relatedFiles: [archivePath],
      // The archive's own size (what the caller stat'd) is its *compressed* size — this is
      // the real decompressed content size, which is what size estimates and sector-alignment
      // checks actually need.
      contentBytes: inner.contentBytes ?? statSync(targetPath).size,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

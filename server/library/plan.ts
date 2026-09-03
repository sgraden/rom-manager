import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { detectPath, type DetectOptions } from "../detect/index.js";
import type { DetectionCandidate, DetectionResult } from "../detect/types.js";
import { getSystem, type ConvertAction } from "./systems.js";
import { resolveFolderMap, type TargetInfo } from "./targets.js";
import { sanitizeExfatName, estimateOutputBytes, outputFilenameFor } from "./fsutil.js";
import type { AppConfig } from "./config.js";

export interface PlanOverride {
  systemId?: string;
  action?: ConvertAction;
  /**
   * Overwrite whatever is already at the destination. Off by default: a destination
   * collision fails the job rather than silently replacing a file the user may not
   * have realised was there.
   */
  replace?: boolean;
}

const VALID_ACTIONS = new Set<ConvertAction>(["chd-cd", "chd-dvd", "rvz", "keep-zip", "copy"]);

/**
 * Validates the client-supplied `overrides` object shared by the plan and
 * jobs routes. Returns either the parsed overrides or a single error string
 * describing the first problem found.
 */
export function parsePlanOverrides(raw: unknown): { overrides: Record<string, PlanOverride> } | { error: string } {
  if (raw === undefined) return { overrides: {} };
  if (typeof raw !== "object" || raw === null) {
    return { error: "overrides must be an object keyed by source path." };
  }

  const overrides: Record<string, PlanOverride> = {};
  for (const [sourcePath, value] of Object.entries(raw as Record<string, unknown>)) {
    const o = value as { systemId?: unknown; action?: unknown; replace?: unknown };
    const entry: PlanOverride = {};

    if (o.systemId !== undefined) {
      if (typeof o.systemId !== "string" || !getSystem(o.systemId)) {
        return { error: `Unknown systemId in overrides: ${String(o.systemId)}` };
      }
      entry.systemId = o.systemId;
    }
    if (o.action !== undefined) {
      if (typeof o.action !== "string" || !VALID_ACTIONS.has(o.action as ConvertAction)) {
        return { error: `Unknown action in overrides: ${String(o.action)}` };
      }
      entry.action = o.action as ConvertAction;
    }
    if (o.replace !== undefined) {
      if (typeof o.replace !== "boolean") {
        return { error: `replace must be a boolean, got ${String(o.replace)}` };
      }
      entry.replace = o.replace;
    }
    overrides[sourcePath] = entry;
  }
  return { overrides };
}

export interface PlannedJob {
  sourcePath: string;
  sourceName: string;
  sourceBytes: number;
  sourceKind: "cartridge" | "disc" | "archive" | "unknown";
  candidates: DetectionCandidate[];
  selectedSystemId: string | null;
  action: ConvertAction | null;
  destinationFolder: string | null;
  destinationFilename: string | null;
  estimatedOutputBytes: number | null;
  warnings: string[];
  /** True when the user explicitly chose to overwrite an existing destination file. */
  replace: boolean;
  /**
   * The file on the card this job is replacing, when the user chose Replace and the
   * match has a different filename to what this job will write. Always derived
   * server-side from the library index — never accepted from the client, since it
   * names a file that will be deleted.
   */
  replacesPath: string | null;
}

export function buildPlan(
  sourcePaths: string[],
  target: TargetInfo,
  config: AppConfig,
  options: DetectOptions,
  overrides: Record<string, PlanOverride> = {},
): PlannedJob[] {
  const { folderMap } = resolveFolderMap(target, config);
  return sourcePaths.map((sourcePath) => buildOne(sourcePath, target, folderMap, options, overrides[sourcePath]));
}

function buildOne(
  sourcePath: string,
  target: TargetInfo,
  folderMap: Record<string, string>,
  options: DetectOptions,
  override?: PlanOverride,
): PlannedJob {
  const warnings: string[] = [];
  const sourceName = path.basename(sourcePath);

  let sourceBytes = 0;
  try {
    sourceBytes = statSync(sourcePath).size;
  } catch {
    warnings.push("Could not read source file size.");
  }

  // Detection reads the file (and, for archives, shells out to 7zz), so anything from a
  // source that vanished mid-session to a permissions problem to a malformed archive can
  // throw here. Contain it per-file: an unreadable file becomes an ordinary unresolved row
  // the Review page already knows how to render, rather than a 500 that discards the plan
  // for every other file in the batch.
  let detection: DetectionResult;
  try {
    detection = detectPath(sourcePath, options);
  } catch (err) {
    detection = {
      kind: "unknown",
      candidates: [],
      warnings: [`Could not inspect this file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  if (detection.warnings) warnings.push(...detection.warnings);

  // For an archive, statSync above measured the *compressed* .7z/.zip size — size estimates,
  // free-space checks, and the sector-alignment check below all need the real decompressed
  // content size instead, when detection was able to determine it.
  if (detection.contentBytes !== undefined) {
    sourceBytes = detection.contentBytes;
  }

  const topCandidate = detection.candidates[0] ?? null;
  const selectedSystemId = override?.systemId ?? topCandidate?.systemId ?? null;
  const system = selectedSystemId ? getSystem(selectedSystemId) : undefined;
  let action = override?.action ?? system?.defaultAction ?? null;

  // PS2 uniquely (among our chd-dvd-default systems) shipped on both CD-ROM and DVD-ROM —
  // early titles like Smuggler's Run are CD-based. A raw CD dump's size is an exact multiple
  // of a 2352-byte sector but not a 2048-byte one; chdman's createdvd rejects that outright
  // (see cuegen.ts, which uses the same signal for bare .bin files). Catch it here instead of
  // letting the job fail with an opaque chdman error after the user clicks Process.
  if (!override?.action && selectedSystemId === "ps2" && action === "chd-dvd" && sourceBytes > 0 && sourceBytes % 2352 === 0 && sourceBytes % 2048 !== 0) {
    action = "chd-cd";
    warnings.push("Detected as a CD-mode PS2 dump (size is a multiple of 2352 bytes, not 2048) — using chd-cd instead of the usual chd-dvd.");
  }

  // Only warn about detection confidence when the user hasn't already made the call themselves.
  if (!override?.systemId) {
    if (!selectedSystemId) {
      warnings.push("Could not identify a system for this file — select one manually.");
    } else if (topCandidate && topCandidate.confidence < 0.6) {
      warnings.push(`Low-confidence match (${Math.round(topCandidate.confidence * 100)}%) — double-check before processing.`);
    }
  }

  let destinationFolder: string | null = null;
  let destinationFilename: string | null = null;
  let estimatedOutputBytes: number | null = null;

  if (selectedSystemId && action) {
    const folderName = folderMap[selectedSystemId];
    if (!folderName) {
      warnings.push(`No destination folder mapped for ${system?.name ?? selectedSystemId} on ${target.name} — assign one in Settings.`);
    } else {
      destinationFolder = path.join(target.romRoot, folderName);
    }

    destinationFilename = outputFilenameFor(sourceName, action);
    estimatedOutputBytes = estimateOutputBytes(sourceBytes, action);

    if (destinationFolder) {
      const destPath = path.join(destinationFolder, sanitizeExfatName(destinationFilename));
      if (existsSync(destPath) && !override?.replace) {
        warnings.push(`A file named "${destinationFilename}" already exists at the destination.`);
      }
    }

    if (target.freeBytes !== null && estimatedOutputBytes > target.freeBytes) {
      warnings.push(
        `Estimated output (~${Math.round(estimatedOutputBytes / 1024 / 1024)} MB) exceeds free space on ${target.name} (${Math.round(target.freeBytes / 1024 / 1024)} MB).`,
      );
    }
  }

  if (!target.writable) {
    warnings.push(`${target.name} is not writable.`);
  }

  return {
    sourcePath,
    sourceName,
    sourceBytes,
    sourceKind: detection.kind,
    candidates: detection.candidates,
    selectedSystemId,
    action,
    destinationFolder,
    destinationFilename,
    estimatedOutputBytes,
    warnings,
    replace: override?.replace ?? false,
    replacesPath: null,
  };
}

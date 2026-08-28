import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { detectPath, type DetectOptions } from "../detect/index.js";
import type { DetectionCandidate } from "../detect/types.js";
import { getSystem, type ConvertAction } from "./systems.js";
import { resolveFolderMap, type TargetInfo } from "./targets.js";
import { sanitizeExfatName, estimateOutputBytes, outputFilenameFor } from "./fsutil.js";
import type { AppConfig } from "./config.js";

export interface PlanOverride {
  systemId?: string;
  action?: ConvertAction;
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
    const o = value as { systemId?: unknown; action?: unknown };
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

  const detection = detectPath(sourcePath, options);
  if (detection.warnings) warnings.push(...detection.warnings);

  const topCandidate = detection.candidates[0] ?? null;
  const selectedSystemId = override?.systemId ?? topCandidate?.systemId ?? null;
  const system = selectedSystemId ? getSystem(selectedSystemId) : undefined;
  const action = override?.action ?? system?.defaultAction ?? null;

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
      if (existsSync(destPath)) {
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
  };
}

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { CONFIG_PATH, CONFIG_EXAMPLE_PATH, CONFIG_DIR, DATS_DIR, DATA_DIR, STAGING_DIR } from "../lib/paths.js";

export interface ToolPathOverrides {
  chdman: string | null;
  sevenZip: string | null;
  dolphinTool: string | null;
  maxcso: string | null;
}

export interface AppConfig {
  port: number;
  maxConcurrentJobs: number;
  /**
   * CPU cores to always leave free for the rest of the system (browsing,
   * etc). Each concurrent chdman/7zz process is capped to a fair share of
   * the remaining cores via -np/-mmt, computed as (available cores -
   * reservedCpuCores) / maxConcurrentJobs. 0 disables capping entirely.
   */
  reservedCpuCores: number;
  verifyAfterConvert: boolean;
  deleteSourceAfterSuccess: boolean;
  additionalTargetPaths: string[];
  toolPathOverrides: ToolPathOverrides;
  targetFolderMaps: Record<string, { romRoot: string; folderMap: Record<string, string> }>;
  systemActionOverrides: Record<string, string>;
}

const DEFAULTS: Pick<AppConfig, "reservedCpuCores"> = {
  reservedCpuCores: 2,
};

function ensureRuntimeDirs(): void {
  for (const dir of [CONFIG_DIR, DATS_DIR, DATA_DIR, STAGING_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  ensureRuntimeDirs();

  if (!existsSync(CONFIG_PATH)) {
    copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  // Backfill any fields added since a user's config.json was first generated,
  // so upgrading the app doesn't require deleting/regenerating their config.
  cached = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppConfig>) } as AppConfig;
  return cached;
}

export function saveConfig(next: AppConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  cached = next;
}

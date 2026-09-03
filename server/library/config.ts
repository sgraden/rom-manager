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

/**
 * A complete AppConfig, not a partial one. Every field a user's config.json is
 * missing is backfilled from here, so a config.json written by an older version of
 * the app keeps working after an upgrade rather than leaving a field `undefined`
 * for something downstream to dereference (resolveFolderMap reads
 * config.targetFolderMaps[...] unguarded, for one).
 */
const DEFAULTS: AppConfig = {
  port: 3001,
  maxConcurrentJobs: 2,
  reservedCpuCores: 2,
  verifyAfterConvert: true,
  deleteSourceAfterSuccess: false,
  additionalTargetPaths: [],
  toolPathOverrides: { chdman: null, sevenZip: null, dolphinTool: null, maxcso: null },
  targetFolderMaps: {},
  systemActionOverrides: {},
};

/**
 * Fills in anything the stored config omits. toolPathOverrides is merged one level
 * deeper than the rest — a config that sets only `chdman` must still end up with
 * the other three keys present, since detectTools indexes into it by tool id.
 */
export function withDefaults(stored: Partial<AppConfig>): AppConfig {
  return {
    ...DEFAULTS,
    ...stored,
    toolPathOverrides: { ...DEFAULTS.toolPathOverrides, ...(stored.toolPathOverrides ?? {}) },
  };
}

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
  let stored: Partial<AppConfig> = {};
  try {
    stored = raw.trim() ? (JSON.parse(raw) as Partial<AppConfig>) : {};
  } catch (err) {
    // A hand-edited config with a stray comma shouldn't make the app unstartable —
    // fall back to defaults and say so loudly rather than crashing on boot.
    console.error(`config.json is not valid JSON (${err instanceof Error ? err.message : err}) — using defaults for this run.`);
  }

  cached = withDefaults(stored);
  return cached;
}

export function saveConfig(next: AppConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  cached = next;
}

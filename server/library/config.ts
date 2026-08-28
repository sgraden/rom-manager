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
  verifyAfterConvert: boolean;
  deleteSourceAfterSuccess: boolean;
  additionalTargetPaths: string[];
  toolPathOverrides: ToolPathOverrides;
  targetFolderMaps: Record<string, { romRoot: string; folderMap: Record<string, string> }>;
  systemActionOverrides: Record<string, string>;
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
  cached = JSON.parse(raw) as AppConfig;
  return cached;
}

export function saveConfig(next: AppConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  cached = next;
}

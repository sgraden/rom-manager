import { readdirSync, statfsSync, accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { SYSTEMS, findByFolderAlias } from "./systems.js";
import type { AppConfig } from "./config.js";

export interface TargetInfo {
  name: string;
  path: string;
  romRoot: string;
  freeBytes: number | null;
  totalBytes: number | null;
  fsType: string | null;
  writable: boolean;
  folders: string[];
}

interface MountEntry {
  mountpoint: string;
  fsType: string;
}

/**
 * The mount table, re-read at most once every MOUNT_CACHE_MS. listTargets is called by
 * /api/targets, /api/plan, POST /api/jobs and three /api/targets/:name routes (one of
 * which calls it twice), each shelling out to `mount` — but volumes don't appear or
 * disappear within a single request, so a short cache costs nothing in accuracy and
 * takes a subprocess off most of those paths.
 */
const MOUNT_CACHE_MS = 3000;
let mountCache: { at: number; entries: MountEntry[] } | null = null;

/** Parses `mount` output, e.g. `/dev/disk4s1 on /Volumes/ROMSCARD (exfat, local, ...)`. */
function getMounts(): MountEntry[] {
  if (mountCache && Date.now() - mountCache.at < MOUNT_CACHE_MS) return mountCache.entries;

  const result = spawnSync("mount", [], { encoding: "utf-8", timeout: 5000 });
  if (result.error || !result.stdout) return [];

  const entries: MountEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\S+\son\s(.+)\s\(([^,)]+)/);
    if (match) entries.push({ mountpoint: match[1], fsType: match[2] });
  }
  mountCache = { at: Date.now(), entries };
  return entries;
}

function fsTypeFor(targetPath: string, mounts: MountEntry[]): string | null {
  // Longest matching mountpoint prefix wins (a volume's mountpoint is a prefix
  // of any path inside it).
  let best: MountEntry | null = null;
  for (const entry of mounts) {
    if (targetPath === entry.mountpoint || targetPath.startsWith(entry.mountpoint + "/")) {
      if (!best || entry.mountpoint.length > best.mountpoint.length) best = entry;
    }
  }
  return best?.fsType ?? null;
}

/** Re-checks free space at an arbitrary path (e.g. right before a write, when a listed TargetInfo's figure may be stale). */
export function getFreeBytes(targetPath: string): number | null {
  return getSpace(targetPath).freeBytes;
}

function getSpace(targetPath: string): { freeBytes: number | null; totalBytes: number | null } {
  try {
    const s = statfsSync(targetPath);
    return {
      freeBytes: Number(s.bavail) * Number(s.bsize),
      totalBytes: Number(s.blocks) * Number(s.bsize),
    };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

function isWritable(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function listFolders(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** A destination's "roms" folder, if one exists directly under it — otherwise the destination itself. */
function findRomRoot(targetPath: string): string {
  const candidate = path.join(targetPath, "roms");
  return existsSync(candidate) ? candidate : targetPath;
}

function buildTargetInfo(targetPath: string, mounts: MountEntry[]): TargetInfo {
  const romRoot = findRomRoot(targetPath);
  const { freeBytes, totalBytes } = getSpace(targetPath);

  return {
    name: path.basename(targetPath),
    path: targetPath,
    romRoot,
    freeBytes,
    totalBytes,
    fsType: fsTypeFor(targetPath, mounts),
    writable: isWritable(targetPath),
    folders: listFolders(romRoot),
  };
}

const VOLUME_EXCLUDES = new Set(["Macintosh HD", "Macintosh HD - Data"]);

export function listTargets(additionalTargetPaths: string[]): TargetInfo[] {
  const mounts = getMounts();
  const targets: TargetInfo[] = [];

  const volumesDir = "/Volumes";
  for (const name of listFolders(volumesDir)) {
    if (VOLUME_EXCLUDES.has(name)) continue;
    targets.push(buildTargetInfo(path.join(volumesDir, name), mounts));
  }

  for (const extra of additionalTargetPaths) {
    if (existsSync(extra)) targets.push(buildTargetInfo(extra, mounts));
  }

  return targets;
}

export interface FolderMapResult {
  /** systemId -> folder name (relative to the target's romRoot). */
  folderMap: Record<string, string>;
  unmatchedFolders: string[];
  unmappedSystemIds: string[];
}

/**
 * Resolves which of a target's existing folders each system should use.
 * Starts from any persisted override, then fills gaps by matching folder
 * names against each system's aliases. Never invents a folder that doesn't
 * already exist on the target.
 */
export function resolveFolderMap(target: TargetInfo, config: AppConfig): FolderMapResult {
  const persisted = config.targetFolderMaps[target.name]?.folderMap ?? {};
  const folderMap: Record<string, string> = { ...persisted };
  const usedFolders = new Set(Object.values(folderMap));

  for (const folder of target.folders) {
    if (usedFolders.has(folder)) continue;
    const system = findByFolderAlias(folder);
    if (system && !folderMap[system.id]) {
      folderMap[system.id] = folder;
      usedFolders.add(folder);
    }
  }

  const mappedFolders = new Set(Object.values(folderMap));
  const unmatchedFolders = target.folders.filter((f) => !mappedFolders.has(f));
  const unmappedSystemIds = SYSTEMS.filter((s) => !folderMap[s.id]).map((s) => s.id);

  return { folderMap, unmatchedFolders, unmappedSystemIds };
}

/** Writes a resolved (or manually edited) folder map back into config, keyed by target name. */
export function persistFolderMap(config: AppConfig, target: TargetInfo, folderMap: Record<string, string>): void {
  config.targetFolderMaps[target.name] = { romRoot: target.romRoot, folderMap };
}

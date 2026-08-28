import { Router } from "express";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { listTargets, resolveFolderMap, persistFolderMap } from "../library/targets.js";
import { loadConfig, saveConfig } from "../library/config.js";
import { getSystem } from "../library/systems.js";
import { sanitizeExfatName } from "../library/fsutil.js";

export const targetsRouter = Router();

targetsRouter.get("/", (_req, res) => {
  const config = loadConfig();
  res.json({ targets: listTargets(config.additionalTargetPaths) });
});

function findTarget(name: string, additionalTargetPaths: string[]) {
  return listTargets(additionalTargetPaths).find((t) => t.name === name);
}

/**
 * Resolves (auto-matching new folders via alias, keeping prior overrides) and
 * persists the folder map in one step, so it "survives remounts" as intended.
 */
targetsRouter.get("/:name/folder-map", (req, res) => {
  const config = loadConfig();
  const target = findTarget(req.params.name, config.additionalTargetPaths);
  if (!target) {
    res.status(404).json({ error: `No such target: ${req.params.name}` });
    return;
  }

  const result = resolveFolderMap(target, config);
  persistFolderMap(config, target, result.folderMap);
  saveConfig(config);

  res.json(result);
});

targetsRouter.put("/:name/folder-map", (req, res) => {
  const { systemId, folder } = req.body ?? {};
  if (typeof systemId !== "string" || systemId.length === 0) {
    res.status(400).json({ error: "systemId is required." });
    return;
  }

  const config = loadConfig();
  const target = findTarget(req.params.name, config.additionalTargetPaths);
  if (!target) {
    res.status(404).json({ error: `No such target: ${req.params.name}` });
    return;
  }

  const result = resolveFolderMap(target, config);

  if (folder === null || folder === "") {
    delete result.folderMap[systemId];
  } else {
    if (typeof folder !== "string" || !target.folders.includes(folder)) {
      res.status(400).json({ error: "folder must be one of this target's existing folders — folders are never created automatically." });
      return;
    }
    result.folderMap[systemId] = folder;
  }

  persistFolderMap(config, target, result.folderMap);
  saveConfig(config);

  res.json(resolveFolderMap(target, config));
});

/**
 * Creates a new system folder on the destination and maps the system to it.
 * This is the one place the app is allowed to create a directory — everywhere
 * else, a folder must already exist. Defaults to the system's canonical
 * folder name (its first alias, e.g. "ps2"), which matches the convention
 * used by ES-DE/Batocera-derived frontends most handhelds ship with.
 */
targetsRouter.post("/:name/folders", (req, res) => {
  const { systemId, folderName } = req.body ?? {};
  if (typeof systemId !== "string" || systemId.length === 0) {
    res.status(400).json({ error: "systemId is required." });
    return;
  }
  const system = getSystem(systemId);
  if (!system) {
    res.status(400).json({ error: `Unknown systemId: ${systemId}` });
    return;
  }

  const config = loadConfig();
  const target = findTarget(req.params.name, config.additionalTargetPaths);
  if (!target) {
    res.status(404).json({ error: `No such target: ${req.params.name}` });
    return;
  }
  if (!target.writable) {
    res.status(400).json({ error: `${target.name} is not writable.` });
    return;
  }

  const requested = typeof folderName === "string" && folderName.trim().length > 0 ? folderName.trim() : (system.folderAliases[0] ?? system.id);
  const safeName = sanitizeExfatName(requested);
  const fullPath = path.join(target.romRoot, safeName);

  if (existsSync(fullPath)) {
    res.status(409).json({ error: `A folder named "${safeName}" already exists on ${target.name}.` });
    return;
  }

  try {
    mkdirSync(fullPath);
  } catch (err) {
    res.status(500).json({ error: `Failed to create folder: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  // Re-list so the new folder is reflected before resolving/persisting the map.
  const refreshedTarget = listTargets(config.additionalTargetPaths).find((t) => t.name === target.name)!;
  const result = resolveFolderMap(refreshedTarget, config);
  result.folderMap[systemId] = safeName;
  persistFolderMap(config, refreshedTarget, result.folderMap);
  saveConfig(config);

  res.status(201).json(resolveFolderMap(refreshedTarget, config));
});

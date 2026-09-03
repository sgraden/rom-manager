import { Router } from "express";
import { execFile } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { buildLibraryIndex } from "../library/libraryIndex.js";
import { findDuplicate, type DuplicateCandidate } from "../library/duplicates.js";
import { listTargets } from "../library/targets.js";
import { loadConfig } from "../library/config.js";
import { detectTools } from "../convert/tools.js";
import { buildPlan, parsePlanOverrides } from "../library/plan.js";
import { isPathInside } from "../library/fsutil.js";

export const libraryRouter = Router();

type TargetLookup =
  | { ok: true; target: ReturnType<typeof listTargets>[number]; config: ReturnType<typeof loadConfig> }
  | { ok: false; status: number; error: string };

function findTarget(name: unknown): TargetLookup {
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, status: 400, error: "target is required." };
  }
  const config = loadConfig();
  const target = listTargets(config.additionalTargetPaths).find((t) => t.name === name);
  if (!target) return { ok: false, status: 404, error: `No such target: ${name}` };
  return { ok: true, target, config };
}

/** Everything currently on a destination, grouped by system folder. */
libraryRouter.get("/", (req, res) => {
  const found = findTarget(req.query.target);
  if (!found.ok) {
    res.status(found.status).json({ error: found.error });
    return;
  }

  try {
    res.json(buildLibraryIndex(found.target, found.config));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * For each source path, whether something matching it is already on the card.
 *
 * The plan is rebuilt server-side rather than trusting client-supplied destinations,
 * for the same reason POST /api/jobs does: the answer has to reflect what would
 * actually be written right now.
 */
libraryRouter.post("/matches", (req, res) => {
  const { sourcePaths, target: targetName, overrides } = req.body ?? {};
  if (!Array.isArray(sourcePaths) || !sourcePaths.every((p) => typeof p === "string")) {
    res.status(400).json({ error: "sourcePaths must be an array of strings." });
    return;
  }

  const found = findTarget(targetName);
  if (!found.ok) {
    res.status(found.status).json({ error: found.error });
    return;
  }

  const parsed = parsePlanOverrides(overrides);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const index = buildLibraryIndex(found.target, found.config);
    const sevenZip = detectTools(found.config.toolPathOverrides).find((t) => t.id === "sevenZip");
    const planned = buildPlan(
      sourcePaths,
      found.target,
      found.config,
      { sevenZipPath: sevenZip?.found ? sevenZip.path : null },
      parsed.overrides,
    );

    const matches = planned.map((job) => {
      if (!job.destinationFilename) return { sourcePath: job.sourcePath, match: null };
      const candidate: DuplicateCandidate = {
        destinationFilename: job.destinationFilename,
        destinationFolder: job.destinationFolder,
      };
      return { sourcePath: job.sourcePath, match: findDuplicate(candidate, index) };
    });

    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Deletes one file from a destination.
 *
 * The path is rebuilt from the target's own romRoot and re-checked with isPathInside
 * rather than being taken from the client, so no combination of `folder`/`filename`
 * can reach outside the card — and a directory is never removed, only a file.
 */
libraryRouter.delete("/entry", (req, res) => {
  const { target: targetName, folder, filename } = req.body ?? {};
  if (typeof folder !== "string" || typeof filename !== "string" || !folder || !filename) {
    res.status(400).json({ error: "folder and filename are required." });
    return;
  }

  const found = findTarget(targetName);
  if (!found.ok) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  if (!found.target.writable) {
    res.status(400).json({ error: `${found.target.name} is not writable.` });
    return;
  }

  const fullPath = path.join(found.target.romRoot, folder, filename);
  if (!isPathInside(fullPath, found.target.romRoot)) {
    res.status(400).json({ error: "Refusing to delete a path outside this destination." });
    return;
  }
  if (!existsSync(fullPath)) {
    res.status(404).json({ error: `No such file: ${filename}` });
    return;
  }
  if (!statSync(fullPath).isFile()) {
    res.status(400).json({ error: "Only files can be deleted here, not folders." });
    return;
  }

  try {
    unlinkSync(fullPath);
    res.json({ ok: true, deleted: fullPath });
  } catch (err) {
    res.status(500).json({ error: `Couldn't delete it: ${err instanceof Error ? err.message : String(err)}` });
  }
});

/** Opens the file in Finder with it selected — the Library page's "Reveal" action. */
libraryRouter.post("/reveal", (req, res) => {
  if (process.platform !== "darwin") {
    res.status(400).json({ error: "Revealing in Finder is only available on macOS." });
    return;
  }

  const { target: targetName, folder, filename } = req.body ?? {};
  const found = findTarget(targetName);
  if (!found.ok) {
    res.status(found.status).json({ error: found.error });
    return;
  }
  if (typeof folder !== "string" || typeof filename !== "string") {
    res.status(400).json({ error: "folder and filename are required." });
    return;
  }

  const fullPath = path.join(found.target.romRoot, folder, filename);
  if (!isPathInside(fullPath, found.target.romRoot) || !existsSync(fullPath)) {
    res.status(404).json({ error: "No such file on this destination." });
    return;
  }

  execFile("open", ["-R", fullPath], (err) => {
    if (err) {
      res.status(500).json({ error: `Couldn't open Finder: ${err.message}` });
      return;
    }
    res.json({ ok: true });
  });
});

import { Router } from "express";
import { buildPlan, parsePlanOverrides } from "../library/plan.js";
import { listTargets } from "../library/targets.js";
import { loadConfig } from "../library/config.js";
import { detectTools } from "../convert/tools.js";

export const planRouter = Router();

planRouter.post("/", (req, res) => {
  const { sourcePaths, targetName, overrides } = req.body ?? {};

  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || !sourcePaths.every((p) => typeof p === "string")) {
    res.status(400).json({ error: "sourcePaths must be a non-empty array of strings." });
    return;
  }
  if (typeof targetName !== "string" || targetName.length === 0) {
    res.status(400).json({ error: "targetName is required." });
    return;
  }

  const parsed = parsePlanOverrides(overrides);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  const config = loadConfig();
  const targets = listTargets(config.additionalTargetPaths);
  const target = targets.find((t) => t.name === targetName);
  if (!target) {
    res.status(404).json({ error: `No such target: ${targetName}` });
    return;
  }

  const sevenZip = detectTools(config.toolPathOverrides).find((t) => t.id === "sevenZip");

  try {
    const jobs = buildPlan(sourcePaths, target, config, { sevenZipPath: sevenZip?.found ? sevenZip.path : null }, parsed.overrides);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

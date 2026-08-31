import { Router } from "express";
import os from "node:os";
import { loadConfig, saveConfig } from "../library/config.js";
import { jobQueue } from "../jobs/queueInstance.js";

export const configRouter = Router();

/** The subset of config it's safe to edit from Settings — not tool paths, folder maps, etc, which have their own routes. */
function editableSlice(config: ReturnType<typeof loadConfig>) {
  return {
    maxConcurrentJobs: config.maxConcurrentJobs,
    reservedCpuCores: config.reservedCpuCores,
    verifyAfterConvert: config.verifyAfterConvert,
    deleteSourceAfterSuccess: config.deleteSourceAfterSuccess,
  };
}

configRouter.get("/", (_req, res) => {
  res.json({ ...editableSlice(loadConfig()), cpuCoreCount: os.availableParallelism() });
});

configRouter.put("/", (req, res) => {
  const body = req.body ?? {};
  const config = loadConfig();

  if (body.maxConcurrentJobs !== undefined) {
    if (typeof body.maxConcurrentJobs !== "number" || !Number.isInteger(body.maxConcurrentJobs) || body.maxConcurrentJobs < 1) {
      res.status(400).json({ error: "maxConcurrentJobs must be an integer >= 1." });
      return;
    }
    config.maxConcurrentJobs = body.maxConcurrentJobs;
  }

  if (body.reservedCpuCores !== undefined) {
    if (typeof body.reservedCpuCores !== "number" || !Number.isInteger(body.reservedCpuCores) || body.reservedCpuCores < 0) {
      res.status(400).json({ error: "reservedCpuCores must be an integer >= 0." });
      return;
    }
    config.reservedCpuCores = body.reservedCpuCores;
  }

  if (body.verifyAfterConvert !== undefined) {
    if (typeof body.verifyAfterConvert !== "boolean") {
      res.status(400).json({ error: "verifyAfterConvert must be a boolean." });
      return;
    }
    config.verifyAfterConvert = body.verifyAfterConvert;
  }

  if (body.deleteSourceAfterSuccess !== undefined) {
    if (typeof body.deleteSourceAfterSuccess !== "boolean") {
      res.status(400).json({ error: "deleteSourceAfterSuccess must be a boolean." });
      return;
    }
    config.deleteSourceAfterSuccess = body.deleteSourceAfterSuccess;
  }

  saveConfig(config);
  // A raised maxConcurrentJobs doesn't take effect on its own — nothing else
  // re-triggers the queue once jobs are already running/queued.
  jobQueue.recheckCapacity();
  res.json({ ...editableSlice(config), cpuCoreCount: os.availableParallelism() });
});

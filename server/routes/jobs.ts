import { Router } from "express";
import { buildPlan, parsePlanOverrides } from "../library/plan.js";
import { listTargets } from "../library/targets.js";
import { loadConfig } from "../library/config.js";
import { detectTools } from "../convert/tools.js";
import { jobQueue } from "../jobs/queueInstance.js";

export const jobsRouter = Router();

jobsRouter.get("/", (_req, res) => {
  res.json({ jobs: jobQueue.list() });
});

/** Server-sent progress stream: an initial snapshot, then one event per job state/progress change. */
const SSE_HEARTBEAT_MS = 20000;

jobsRouter.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // The browser is talking to us directly, but a proxy in between would otherwise be
    // free to buffer the stream and hold every progress update back until it closed.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "snapshot", jobs: jobQueue.list() })}\n\n`);

  const onUpdate = (job: unknown) => {
    res.write(`data: ${JSON.stringify({ type: "update", job })}\n\n`);
  };
  jobQueue.on("update", onUpdate);

  // A queue can sit idle for minutes between jobs. A periodic comment keeps the
  // connection demonstrably alive, and lets a dropped one surface as an error the
  // browser can reconnect from rather than as an open socket that never speaks again.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    jobQueue.off("update", onUpdate);
  });
});

/** Drops finished jobs from the in-memory list. History lives in data/library.jsonl. */
jobsRouter.delete("/completed", (_req, res) => {
  res.json({ removed: jobQueue.clearCompleted() });
});

/**
 * Enqueues jobs. Takes the same (sourcePaths, targetName, overrides) shape as
 * /api/plan — rather than trusting client-supplied destination paths for a
 * write operation, the plan is rebuilt server-side right before enqueueing so
 * collision/space checks are fresh, not whatever was true when Review last loaded.
 */
jobsRouter.post("/", (req, res) => {
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
  if (!target.writable) {
    res.status(400).json({ error: `${targetName} is not writable.` });
    return;
  }

  const sevenZip = detectTools(config.toolPathOverrides).find((t) => t.id === "sevenZip");
  const planned = buildPlan(sourcePaths, target, config, { sevenZipPath: sevenZip?.found ? sevenZip.path : null }, parsed.overrides);

  const results = planned.map((job) => {
    try {
      return { ok: true as const, job: jobQueue.enqueue(job) };
    } catch (err) {
      return { ok: false as const, sourcePath: job.sourcePath, error: err instanceof Error ? err.message : String(err) };
    }
  });

  res.json({ results });
});

jobsRouter.post("/:id/cancel", (req, res) => {
  const ok = jobQueue.cancel(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "No such job, or it isn't in a cancellable state." });
    return;
  }
  res.json({ ok: true });
});

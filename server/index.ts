import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./library/config.js";
import { detectTools } from "./convert/tools.js";
import { toolsRouter } from "./routes/tools.js";
import { targetsRouter } from "./routes/targets.js";
import { detectRouter } from "./routes/detect.js";
import { ingestRouter } from "./routes/ingest.js";
import { browseRouter } from "./routes/browse.js";
import { planRouter } from "./routes/plan.js";
import { systemsRouter } from "./routes/systems.js";
import { jobsRouter } from "./routes/jobs.js";
import { configRouter } from "./routes/config.js";
import { libraryRouter } from "./routes/library.js";
import { datIndex } from "./jobs/queueInstance.js";
import { sweepStaleStagingDirs } from "./library/staging.js";
import { STAGING_DIR, WEB_DIST_DIR } from "./lib/paths.js";

const config = loadConfig();
const app = express();

// Mounted before express.json() so a streamed upload's raw body is never at
// risk of being intercepted by body-parsing middleware.
app.use("/api/ingest", ingestRouter);

// 2mb rather than express's 100kb default: a plan or enqueue request carries one
// absolute path per file plus per-file overrides, and a few hundred long paths
// legitimately exceeds 100kb — which would otherwise fail as an unparseable HTML
// PayloadTooLargeError rather than anything the client can show the user.
app.use(express.json({ limit: "2mb" }));

app.use("/api/tools", toolsRouter);
app.use("/api/targets", targetsRouter);
app.use("/api/detect", detectRouter);
app.use("/api/browse", browseRouter);
app.use("/api/plan", planRouter);
app.use("/api/systems", systemsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/config", configRouter);
app.use("/api/library", libraryRouter);

// Anything under /api that no router above matched is a real 404, not a client-side
// route. Without this it falls through to the SPA catch-all below and returns
// index.html with a 200, which the client's res.json() then reports as an opaque
// "Unexpected token '<'" instead of the actual "no such endpoint".
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Unknown API endpoint." });
});

// In production (or whenever a build exists), serve the built web app and let
// it handle client-side routes. In dev, Vite's own server does this instead
// and proxies /api requests here.
if (existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
  });
}

// Terminal error handler. Every route is expected to handle its own errors, but a
// synchronous throw in one that doesn't would otherwise produce express's default
// HTML error page — which the client can't parse into anything it can display.
// Keeping the shape identical to every other error response means the client's
// safeErrorText() finds a message here too.
app.use(((err, _req, res, _next) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}) as express.ErrorRequestHandler);

// Deliberately not reading the generic PORT env var: this app runs two
// processes in dev (this API server + the Vite dev server), and a shared
// PORT convention would make them collide. Set ROM_MANAGER_PORT to override.
const port = Number(process.env.ROM_MANAGER_PORT) || config.port;

// Bound to loopback deliberately. These routes read any absolute path the caller
// names, write to any mounted volume, and pop a native file dialog on the user's
// desktop — all unauthenticated, because this is a single-user local tool. Binding
// 0.0.0.0 (express's default) would hand all of that to anyone on the same network.
app.listen(port, "127.0.0.1", () => {
  console.log(`rom-manager server listening on http://localhost:${port}`);

  const tools = detectTools(config.toolPathOverrides);
  for (const tool of tools) {
    const status = tool.found ? `found (${tool.version ?? "version unknown"}) at ${tool.path}` : "NOT FOUND";
    const flag = tool.found ? "✓" : tool.required ? "✗ required" : "– optional";
    console.log(`  [${flag}] ${tool.name}: ${status}`);
  }

  const sweptDirs = sweepStaleStagingDirs(STAGING_DIR);
  if (sweptDirs > 0) {
    console.log(`  staging: cleaned up ${sweptDirs} abandoned upload director${sweptDirs === 1 ? "y" : "ies"}`);
  }

  if (datIndex.datFileCount > 0) {
    console.log(`  DAT matching: ${datIndex.datFileCount} file(s) loaded, ${datIndex.romCount} known ROMs (informational only — never renames)`);
  } else {
    console.log(`  DAT matching: no .dat files in config/dats/ — inactive`);
  }
});

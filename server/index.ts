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
import { datIndex } from "./jobs/queueInstance.js";
import { WEB_DIST_DIR } from "./lib/paths.js";

const config = loadConfig();
const app = express();

// Mounted before express.json() so a streamed upload's raw body is never at
// risk of being intercepted by body-parsing middleware.
app.use("/api/ingest", ingestRouter);

app.use(express.json());

app.use("/api/tools", toolsRouter);
app.use("/api/targets", targetsRouter);
app.use("/api/detect", detectRouter);
app.use("/api/browse", browseRouter);
app.use("/api/plan", planRouter);
app.use("/api/systems", systemsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/config", configRouter);

// In production (or whenever a build exists), serve the built web app and let
// it handle client-side routes. In dev, Vite's own server does this instead
// and proxies /api requests here.
if (existsSync(WEB_DIST_DIR)) {
  app.use(express.static(WEB_DIST_DIR));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
  });
}

// Deliberately not reading the generic PORT env var: this app runs two
// processes in dev (this API server + the Vite dev server), and a shared
// PORT convention would make them collide. Set ROM_MANAGER_PORT to override.
const port = Number(process.env.ROM_MANAGER_PORT) || config.port;

app.listen(port, () => {
  console.log(`rom-manager server listening on http://localhost:${port}`);

  const tools = detectTools(config.toolPathOverrides);
  for (const tool of tools) {
    const status = tool.found ? `found (${tool.version ?? "version unknown"}) at ${tool.path}` : "NOT FOUND";
    const flag = tool.found ? "✓" : tool.required ? "✗ required" : "– optional";
    console.log(`  [${flag}] ${tool.name}: ${status}`);
  }

  if (datIndex.datFileCount > 0) {
    console.log(`  DAT matching: ${datIndex.datFileCount} file(s) loaded, ${datIndex.romCount} known ROMs (informational only — never renames)`);
  } else {
    console.log(`  DAT matching: no .dat files in config/dats/ — inactive`);
  }
});

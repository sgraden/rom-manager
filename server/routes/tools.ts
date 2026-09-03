import { Router } from "express";
import { detectTools, refreshTools } from "../convert/tools.js";
import { loadConfig } from "../library/config.js";

export const toolsRouter = Router();

/**
 * Results are memoized (see detectTools) since probing costs ~300ms of subprocess
 * time. `?refresh=1` clears that first, which is what the Settings page's re-check
 * button uses after the user installs a missing tool.
 */
toolsRouter.get("/", (req, res) => {
  if (req.query.refresh === "1") refreshTools();
  const config = loadConfig();
  res.json({ tools: detectTools(config.toolPathOverrides) });
});

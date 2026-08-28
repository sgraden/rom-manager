import { Router } from "express";
import { detectTools } from "../convert/tools.js";
import { loadConfig } from "../library/config.js";

export const toolsRouter = Router();

toolsRouter.get("/", (_req, res) => {
  const config = loadConfig();
  res.json({ tools: detectTools(config.toolPathOverrides) });
});

import { Router } from "express";
import { existsSync, statSync } from "node:fs";
import { detectPath } from "../detect/index.js";
import { detectTools } from "../convert/tools.js";
import { loadConfig } from "../library/config.js";

export const detectRouter = Router();

detectRouter.post("/", (req, res) => {
  const filePath = req.body?.path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    res.status(400).json({ error: "Request body must include a non-empty 'path' string." });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.status(404).json({ error: `No such file: ${filePath}` });
    return;
  }

  const config = loadConfig();
  const sevenZip = detectTools(config.toolPathOverrides).find((t) => t.id === "sevenZip");

  try {
    const result = detectPath(filePath, { sevenZipPath: sevenZip?.found ? sevenZip.path : null });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

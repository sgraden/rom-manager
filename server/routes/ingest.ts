import express, { Router } from "express";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const ingestRouter = Router();

/**
 * Registers a file already on disk as a plannable source — no copy is ever made.
 *
 * This is the only way files enter the app. Browser uploads used to be the other way,
 * but a page can't learn a real filesystem path from drag-and-drop or an <input
 * type="file">, only the bytes — so ingesting that way meant writing a whole disc image
 * into staging/ just to convert it and delete it again. The macOS open panel
 * (/api/browse/native) returns paths, so everything is read where it already lives.
 *
 * This router is mounted ahead of the app-wide express.json(), so it parses its own body.
 */
ingestRouter.post("/path", express.json(), (req, res) => {
  const filePath = req.body?.path;
  if (typeof filePath !== "string" || filePath.length === 0) {
    res.status(400).json({ error: "Request body must include a 'path' string." });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `No such path: ${filePath}` });
    return;
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    res.status(400).json({ error: `${filePath} is a directory — add individual files (folder ingestion isn't supported yet).` });
    return;
  }
  res.json({ path: filePath, name: path.basename(filePath), size: stat.size });
});

import express, { Router } from "express";
import { createWriteStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { STAGING_DIR } from "../lib/paths.js";

export const ingestRouter = Router();

/** Streams a drag-dropped file straight to disk — never buffers the whole thing in memory. */
ingestRouter.post("/upload", (req, res) => {
  const rawName = req.query.filename;
  if (typeof rawName !== "string" || rawName.length === 0) {
    res.status(400).json({ error: "Query parameter 'filename' is required." });
    return;
  }

  const safeName = path.basename(rawName);
  const destPath = path.join(STAGING_DIR, `${randomUUID()}-${safeName}`);
  const writeStream = createWriteStream(destPath);

  let bytesWritten = 0;
  req.on("data", (chunk: Buffer) => {
    bytesWritten += chunk.length;
  });

  req.on("error", () => writeStream.destroy());

  writeStream.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  writeStream.on("finish", () => {
    res.json({ path: destPath, name: safeName, size: bytesWritten });
  });

  req.pipe(writeStream);
});

/**
 * Registers a file already on disk (from the "Add by path" field) as a plannable source — no copy.
 * This router is mounted ahead of the app-wide express.json() (to keep /upload's raw body
 * stream untouched), so it needs its own JSON body parsing here.
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

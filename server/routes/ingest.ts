import express, { Router } from "express";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { STAGING_DIR } from "../lib/paths.js";
import { stagedUploadPath } from "../library/fsutil.js";

export const ingestRouter = Router();

/** Streams a drag-dropped file straight to disk — never buffers the whole thing in memory. */
ingestRouter.post("/upload", (req, res) => {
  const rawName = req.query.filename;
  if (typeof rawName !== "string" || rawName.length === 0) {
    res.status(400).json({ error: "Query parameter 'filename' is required." });
    return;
  }

  const { filePath: destPath, uploadDir, safeName } = stagedUploadPath(STAGING_DIR, rawName);
  mkdirSync(uploadDir, { recursive: true });
  const writeStream = createWriteStream(destPath);

  let bytesWritten = 0;
  req.on("data", (chunk: Buffer) => {
    bytesWritten += chunk.length;
  });

  // An upload that dies partway leaves a half-written file in its own UUID directory.
  // Both have to go: the partial file is unusable, and the directory would otherwise
  // accumulate under staging/ on every cancelled drag-and-drop. Answering the request
  // matters just as much — without a response the browser's XHR hangs until it times
  // out, with no error ever reaching the Drop page.
  let settled = false;
  const abort = (message: string) => {
    if (settled) return;
    settled = true;
    writeStream.destroy();
    try {
      rmSync(uploadDir, { recursive: true, force: true });
    } catch {
      // best effort — a leftover staging directory is a minor annoyance, not worth masking the real error
    }
    if (!res.headersSent) res.status(500).json({ error: message });
  };

  req.on("error", () => abort("Upload interrupted before the file finished transferring."));
  req.on("aborted", () => abort("Upload was cancelled before the file finished transferring."));
  writeStream.on("error", (err) => abort(err.message));
  writeStream.on("finish", () => {
    if (settled) return;
    settled = true;
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

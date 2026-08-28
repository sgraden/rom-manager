import { Router } from "express";
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const browseRouter = Router();

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

/** Lists a directory's contents — backs the Drop page's server-side folder browser. */
browseRouter.get("/", (req, res) => {
  const requested = typeof req.query.dir === "string" && req.query.dir.length > 0 ? req.query.dir : os.homedir();
  const dir = path.resolve(requested);

  let dirEntries;
  try {
    dirEntries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    res.status(400).json({ error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  const entries: BrowseEntry[] = dirEntries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => {
      const full = path.join(dir, e.name);
      const isDirectory = e.isDirectory();
      let size = 0;
      if (!isDirectory) {
        try {
          size = statSync(full).size;
        } catch {
          // Unreadable entry (permissions, broken symlink) — leave size at 0 rather than failing the whole listing.
        }
      }
      return { name: e.name, path: full, isDirectory, size };
    })
    .sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)));

  const parent = path.dirname(dir);
  res.json({ dir, parent: parent !== dir ? parent : null, entries });
});

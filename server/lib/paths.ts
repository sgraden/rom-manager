import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolved from this file's location rather than process.cwd(), so paths are
// correct no matter where `npm run dev` / `npm start` is invoked from.
const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, "..", "..");
export const CONFIG_DIR = path.join(ROOT_DIR, "config");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const CONFIG_EXAMPLE_PATH = path.join(CONFIG_DIR, "config.example.json");
export const DATS_DIR = path.join(CONFIG_DIR, "dats");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const LIBRARY_PATH = path.join(DATA_DIR, "library.json");
export const STAGING_DIR = path.join(ROOT_DIR, "staging");
export const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");

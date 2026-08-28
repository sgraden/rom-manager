import { SYSTEMS } from "../library/systems.js";

const EXTENSION_MAP = new Map<string, string[]>();
for (const system of SYSTEMS) {
  for (const ext of system.extensions) {
    const list = EXTENSION_MAP.get(ext) ?? [];
    list.push(system.id);
    EXTENSION_MAP.set(ext, list);
  }
}

/** Lowest-confidence fallback: which systems use this extension, with no byte-level evidence. */
export function systemsForExtension(ext: string): string[] {
  return EXTENSION_MAP.get(ext.toLowerCase()) ?? [];
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolPathOverrides } from "../library/config.js";

/**
 * The official macOS Dolphin.app release (the `brew install --cask dolphin` build) doesn't
 * bundle a DolphinTool CLI binary — only the GUI app. `@emmercm/dolphin-tool-<platform>-<arch>`
 * ships the real DolphinTool executable built from the same Dolphin source release, gated by
 * npm's os/cpu fields so only the matching platform package actually installs.
 */
async function resolveBundledDolphinTool(): Promise<string | null> {
  try {
    const mod = (await import(`@emmercm/dolphin-tool-${process.platform}-${process.arch}`)) as { default: unknown };
    const binPath = mod.default;
    if (typeof binPath === "string" && existsSync(binPath)) return binPath;
  } catch {
    // Optional platform package not installed (wrong OS/arch, or `npm install --no-optional`) — fine, just unavailable.
  }
  return null;
}

const bundledDolphinTool = await resolveBundledDolphinTool();

export type ToolId = "chdman" | "sevenZip" | "dolphinTool" | "maxcso";

export interface ToolInfo {
  id: ToolId;
  name: string;
  required: boolean;
  found: boolean;
  path: string | null;
  version: string | null;
  purpose: string;
  installHint: string;
}

interface ToolSpec {
  id: ToolId;
  name: string;
  required: boolean;
  purpose: string;
  installHint: string;
  /** Candidate executables/paths to try, in order. Bare names are resolved via PATH. */
  candidates: string[];
  /** Args that make the tool print something to stdout/stderr without side effects. */
  probeArgs: string[];
  /** Regex to pull a version string out of the probe output. */
  versionPattern: RegExp;
}

const SPECS: ToolSpec[] = [
  {
    id: "chdman",
    name: "chdman",
    required: true,
    purpose: "Creates and verifies CHD files for disc-based systems (PS1, PS2, Saturn, Sega CD, Dreamcast, PCE-CD, 3DO, …).",
    installHint: "brew install rom-tools",
    candidates: ["chdman", "/usr/local/bin/chdman", "/opt/homebrew/bin/chdman"],
    probeArgs: ["--help"],
    versionPattern: /manager\s+([\d.]+)/i,
  },
  {
    id: "sevenZip",
    name: "7-Zip (7zz)",
    required: true,
    purpose: "Lists and extracts cartridge ROM archives (.zip, .7z) and re-zips converted cartridge ROMs.",
    installHint: "brew install sevenzip",
    candidates: ["7zz", "7z", "/usr/local/bin/7zz", "/opt/homebrew/bin/7zz"],
    probeArgs: ["i"],
    versionPattern: /7-Zip[^\d]*([\d.]+)/i,
  },
  {
    id: "dolphinTool",
    name: "DolphinTool",
    required: false,
    purpose: "Converts GameCube/Wii ISOs to RVZ. Without it, GC/Wii images are copied as-is (no compression).",
    installHint: "Bundled automatically via npm — run `npm install` if missing. (The Dolphin.app cask itself doesn't include DolphinTool.)",
    candidates: [
      ...(bundledDolphinTool ? [bundledDolphinTool] : []),
      "DolphinTool",
      "/Applications/Dolphin.app/Contents/MacOS/DolphinTool",
    ],
    probeArgs: ["--help"],
    versionPattern: /([\d.]+)/,
  },
  {
    id: "maxcso",
    name: "maxcso",
    required: false,
    purpose: "Optional: converts PSP ISOs to CSO/ZSO. Not required — PSP defaults to CHD, which PPSSPP reads natively.",
    installHint: "not available via Homebrew — build from source (https://github.com/unknownbrackets/maxcso) if you want ZSO output",
    candidates: ["maxcso"],
    probeArgs: ["--help"],
    versionPattern: /([\d.]+)/,
  },
];

function resolveCandidate(candidate: string): boolean {
  // Absolute/relative paths: check existence directly. Bare names: let spawnSync's
  // PATH lookup decide (ENOENT means "not found").
  if (candidate.includes("/")) return existsSync(candidate);
  return true;
}

function probe(spec: ToolSpec, override: string | null): ToolInfo {
  const candidates = override ? [override, ...spec.candidates] : spec.candidates;

  for (const candidate of candidates) {
    if (!resolveCandidate(candidate)) continue;

    const result = spawnSync(candidate, spec.probeArgs, {
      encoding: "utf-8",
      timeout: 5000,
    });

    // ENOENT (binary truly absent) shows up as result.error; any other outcome
    // (including a nonzero exit code, which several of these tools use for
    // --help) means the binary exists and ran.
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      continue;
    }

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const versionMatch = output.match(spec.versionPattern);

    return {
      id: spec.id,
      name: spec.name,
      required: spec.required,
      found: true,
      path: candidate,
      version: versionMatch ? versionMatch[1] : null,
      purpose: spec.purpose,
      installHint: spec.installHint,
    };
  }

  return {
    id: spec.id,
    name: spec.name,
    required: spec.required,
    found: false,
    path: null,
    version: null,
    purpose: spec.purpose,
    installHint: spec.installHint,
  };
}

/**
 * Probing is expensive — one spawnSync per tool, measured at ~300ms for the four of
 * them together, on the request's main thread. detectTools is called from /api/tools,
 * /api/detect, /api/plan, POST /api/jobs, and once per job from the queue, so without
 * a cache that cost lands on essentially every request the app makes.
 *
 * Tool paths only change when the user installs something or edits an override, so the
 * cache is keyed on the overrides and cleared explicitly by refreshTools(). Settings
 * exposes that, so someone who has just run `brew install` doesn't need to restart.
 */
let cache: { key: string; tools: ToolInfo[] } | null = null;

export function detectTools(overrides: ToolPathOverrides): ToolInfo[] {
  const key = JSON.stringify(overrides);
  if (cache && cache.key === key) return cache.tools;

  const tools = SPECS.map((spec) => probe(spec, overrides[spec.id]));
  cache = { key, tools };
  return tools;
}

/** Discards the memoized probe results, so the next detectTools() re-runs the real probes. */
export function refreshTools(): void {
  cache = null;
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolPathOverrides } from "../library/config.js";

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
    installHint: "brew install --cask dolphin",
    candidates: [
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

export function detectTools(overrides: ToolPathOverrides): ToolInfo[] {
  return SPECS.map((spec) => probe(spec, overrides[spec.id]));
}

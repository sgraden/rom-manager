import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toAppError } from "./AppError";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf-8");

describe("toAppError", () => {
  it("strips the API client's url/status prefix from what the user sees", () => {
    const error = toAppError(new Error("/api/plan -> 500: Something specific went wrong."));
    expect(error.message).toBe("Something specific went wrong.");
    expect(error.message).not.toContain("/api/plan");
    expect(error.message).not.toContain("500");
  });

  it("keeps the raw text as the cause, for pasting into a bug report", () => {
    const raw = "/api/plan -> 500: Something specific went wrong.";
    expect(toAppError(new Error(raw)).cause).toBe(raw);
  });

  it("falls back to a plain message when nothing matches", () => {
    const error = toAppError(new Error("A brand new failure nobody has seen before"));
    expect(error.message).toBe("A brand new failure nobody has seen before");
    expect(error.remedy).toBeUndefined();
  });

  it("never leaves the message empty, whatever it was handed", () => {
    for (const thrown of [new Error(""), "", null, undefined, 42]) {
      expect(toAppError(thrown).message.length).toBeGreaterThan(0);
    }
  });
});

describe("remedies for errors the app actually produces", () => {
  it("offers a brew command and a re-check for a missing chdman", () => {
    const error = toAppError(new Error("chdman is not available."));
    expect(error.message).toContain("chdman isn't installed");
    expect(error.remedy?.command).toBe("brew install rom-tools");
    expect(error.remedy?.action?.kind).toBe("recheck-tools");
  });

  it("offers Replace/Skip guidance and the library for a destination collision", () => {
    const error = toAppError(new Error("A file already exists at /Volumes/CARD/roms/psx/Game.chd — remove or rename it first."));
    expect(error.message).toBe("That file is already on the card.");
    expect(error.remedy?.text).toMatch(/Replace/);
    expect(error.remedy?.action?.kind).toBe("open-library");
  });

  it("points at the library when the card is full", () => {
    const error = toAppError(new Error("Not enough free space for this job (~2400 MB estimated, ~800 MB available)."));
    expect(error.message).toContain("isn't enough free space");
    expect(error.remedy?.action?.kind).toBe("open-library");
    // The original numbers stay available — they're the useful part of the detail.
    expect(error.cause).toContain("2400 MB");
  });

  it("explains a read-only card in terms of what to physically do", () => {
    const error = toAppError(new Error("ROMSCARD is not writable."));
    expect(error.message).toContain("read-only");
    expect(error.remedy?.text).toMatch(/write-protect/);
  });

  it("sends an unmapped system to Settings", () => {
    const error = toAppError(new Error("No destination folder mapped for Sony PlayStation on ROMSCARD — assign one in Settings."));
    expect(error.remedy?.action?.kind).toBe("open-settings");
  });

  it("explains a cue sheet with no track files beside it", () => {
    const error = toAppError(new Error("No referenced track file found in Broken Game.cue."));
    expect(error.message).toContain("track files aren't next to it");
    expect(error.remedy?.text).toMatch(/\.bin/);
    expect(error.remedy?.action?.kind).toBe("retry");
    expect(error.cause).toContain("Broken Game.cue");
  });

  it("offers a retry for an unreachable server", () => {
    const error = toAppError(new Error("Failed to fetch"));
    expect(error.message).toContain("Couldn't reach");
    expect(error.remedy?.action?.kind).toBe("retry");
  });
});

/**
 * The patterns match on message text the server produces, which is a loose coupling —
 * rewording a server-side error would silently drop its remedy. These read the real
 * source files and assert the strings the patterns depend on are still there.
 */
describe("patterns stay matched to the server's real messages", () => {
  it("matches the queue's missing-tool and collision errors verbatim", () => {
    const queue = read("server/jobs/queue.ts");

    for (const literal of [
      "chdman is not available.",
      "7zz is not available to extract this archive.",
      "DolphinTool is not available",
    ]) {
      expect(queue, `queue.ts should still contain "${literal}"`).toContain(literal);
      expect(toAppError(new Error(literal)).remedy, `"${literal}" should still get a remedy`).toBeDefined();
    }

    expect(queue).toContain("remove or rename it first.");
    expect(toAppError(new Error("A file already exists at /x — remove or rename it first.")).remedy).toBeDefined();
  });

  it("matches the queue's out-of-space error", () => {
    expect(read("server/jobs/queue.ts")).toContain("Not enough free space for this job");
    expect(toAppError(new Error("Not enough free space for this job (~1 MB estimated)")).remedy?.action?.kind).toBe("open-library");
  });

  it("matches plan.ts's unmapped-folder and unreadable-file warnings", () => {
    const plan = read("server/library/plan.ts");
    expect(plan).toContain("No destination folder mapped for");
    expect(plan).toContain("Could not inspect this file");

    expect(toAppError(new Error("No destination folder mapped for X on Y — assign one in Settings.")).remedy?.action?.kind).toBe(
      "open-settings",
    );
    expect(toAppError(new Error("Could not inspect this file: ENOENT")).remedy?.action?.kind).toBe("retry");
  });

  it("matches the cue-sheet wording used by the queue and detector", () => {
    expect(read("server/jobs/queue.ts")).toContain("No referenced track file found in");
    expect(read("server/detect/index.ts")).toContain("No referenced track file(s) found next to");
    expect(toAppError(new Error("No referenced track file found in x.cue.")).remedy).toBeDefined();
  });

  it("matches the 'not writable' wording used by the routes and the queue", () => {
    expect(read("server/routes/jobs.ts")).toContain("is not writable.");
    expect(toAppError(new Error("CARD is not writable.")).message).toContain("read-only");
  });
});

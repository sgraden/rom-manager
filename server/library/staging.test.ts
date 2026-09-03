import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sweepStaleStagingDirs } from "./staging.js";

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-staging-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A staged upload directory holding one file, aged by `ageMs` via its mtime. */
function makeUploadDir(stagingDir: string, name: string, ageMs: number): string {
  const dir = path.join(stagingDir, name);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "game.iso"), "partial upload");
  const when = new Date(Date.now() - ageMs);
  utimesSync(dir, when, when);
  return dir;
}

const DAY = 24 * 60 * 60 * 1000;

describe("sweepStaleStagingDirs", () => {
  it("removes abandoned upload directories older than the cutoff", () => {
    const staging = makeTempDir();
    const stale = makeUploadDir(staging, "aaaaaaaa-stale", 3 * DAY);

    expect(sweepStaleStagingDirs(staging)).toBe(1);
    expect(existsSync(stale)).toBe(false);
  });

  it("leaves recent directories alone — an upload may still be in flight", () => {
    const staging = makeTempDir();
    const fresh = makeUploadDir(staging, "bbbbbbbb-fresh", 60 * 1000);

    expect(sweepStaleStagingDirs(staging)).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  it("never deletes files sitting directly in staging/", () => {
    // The app's older flat layout put staged files here, and the user may have
    // dropped something in themselves. Only our own UUID subdirectories are ours.
    const staging = makeTempDir();
    const loose = path.join(staging, "old-flat-layout.iso");
    writeFileSync(loose, "not ours to delete");
    const when = new Date(Date.now() - 30 * DAY);
    utimesSync(loose, when, when);

    expect(sweepStaleStagingDirs(staging)).toBe(0);
    expect(existsSync(loose)).toBe(true);
  });

  it("returns 0 rather than throwing when staging/ doesn't exist", () => {
    expect(sweepStaleStagingDirs(path.join(makeTempDir(), "nope"))).toBe(0);
  });
});

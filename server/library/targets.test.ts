import { describe, it, expect } from "vitest";
import { resolveFolderMap, type TargetInfo } from "./targets.js";
import type { AppConfig } from "./config.js";

function fakeTarget(folders: string[]): TargetInfo {
  return {
    name: "TESTCARD",
    path: "/Volumes/TESTCARD",
    romRoot: "/Volumes/TESTCARD/roms",
    freeBytes: 1_000_000_000,
    totalBytes: 2_000_000_000,
    fsType: "exfat",
    writable: true,
    folders,
  };
}

function fakeConfig(overrides: AppConfig["targetFolderMaps"] = {}): AppConfig {
  return {
    port: 3001,
    maxConcurrentJobs: 1,
    reservedCpuCores: 2,
    verifyAfterConvert: true,
    deleteSourceAfterSuccess: false,
    groupMultiDiscFolders: true,
    additionalTargetPaths: [],
    toolPathOverrides: { chdman: null, sevenZip: null, dolphinTool: null, maxcso: null },
    targetFolderMaps: overrides,
    systemActionOverrides: {},
    lastTargetName: null,
  };
}

describe("resolveFolderMap", () => {
  it("matches folders to systems via alias", () => {
    const target = fakeTarget(["psx", "snes", "genesis"]);
    const { folderMap, unmatchedFolders } = resolveFolderMap(target, fakeConfig());
    expect(folderMap.psx).toBe("psx");
    expect(folderMap.snes).toBe("snes");
    expect(folderMap.genesis).toBe("genesis");
    expect(unmatchedFolders).toEqual([]);
  });

  it("matches folders via an alternate alias (e.g. ps1 -> psx)", () => {
    const target = fakeTarget(["ps1"]);
    const { folderMap } = resolveFolderMap(target, fakeConfig());
    expect(folderMap.psx).toBe("ps1");
  });

  it("leaves unrecognized folders unmatched rather than guessing", () => {
    const target = fakeTarget(["some_random_folder"]);
    const { unmatchedFolders } = resolveFolderMap(target, fakeConfig());
    expect(unmatchedFolders).toEqual(["some_random_folder"]);
  });

  it("lists systems with no assigned folder", () => {
    const target = fakeTarget(["psx"]);
    const { unmappedSystemIds } = resolveFolderMap(target, fakeConfig());
    expect(unmappedSystemIds).toContain("snes");
    expect(unmappedSystemIds).not.toContain("psx");
  });

  it("prefers a persisted override over alias auto-matching", () => {
    const target = fakeTarget(["psx", "custom-ps1-folder"]);
    const config = fakeConfig({
      TESTCARD: { romRoot: target.romRoot, folderMap: { psx: "custom-ps1-folder" } },
    });
    const { folderMap } = resolveFolderMap(target, config);
    expect(folderMap.psx).toBe("custom-ps1-folder");
  });

  it("never assigns the same folder to two systems", () => {
    // "genesis" folder should only ever satisfy one system id even though multiple could plausibly want it.
    const target = fakeTarget(["genesis"]);
    const { folderMap } = resolveFolderMap(target, fakeConfig());
    const assignedCount = Object.values(folderMap).filter((f) => f === "genesis").length;
    expect(assignedCount).toBe(1);
  });
});

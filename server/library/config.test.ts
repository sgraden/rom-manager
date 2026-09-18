import { describe, it, expect } from "vitest";
import { withDefaults, type AppConfig } from "./config.js";

describe("withDefaults", () => {
  it("fills in every field for a config.json that predates them", () => {
    // The shape a very early config.json had — everything else has been added since.
    const config = withDefaults({ port: 3001 } as Partial<AppConfig>);

    expect(config.port).toBe(3001);
    expect(config.maxConcurrentJobs).toBeGreaterThanOrEqual(1);
    expect(config.reservedCpuCores).toBe(2);
    expect(config.verifyAfterConvert).toBe(true);
    expect(config.deleteSourceAfterSuccess).toBe(false);
    expect(config.groupMultiDiscFolders).toBe(true);
    expect(config.additionalTargetPaths).toEqual([]);
    // The specific field that used to throw: resolveFolderMap indexes into this unguarded.
    expect(config.targetFolderMaps).toEqual({});
    expect(config.systemActionOverrides).toEqual({});
  });

  it("keeps every stored value rather than overwriting it with a default", () => {
    const config = withDefaults({
      port: 4000,
      maxConcurrentJobs: 6,
      reservedCpuCores: 0,
      verifyAfterConvert: false,
      deleteSourceAfterSuccess: true,
      additionalTargetPaths: ["/tmp/cards"],
      targetFolderMaps: { ROMSCARD: { romRoot: "/Volumes/ROMSCARD/roms", folderMap: { ps2: "ps2" } } },
      systemActionOverrides: { ps2: "chd-cd" },
    });

    expect(config.port).toBe(4000);
    expect(config.maxConcurrentJobs).toBe(6);
    expect(config.reservedCpuCores).toBe(0); // 0 is meaningful here — must not be treated as absent
    expect(config.verifyAfterConvert).toBe(false);
    expect(config.deleteSourceAfterSuccess).toBe(true);
    expect(config.additionalTargetPaths).toEqual(["/tmp/cards"]);
    expect(config.targetFolderMaps.ROMSCARD.folderMap.ps2).toBe("ps2");
    expect(config.systemActionOverrides.ps2).toBe("chd-cd");
  });

  it("backfills the tool-path keys a partial toolPathOverrides omits", () => {
    // detectTools indexes overrides[spec.id] for all four tools, so a config that
    // names only one of them must still come back with the other three present.
    const config = withDefaults({ toolPathOverrides: { chdman: "/custom/chdman" } as AppConfig["toolPathOverrides"] });

    expect(config.toolPathOverrides.chdman).toBe("/custom/chdman");
    expect(config.toolPathOverrides.sevenZip).toBeNull();
    expect(config.toolPathOverrides.dolphinTool).toBeNull();
    expect(config.toolPathOverrides.maxcso).toBeNull();
  });

  it("produces a complete config from nothing at all", () => {
    const config = withDefaults({});
    for (const key of [
      "port",
      "maxConcurrentJobs",
      "reservedCpuCores",
      "verifyAfterConvert",
      "deleteSourceAfterSuccess",
      "groupMultiDiscFolders",
      "additionalTargetPaths",
      "toolPathOverrides",
      "targetFolderMaps",
      "systemActionOverrides",
    ] as const) {
      expect(config[key], `${key} should be populated`).toBeDefined();
    }
  });
});

import { describe, it, expect } from "vitest";
import { sanitizeExfatName, estimateOutputBytes, outputFilenameFor } from "./fsutil.js";

describe("sanitizeExfatName", () => {
  it("leaves an already-safe name untouched", () => {
    expect(sanitizeExfatName("Chrono Trigger (USA).sfc")).toBe("Chrono Trigger (USA).sfc");
  });

  it("replaces illegal exFAT characters", () => {
    expect(sanitizeExfatName('Game: The "Best"? <2> | v1*.iso')).toBe("Game_ The _Best__ _2_ _ v1_.iso");
  });

  it("strips a trailing dot or space", () => {
    expect(sanitizeExfatName("Game. ")).toBe("Game");
  });

  it("never returns an empty string", () => {
    expect(sanitizeExfatName("...")).not.toBe("");
  });

  it("caps length while preserving the extension", () => {
    const longName = "A".repeat(300) + ".chd";
    const result = sanitizeExfatName(longName);
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result.endsWith(".chd")).toBe(true);
  });
});

describe("estimateOutputBytes", () => {
  it("estimates CHD output smaller than the source", () => {
    expect(estimateOutputBytes(1000, "chd-cd")).toBeLessThan(1000);
  });

  it("leaves 'copy' output equal to the source", () => {
    expect(estimateOutputBytes(1234, "copy")).toBe(1234);
  });
});

describe("outputFilenameFor", () => {
  it("forces a .chd extension for chd-cd", () => {
    expect(outputFilenameFor("Game (USA).cue", "chd-cd")).toBe("Game (USA).chd");
  });

  it("forces a .rvz extension for rvz", () => {
    expect(outputFilenameFor("Game.iso", "rvz")).toBe("Game.rvz");
  });

  it("forces a .zip extension for keep-zip", () => {
    expect(outputFilenameFor("game.nes", "keep-zip")).toBe("game.zip");
  });

  it("keeps the original name for copy", () => {
    expect(outputFilenameFor("game.d64", "copy")).toBe("game.d64");
  });
});

import { describe, it, expect } from "vitest";
import path from "node:path";
import { sanitizeExfatName, estimateOutputBytes, estimateWorstCaseBytes, outputFilenameFor, isPathInside } from "./fsutil.js";

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

describe("estimateWorstCaseBytes", () => {
  it("assumes near-zero savings for CHD/RVZ, unlike the optimistic typical-case estimate", () => {
    // A disc that's mostly already-compressed content (FMV-heavy compilations especially)
    // can compress poorly or even end up larger than the source — observed as high as ~104%
    // of source in practice — so the free-space check can't safely assume the typical savings.
    const worstCase = estimateWorstCaseBytes(1_000_000, "chd-dvd");
    const typical = estimateOutputBytes(1_000_000, "chd-dvd");
    expect(worstCase).toBeGreaterThan(typical);
    expect(worstCase).toBeGreaterThan(1_000_000); // headroom above simple break-even
  });

  it("leaves 'copy' and 'keep-zip' at the same figure as the typical-case estimate", () => {
    expect(estimateWorstCaseBytes(1234, "copy")).toBe(estimateOutputBytes(1234, "copy"));
    expect(estimateWorstCaseBytes(1234, "keep-zip")).toBe(estimateOutputBytes(1234, "keep-zip"));
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

describe("isPathInside", () => {
  it("is true for a file directly inside the directory", () => {
    expect(isPathInside("/a/b/staging/file.zip", "/a/b/staging")).toBe(true);
  });

  it("is true for a file nested deeper inside", () => {
    expect(isPathInside("/a/b/staging/sub/file.zip", "/a/b/staging")).toBe(true);
  });

  it("is false for a file outside the directory", () => {
    expect(isPathInside("/a/b/elsewhere/file.zip", "/a/b/staging")).toBe(false);
  });

  it("is false for a sibling directory with a matching name prefix", () => {
    expect(isPathInside("/a/b/staging-other/file.zip", "/a/b/staging")).toBe(false);
  });

  it("is false for the directory itself", () => {
    expect(isPathInside("/a/b/staging", "/a/b/staging")).toBe(false);
  });
});

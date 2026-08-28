import { describe, it, expect } from "vitest";
import { systemsForExtension } from "./extensions.js";

describe("systemsForExtension", () => {
  it("maps .nes to nes", () => {
    expect(systemsForExtension(".nes")).toContain("nes");
  });

  it("maps .cue to multiple disc systems", () => {
    const systems = systemsForExtension(".cue");
    expect(systems).toContain("psx");
    expect(systems).toContain("segacd");
  });

  it("is case-insensitive", () => {
    expect(systemsForExtension(".NES")).toContain("nes");
  });

  it("returns an empty array for an unknown extension", () => {
    expect(systemsForExtension(".unknownext")).toEqual([]);
  });
});

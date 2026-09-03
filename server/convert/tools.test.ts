import { describe, it, expect, beforeEach } from "vitest";
import { detectTools, refreshTools } from "./tools.js";

const NO_OVERRIDES = { chdman: null, sevenZip: null, dolphinTool: null, maxcso: null };

describe("detectTools caching", () => {
  beforeEach(() => refreshTools());

  it("returns the same result without re-probing on repeat calls", () => {
    const first = detectTools(NO_OVERRIDES);
    const second = detectTools(NO_OVERRIDES);
    // Same object identity is the observable proof the probes didn't run again.
    expect(second).toBe(first);
  });

  it("re-probes when the overrides change", () => {
    const first = detectTools(NO_OVERRIDES);
    const withOverride = detectTools({ ...NO_OVERRIDES, chdman: "/nonexistent/chdman" });
    expect(withOverride).not.toBe(first);
  });

  it("re-probes after refreshTools()", () => {
    const first = detectTools(NO_OVERRIDES);
    refreshTools();
    const second = detectTools(NO_OVERRIDES);
    expect(second).not.toBe(first);
    // Same answers, just freshly measured.
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
    expect(second.map((t) => t.found)).toEqual(first.map((t) => t.found));
  });

  it("is dramatically faster warm than cold", () => {
    refreshTools();
    const coldStart = Date.now();
    detectTools(NO_OVERRIDES);
    const cold = Date.now() - coldStart;

    const warmStart = Date.now();
    for (let i = 0; i < 20; i++) detectTools(NO_OVERRIDES);
    const warm = Date.now() - warmStart;

    // 20 cached calls must cost less than a single real probe round.
    expect(warm).toBeLessThan(Math.max(cold, 1));
  });
});

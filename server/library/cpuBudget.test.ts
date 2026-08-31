import { describe, it, expect } from "vitest";
import { threadsPerJob } from "./cpuBudget.js";

describe("threadsPerJob", () => {
  it("splits the reserved-aware budget evenly across concurrent jobs", () => {
    expect(threadsPerJob(2, 2, 10)).toBe(4); // (10-2)/2 = 4
  });

  it("uses all remaining cores when only one job is running", () => {
    expect(threadsPerJob(1, 2, 8)).toBe(6);
  });

  it("never returns less than 1 thread even when the budget is thinner than the concurrency", () => {
    expect(threadsPerJob(8, 2, 4)).toBe(1); // budget=2, 2/8 -> 0
  });

  it("never returns less than 1 thread even when reservedCores exceeds total cores", () => {
    expect(threadsPerJob(1, 100, 4)).toBe(1);
  });

  it("treats reservedCores of 0 as using every available core", () => {
    expect(threadsPerJob(2, 0, 8)).toBe(4);
  });

  it("clamps a nonsense concurrency of 0 to 1", () => {
    expect(threadsPerJob(0, 2, 8)).toBe(6);
  });
});

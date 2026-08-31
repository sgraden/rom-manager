import os from "node:os";

/**
 * How many threads each concurrently-running conversion should use, so that
 * `reservedCores` worth of CPU stays available for everything else on the
 * machine regardless of how many jobs happen to be running at once.
 * Deterministic — computed once per job, no monitoring loop or reactive
 * scaling involved.
 */
export function threadsPerJob(concurrency: number, reservedCores: number, totalCores: number = os.availableParallelism()): number {
  const budget = Math.max(1, totalCores - reservedCores);
  return Math.max(1, Math.floor(budget / Math.max(1, concurrency)));
}

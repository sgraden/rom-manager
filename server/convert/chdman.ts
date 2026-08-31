import { spawn } from "node:child_process";
import { CancelledError } from "./errors.js";
import type { RunOptions } from "./types.js";

// Matches chdman's progress lines, e.g. "Compressing, 42.3% complete... (ratio=61.2%)"
// and "Verifying, 0.0% complete...". Confirmed against a real chdman 0.289 run.
const PROGRESS_PATTERN = /(?:Compressing|Verifying|Extracting),\s*([\d.]+)%\s*complete/;

function run(chdmanPath: string, args: string[], phase: string, options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(chdmanPath, args, options.cwd ? { cwd: options.cwd } : {});
    options.registerProcess?.(child);

    let tail = "";
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      tail = (tail + text).slice(-2000);
      const match = text.match(PROGRESS_PATTERN);
      if (match) options.onProgress?.(parseFloat(match[1]), phase);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new CancelledError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`chdman exited with code ${code}: ${tail.trim()}`));
      }
    });
  });
}

export function createChd(
  chdmanPath: string,
  inputPath: string,
  outputPath: string,
  mode: "createcd" | "createdvd",
  options?: RunOptions & { threads?: number },
): Promise<void> {
  const args = [mode, "-i", inputPath, "-o", outputPath, "-f"];
  if (options?.threads) args.push("-np", String(options.threads));
  return run(chdmanPath, args, "converting", options);
}

export function verifyChd(chdmanPath: string, chdPath: string, options?: RunOptions): Promise<void> {
  return run(chdmanPath, ["verify", "-i", chdPath], "verifying", options);
}

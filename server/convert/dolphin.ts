import { spawn } from "node:child_process";
import { CancelledError } from "./errors.js";
import type { RunOptions } from "./types.js";

/**
 * Converts a GameCube/Wii image to RVZ. NOTE: this wrapper is written against
 * DolphinTool's documented CLI but has not been exercised locally — DolphinTool
 * isn't installed on the dev machine this was built on (it ships inside the
 * Dolphin.app cask, not via a standalone Homebrew formula). Verify the exact
 * flags against `DolphinTool convert --help` on a machine that has it before
 * relying on this for real.
 */
export function convertToRvz(dolphinToolPath: string, inputPath: string, outputPath: string, options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["convert", "-i", inputPath, "-o", outputPath, "-f", "rvz", "-c", "zstd", "-l", "5", "-b", "131072"];
    const child = spawn(dolphinToolPath, args, options.cwd ? { cwd: options.cwd } : {});
    options.registerProcess?.(child);

    let tail = "";
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      tail = (tail + text).slice(-2000);
      const match = text.match(/([\d.]+)\s*%/);
      if (match) options.onProgress?.(parseFloat(match[1]), "converting");
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
        reject(new Error(`DolphinTool exited with code ${code}: ${tail.trim()}`));
      }
    });
  });
}

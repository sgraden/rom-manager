import { spawn } from "node:child_process";
import { CancelledError } from "./errors.js";
import type { RunOptions } from "./types.js";

function run(sevenZipPath: string, args: string[], label: string, options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath, args, options.cwd ? { cwd: options.cwd } : {});
    options.registerProcess?.(child);

    let tail = "";
    const onChunk = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf-8")).slice(-2000);
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
        reject(new Error(`${label} exited with code ${code}: ${tail.trim()}`));
      }
    });
  });
}

export function createZip(sevenZipPath: string, sourceFile: string, destZipPath: string, options: RunOptions = {}): Promise<void> {
  return run(sevenZipPath, ["a", "-tzip", "-y", destZipPath, sourceFile], "7-Zip", options);
}

export function extractArchiveAsync(sevenZipPath: string, archivePath: string, destDir: string, options: RunOptions = {}): Promise<void> {
  return run(sevenZipPath, ["x", "-y", `-o${destDir}`, archivePath], "7-Zip extract", options);
}

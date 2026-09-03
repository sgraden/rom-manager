import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CancelledError } from "./errors.js";
import type { RunOptions } from "./types.js";

/** Converts a GameCube/Wii image to RVZ, verified against a real `DolphinTool convert --help` and a real conversion. */
export function convertToRvz(dolphinToolPath: string, inputPath: string, outputPath: string, options: RunOptions = {}): Promise<void> {
  // Without -u, DolphinTool defaults its scratch/config state to the real
  // ~/Library/Application Support/Dolphin — the actual emulator's own save/config
  // directory — which a headless conversion has no business touching.
  const userDir = mkdtempSync(path.join(tmpdir(), "rom-manager-dolphin-user-"));

  return new Promise((resolve, reject) => {
    const args = ["convert", "-i", inputPath, "-o", outputPath, "-f", "rvz", "-c", "zstd", "-l", "5", "-b", "131072", "-u", userDir];
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

    const cleanup = () => {
      try {
        rmSync(userDir, { recursive: true, force: true });
      } catch {
        // best effort — a leftover scratch dir is harmless
      }
    };

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code, signal) => {
      cleanup();
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

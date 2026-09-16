import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { CancelledError } from "./errors.js";
import type { RunOptions } from "./types.js";

// Matches chdman's progress lines, e.g. "Compressing, 42.3% complete... (ratio=61.2%)"
// and "Verifying, 0.0% complete...". Confirmed against a real chdman 0.289 run — but only
// when chdman's stdout is a TTY or a regular file. Piped (our exact spawn() setup), it
// suppresses these lines entirely, printing only its startup header: a real, multi-minute
// conversion completes with zero progress or completion output ever reaching this parser,
// even though the process is working correctly. See the file-growth poll in createChd below.
const PROGRESS_PATTERN = /(?:Compressing|Verifying|Extracting),\s*([\d.]+)%\s*complete/;

function run(chdmanPath: string, args: string[], phase: string, options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(chdmanPath, args, options.cwd ? { cwd: options.cwd } : {});
    options.registerProcess?.(child);

    // chdman's \r-updated "Compressing, N% complete..." line repeats constantly over a long
    // conversion — a simple rolling tail of raw output means a failure deep into a multi-GB
    // job shows nothing but that spam, with whatever chdman actually said about the failure
    // pushed out of the window entirely. Keep only non-progress lines for the error message.
    let tail = "";
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const match = text.match(PROGRESS_PATTERN);
      if (match) options.onProgress?.(parseFloat(match[1]), phase);

      const meaningful = text
        .split(/[\r\n]+/)
        .filter((line) => line.trim() && !PROGRESS_PATTERN.test(line))
        .join("\n");
      if (meaningful) tail = (tail + "\n" + meaningful).slice(-4000);
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
        const detail = tail.trim() || "(chdman produced no output beyond progress updates — no further detail available)";
        reject(new Error(`chdman exited with code ${code}: ${detail}`));
      }
    });
  });
}

export function createChd(
  chdmanPath: string,
  inputPath: string,
  outputPath: string,
  mode: "createcd" | "createdvd",
  options?: RunOptions & { threads?: number; estimatedOutputBytes?: number },
): Promise<void> {
  const args = [mode, "-i", inputPath, "-o", outputPath, "-f"];
  if (options?.threads) args.push("-np", String(options.threads));

  // chdman's own progress text doesn't reach us over a pipe (see above), so poll the growing
  // output file's size against the caller's size estimate instead — this is what actually
  // keeps the progress bar honest for what's usually the slowest step in the whole pipeline.
  // Capped below 100 so a rough estimate can never falsely claim done before chdman exits.
  let poller: NodeJS.Timeout | null = null;
  if (options?.estimatedOutputBytes && options.estimatedOutputBytes > 0) {
    const estimate = options.estimatedOutputBytes;
    poller = setInterval(() => {
      try {
        const percent = Math.min(97, (statSync(outputPath).size / estimate) * 100);
        options.onProgress?.(percent, "converting");
      } catch {
        // output file doesn't exist yet — nothing to report
      }
    }, 500);
  }

  return run(chdmanPath, args, "converting", options).finally(() => {
    if (poller) clearInterval(poller);
  });
}

export function verifyChd(chdmanPath: string, chdPath: string, options?: RunOptions): Promise<void> {
  return run(chdmanPath, ["verify", "-i", chdPath], "verifying", options);
}

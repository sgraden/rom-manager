import type { ChildProcess } from "node:child_process";

export interface RunOptions {
  onProgress?: (percent: number, phase: string) => void;
  /** Lets the caller (the job queue) capture the child process so it can be killed on cancel. */
  registerProcess?: (child: ChildProcess) => void;
  /**
   * Working directory for the child process. Matters for chdman: a .cue's
   * FILE lines are commonly written as bare filenames ("game.bin", not an
   * absolute path), resolved relative to the process's cwd rather than the
   * .cue file's own location — so this must be set to the input's directory
   * whenever the input might contain relative references.
   */
  cwd?: string;
}

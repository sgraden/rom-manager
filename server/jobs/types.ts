import type { ConvertAction } from "../library/systems.js";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  sourcePath: string;
  sourceName: string;
  sourceBytes: number;
  selectedSystemId: string;
  action: ConvertAction;
  destinationFolder: string;
  destinationFilename: string;
  destinationPath: string;
  state: JobState;
  percent: number;
  phase: string;
  error: string | null;
  resultBytes: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  m3uWritten: string | null;
  /** Canonical name from a DAT match, set shortly after the job finishes (hashing runs after "done" so it never delays completion). Purely informational — never renames anything. */
  datMatch: string | null;
}

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
  /** The user explicitly chose to overwrite an existing file at this destination. */
  replace: boolean;
  /** A differently-named file on the card that this job supersedes, removed once the new one is safely written. */
  replacesPath: string | null;
  /** Set when a replace job actually displaced a file, for the Queue page to report. */
  replaced: string | null;
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

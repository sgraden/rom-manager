/** Reads bytes from a source (a real file or, in tests, an in-memory buffer) at arbitrary offsets. */
export interface ByteReader {
  size: number;
  /** Returns up to `length` bytes at `offset`, or null if offset is out of range. May return fewer than `length` bytes near EOF. */
  readAt(offset: number, length: number): Buffer | null;
}

export interface DetectionCandidate {
  systemId: string;
  /** 0–1. Below ~0.5 should read as a guess, not a confident match. */
  confidence: number;
  evidence: string;
}

export interface DetectionResult {
  kind: "cartridge" | "disc" | "archive" | "unknown";
  /** Ranked best-first. */
  candidates: DetectionCandidate[];
  warnings?: string[];
  /** Other files this detection depended on (e.g. a .cue's referenced .bin tracks, or the source archive). */
  relatedFiles?: string[];
}

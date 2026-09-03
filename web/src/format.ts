/**
 * Human-readable byte sizes, with the unit chosen so the number stays meaningful.
 *
 * A single implementation shared by every page: four near-copies had drifted, and the
 * MB-only ones rendered anything under a megabyte as a uselessly flat "0.0 MB".
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 0) return "—";

  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;

  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;

  const kb = bytes / 1024;
  if (kb >= 1) return `${Math.round(kb)} KB`;

  return `${bytes} B`;
}

/** "4m 12s" / "48s" — short enough to sit inline without drawing attention. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A short, absolute date — "3 Sep 2026". */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * An error the user can act on.
 *
 * Every error in this app used to surface as a bare string — often
 * "/api/plan -> 500: chdman is not available.", which is a URL and a status code
 * shown to someone who wants to know what to do next. The shape here separates the
 * three things that matter: what went wrong, what to do about it, and the raw detail
 * needed only if they're going to paste it somewhere.
 */
/** In-app remedies the host page can carry out on the user's behalf. */
export type RemedyKind = "retry" | "open-settings" | "open-library" | "recheck-tools";

export interface ErrorRemedy {
  /** What to do about it, in plain language. */
  text: string;
  /** A shell command the user can copy, when the remedy is one. */
  command?: string;
  /** An in-app action that resolves it. */
  action?: { label: string; kind: RemedyKind };
}

export interface AppError {
  /** What went wrong, in plain language. Never a URL or a status code. */
  message: string;
  remedy?: ErrorRemedy;
  /** The underlying detail — shown collapsed, for pasting into a bug report. */
  cause?: string;
}

/**
 * Recognises the errors this app actually produces and attaches a remedy to each.
 *
 * Matched on the message text the server sends. That's a loose coupling, so every
 * pattern here is paired with a test asserting the real server-side string still
 * matches — see AppError.test.ts.
 */
const PATTERNS: Array<{ test: RegExp; build: (raw: string) => AppError }> = [
  {
    test: /chdman is not available/i,
    build: () => ({
      message: "chdman isn't installed, and it's required to convert disc images.",
      remedy: {
        text: "Install it with Homebrew, then re-check:",
        command: "brew install rom-tools",
        action: { label: "Re-check tools", kind: "recheck-tools" },
      },
    }),
  },
  {
    test: /7zz is not available|7-Zip/i,
    build: (raw) => ({
      message: "7-Zip (7zz) isn't available, and it's needed to read and write archives.",
      remedy: {
        text: "Install it with Homebrew, then re-check:",
        command: "brew install sevenzip",
        action: { label: "Re-check tools", kind: "recheck-tools" },
      },
      cause: raw,
    }),
  },
  {
    test: /DolphinTool is not available/i,
    build: () => ({
      message: "DolphinTool isn't available, so GameCube and Wii images can't be compressed to RVZ.",
      remedy: {
        text: "It ships with the app's npm dependencies — run `npm install` to fetch it. You can also set this file's action to “copy” and add it uncompressed.",
        command: "npm install",
        action: { label: "Re-check tools", kind: "recheck-tools" },
      },
    }),
  },
  {
    test: /already exists at|A file appeared at/i,
    build: (raw) => ({
      message: "That file is already on the card.",
      remedy: {
        text: "Go back to Review and choose Replace for it, or Skip to leave the existing copy alone.",
        action: { label: "View library", kind: "open-library" },
      },
      cause: raw,
    }),
  },
  {
    test: /Not enough free space/i,
    build: (raw) => ({
      message: "There isn't enough free space on the card for this file.",
      remedy: {
        text: "Delete something from the card to make room, then try again.",
        action: { label: "View library", kind: "open-library" },
      },
      cause: raw,
    }),
  },
  {
    test: /is not writable/i,
    build: (raw) => ({
      message: "The card is mounted read-only, so nothing can be written to it.",
      remedy: {
        text: "Eject and reconnect it, and check the card's physical write-protect switch if it has one.",
        action: { label: "Retry", kind: "retry" },
      },
      cause: raw,
    }),
  },
  {
    test: /No destination folder mapped|assign one in Settings/i,
    build: (raw) => ({
      message: "This system has no folder assigned on the card, so there's nowhere to put the file.",
      remedy: {
        text: "Assign an existing folder in Settings, or create one from the Review table.",
        action: { label: "Open settings", kind: "open-settings" },
      },
      cause: raw,
    }),
  },
  {
    test: /needs manual review|doesn't contain a file this action knows how to use/i,
    build: (raw) => ({
      message: "This archive doesn't have one obvious ROM in it.",
      remedy: {
        text: "Extract it yourself and add the game file directly, or pick the action that matches what's inside.",
      },
      cause: raw,
    }),
  },
  {
    // A .cue/.gdi names its track files by relative filename; adding the sheet on its
    // own leaves nothing to convert. Common enough — and fixable enough — to be worth
    // saying out loud rather than reporting as a bare parse failure.
    test: /No referenced track file|Referenced track file\(s\) missing|No referenced track file\(s\) found/i,
    build: (raw) => ({
      message: "That cue sheet's track files aren't next to it.",
      remedy: {
        text:
          "A .cue or .gdi only lists its tracks — the .bin/.img files have to sit in the same folder. " +
          "Add the whole folder's contents, or add the .bin directly and let the app work out the track layout.",
        action: { label: "Retry", kind: "retry" },
      },
      cause: raw,
    }),
  },
  {
    test: /Could not inspect this file|No such file|no such path/i,
    build: (raw) => ({
      message: "That file couldn't be read — it may have been moved, renamed, or its drive unmounted.",
      remedy: { text: "Check it's still where you added it from, then add it again.", action: { label: "Retry", kind: "retry" } },
      cause: raw,
    }),
  },
  {
    // Genuine connectivity failures only. A 5xx is deliberately not matched here: the
    // server did respond, and its message is a real reason worth showing rather than
    // being replaced with "couldn't reach the server".
    test: /Failed to fetch|NetworkError|ERR_CONNECTION|load failed/i,
    build: (raw) => ({
      message: "Couldn't reach the ROM Manager server.",
      remedy: { text: "Make sure it's still running, then try again.", action: { label: "Retry", kind: "retry" } },
      cause: raw,
    }),
  },
];

/**
 * Turns whatever was thrown into something with a remedy where one is known, and a
 * plain message where one isn't. The API client formats its errors as
 * "<url> -> <status>: <message>"; that prefix is stripped for display and preserved
 * in `cause`, since the URL and status are debugging detail rather than the point.
 */
export function toAppError(err: unknown): AppError {
  const raw = err instanceof Error ? err.message : String(err);
  const withoutPrefix = raw.replace(/^\/\S*\s*->\s*\d+:\s*/, "").trim();

  for (const { test, build } of PATTERNS) {
    if (test.test(raw)) return build(raw);
  }

  return { message: withoutPrefix || "Something went wrong.", cause: withoutPrefix === raw ? undefined : raw };
}

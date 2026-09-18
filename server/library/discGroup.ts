// Matches a disc-number token like "(Disc 1)", "[Disk 2]", "(CD 3)" anywhere in a filename.
const DISC_TOKEN = /\s*[[(]\s*(?:disc|disk|cd)\s*(\d+)\s*[)\]]/i;

export interface DiscToken {
  /** The filename with its disc-number token removed and trimmed — the shared identity across a set's discs. */
  baseName: string;
  discNum: number;
}

/** Extracts a filename's disc-number token, if it has one — e.g. "Game (Disc 2).chd" -> { baseName: "Game.chd", discNum: 2 }. */
export function parseDiscToken(filename: string): DiscToken | null {
  const match = filename.match(DISC_TOKEN);
  if (!match) return null;
  return { baseName: filename.replace(DISC_TOKEN, "").trim(), discNum: parseInt(match[1], 10) };
}

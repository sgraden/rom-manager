export type MediaKind = "disc" | "cartridge" | "computer" | "arcade";

/**
 * chd-cd/chd-dvd: convert via chdman (createcd / createdvd)
 * rvz: convert via DolphinTool
 * keep-zip: archive (or re-archive) as a single-file zip
 * copy: leave the file/set exactly as-is — used where recompressing would
 *   break the emulator's expected structure (arcade sets) or isn't
 *   supported yet (computer floppy/hard-disk images)
 */
export type ConvertAction = "chd-cd" | "chd-dvd" | "rvz" | "keep-zip" | "copy";

export interface SystemDef {
  id: string;
  name: string;
  media: MediaKind;
  /** Lowercase, with leading dot. */
  extensions: string[];
  /** Lowercase folder-name aliases used to match a destination's existing folders. */
  folderAliases: string[];
  defaultAction: ConvertAction;
}

export const SYSTEMS: SystemDef[] = [
  // --- Nintendo cartridge ---
  { id: "nes", name: "Nintendo Entertainment System", media: "cartridge", extensions: [".nes"], folderAliases: ["nes", "famicom", "nintendo"], defaultAction: "keep-zip" },
  { id: "fds", name: "Famicom Disk System", media: "cartridge", extensions: [".fds"], folderAliases: ["fds"], defaultAction: "keep-zip" },
  { id: "snes", name: "Super Nintendo", media: "cartridge", extensions: [".sfc", ".smc"], folderAliases: ["snes", "superfamicom", "sfc"], defaultAction: "keep-zip" },
  { id: "n64", name: "Nintendo 64", media: "cartridge", extensions: [".n64", ".z64", ".v64"], folderAliases: ["n64", "nintendo64"], defaultAction: "keep-zip" },
  { id: "gb", name: "Game Boy", media: "cartridge", extensions: [".gb"], folderAliases: ["gb", "gameboy"], defaultAction: "keep-zip" },
  { id: "gbc", name: "Game Boy Color", media: "cartridge", extensions: [".gbc"], folderAliases: ["gbc", "gameboycolor"], defaultAction: "keep-zip" },
  { id: "gba", name: "Game Boy Advance", media: "cartridge", extensions: [".gba"], folderAliases: ["gba", "gameboyadvance"], defaultAction: "keep-zip" },
  { id: "nds", name: "Nintendo DS", media: "cartridge", extensions: [".nds"], folderAliases: ["nds", "ds", "nintendods"], defaultAction: "keep-zip" },
  { id: "gamecube", name: "Nintendo GameCube", media: "disc", extensions: [".iso", ".gcm", ".rvz", ".chd"], folderAliases: ["gamecube", "gc", "ngc"], defaultAction: "rvz" },
  { id: "wii", name: "Nintendo Wii", media: "disc", extensions: [".iso", ".wbfs", ".rvz"], folderAliases: ["wii"], defaultAction: "rvz" },

  // --- Sega ---
  { id: "genesis", name: "Sega Genesis / Mega Drive", media: "cartridge", extensions: [".md", ".gen", ".smd", ".bin"], folderAliases: ["genesis", "megadrive", "md"], defaultAction: "keep-zip" },
  { id: "segacd", name: "Sega CD / Mega CD", media: "disc", extensions: [".cue", ".bin", ".iso", ".chd"], folderAliases: ["segacd", "megacd", "scd"], defaultAction: "chd-cd" },
  { id: "saturn", name: "Sega Saturn", media: "disc", extensions: [".cue", ".bin", ".iso", ".chd"], folderAliases: ["saturn"], defaultAction: "chd-cd" },
  { id: "mastersystem", name: "Sega Master System", media: "cartridge", extensions: [".sms"], folderAliases: ["mastersystem", "sms"], defaultAction: "keep-zip" },
  { id: "gamegear", name: "Sega Game Gear", media: "cartridge", extensions: [".gg"], folderAliases: ["gamegear", "gg"], defaultAction: "keep-zip" },
  { id: "sega32x", name: "Sega 32X", media: "cartridge", extensions: [".32x"], folderAliases: ["sega32x", "32x"], defaultAction: "keep-zip" },
  { id: "dreamcast", name: "Sega Dreamcast", media: "disc", extensions: [".gdi", ".cue", ".bin", ".cdi", ".chd"], folderAliases: ["dreamcast", "dc"], defaultAction: "chd-cd" },

  // --- Sony ---
  { id: "psx", name: "Sony PlayStation", media: "disc", extensions: [".cue", ".bin", ".iso", ".pbp", ".chd"], folderAliases: ["psx", "ps1", "playstation", "psone"], defaultAction: "chd-cd" },
  { id: "ps2", name: "Sony PlayStation 2", media: "disc", extensions: [".iso", ".cue", ".bin", ".chd"], folderAliases: ["ps2", "playstation2"], defaultAction: "chd-dvd" },
  { id: "psp", name: "Sony PSP", media: "disc", extensions: [".iso", ".cso", ".chd"], folderAliases: ["psp"], defaultAction: "chd-dvd" },

  // --- NEC ---
  { id: "pcengine", name: "PC Engine / TurboGrafx-16", media: "cartridge", extensions: [".pce"], folderAliases: ["pcengine", "turbografx", "tg16", "pce"], defaultAction: "keep-zip" },
  { id: "pcenginecd", name: "PC Engine CD / TurboGrafx-CD", media: "disc", extensions: [".cue", ".bin", ".iso", ".chd"], folderAliases: ["pcenginecd", "turbografxcd", "tgcd"], defaultAction: "chd-cd" },

  // --- Other disc ---
  { id: "threedo", name: "3DO", media: "disc", extensions: [".cue", ".bin", ".iso", ".chd"], folderAliases: ["3do"], defaultAction: "chd-cd" },

  // --- Atari cartridge ---
  { id: "atari2600", name: "Atari 2600", media: "cartridge", extensions: [".a26", ".bin"], folderAliases: ["atari2600"], defaultAction: "keep-zip" },
  { id: "atari5200", name: "Atari 5200", media: "cartridge", extensions: [".a52", ".bin"], folderAliases: ["atari5200"], defaultAction: "keep-zip" },
  { id: "atari7800", name: "Atari 7800", media: "cartridge", extensions: [".a78", ".bin"], folderAliases: ["atari7800"], defaultAction: "keep-zip" },
  { id: "atarilynx", name: "Atari Lynx", media: "cartridge", extensions: [".lnx"], folderAliases: ["atarilynx", "lynx"], defaultAction: "keep-zip" },
  { id: "atarijaguar", name: "Atari Jaguar", media: "cartridge", extensions: [".j64", ".jag"], folderAliases: ["atarijaguar", "jaguar"], defaultAction: "keep-zip" },

  // --- Computers ---
  { id: "amiga", name: "Commodore Amiga", media: "computer", extensions: [".adf", ".hdf", ".lha"], folderAliases: ["amiga"], defaultAction: "copy" },
  { id: "c64", name: "Commodore 64", media: "computer", extensions: [".d64", ".t64", ".crt"], folderAliases: ["c64"], defaultAction: "copy" },

  // --- Arcade ---
  { id: "arcade", name: "Arcade (MAME / FBNeo)", media: "arcade", extensions: [".zip"], folderAliases: ["arcade", "mame", "fbneo"], defaultAction: "copy" },
  { id: "neogeo", name: "Neo Geo", media: "arcade", extensions: [".zip"], folderAliases: ["neogeo"], defaultAction: "copy" },
];

const BY_ID = new Map(SYSTEMS.map((s) => [s.id, s]));

export function getSystem(id: string): SystemDef | undefined {
  return BY_ID.get(id);
}

export function findByFolderAlias(folderName: string): SystemDef | undefined {
  const normalized = folderName.trim().toLowerCase();
  return SYSTEMS.find((s) => s.folderAliases.includes(normalized));
}

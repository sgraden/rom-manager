import type { ByteReader, DetectionCandidate } from "./types.js";

const GB_LOGO_PREFIX = Buffer.from([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b]);

/**
 * Identifies a cartridge ROM from magic bytes / header structure. Only reads
 * targeted offsets via `reader.readAt`, never the whole file.
 */
export function detectCartridgeSignatures(reader: ByteReader, ext: string): DetectionCandidate[] {
  const candidates: DetectionCandidate[] = [];

  // NES: iNES header "NES\x1A"
  const nesMagic = reader.readAt(0, 4);
  if (nesMagic && nesMagic[0] === 0x4e && nesMagic[1] === 0x45 && nesMagic[2] === 0x53 && nesMagic[3] === 0x1a) {
    candidates.push({ systemId: "nes", confidence: 0.95, evidence: "iNES header signature 'NES\\x1A' at offset 0" });
  }

  // FDS: "FDS\x1A" (some dumps are prefixed with a 16-byte fwNES header at offset 0 instead — extension-only fallback covers those)
  const fdsMagic = reader.readAt(0, 4);
  if (fdsMagic && fdsMagic[0] === 0x46 && fdsMagic[1] === 0x44 && fdsMagic[2] === 0x53 && fdsMagic[3] === 0x1a) {
    candidates.push({ systemId: "fds", confidence: 0.9, evidence: "FDS header signature 'FDS\\x1A' at offset 0" });
  }

  // N64: 32-bit magic, one of three byte orders depending on dump format (.z64/.v64/.n64)
  const n64Magic = reader.readAt(0, 4);
  if (n64Magic && n64Magic.length === 4) {
    const word = n64Magic.readUInt32BE(0);
    if (word === 0x80371240) {
      candidates.push({ systemId: "n64", confidence: 0.95, evidence: "N64 big-endian (.z64) magic 0x80371240 at offset 0" });
    } else if (word === 0x37804012) {
      candidates.push({ systemId: "n64", confidence: 0.95, evidence: "N64 byte-swapped (.v64) magic 0x37804012 at offset 0" });
    } else if (word === 0x40123780) {
      candidates.push({ systemId: "n64", confidence: 0.95, evidence: "N64 little-endian (.n64) magic 0x40123780 at offset 0" });
    }
  }

  // GB/GBC: Nintendo logo prefix at 0x104, CGB flag at 0x143 distinguishes GBC
  const gbLogo = reader.readAt(0x104, 8);
  if (gbLogo && gbLogo.equals(GB_LOGO_PREFIX)) {
    const cgbFlagByte = reader.readAt(0x143, 1);
    const cgbFlag = cgbFlagByte?.[0];
    const isGbc = cgbFlag === 0x80 || cgbFlag === 0xc0;
    candidates.push({
      systemId: isGbc ? "gbc" : "gb",
      confidence: 0.95,
      evidence: `Nintendo logo at offset 0x104${isGbc ? `; CGB flag 0x${cgbFlag!.toString(16)} at 0x143` : ""}`,
    });
  }

  // GBA: fixed value 0x96 at offset 0xB2
  const gbaFixed = reader.readAt(0xb2, 1);
  if (gbaFixed && gbaFixed[0] === 0x96) {
    candidates.push({ systemId: "gba", confidence: 0.85, evidence: "GBA header fixed value 0x96 at offset 0xB2" });
  }

  // NDS: Nintendo logo checksum 0xCF56 (LE) at offset 0x15C
  const ndsChecksum = reader.readAt(0x15c, 2);
  if (ndsChecksum && ndsChecksum.length === 2 && ndsChecksum.readUInt16LE(0) === 0xcf56) {
    candidates.push({ systemId: "nds", confidence: 0.9, evidence: "NDS Nintendo logo checksum 0xCF56 at offset 0x15C" });
  }

  // Genesis / Mega Drive: "SEGA" ASCII marker at offset 0x100
  const genesisMarker = reader.readAt(0x100, 4);
  if (genesisMarker && genesisMarker.toString("ascii") === "SEGA") {
    candidates.push({ systemId: "genesis", confidence: 0.85, evidence: "'SEGA' ASCII marker at offset 0x100" });
  }

  // Master System / Game Gear share a header: "TMR SEGA" at one of three possible offsets
  // depending on ROM size. Extension disambiguates which of the two systems it is.
  for (const offset of [0x1ff0, 0x3ff0, 0x7ff0]) {
    const marker = reader.readAt(offset, 8);
    if (marker && marker.toString("ascii") === "TMR SEGA") {
      const isGG = ext === ".gg";
      candidates.push({
        systemId: isGG ? "gamegear" : "mastersystem",
        confidence: ext === ".gg" || ext === ".sms" ? 0.85 : 0.55,
        evidence:
          `'TMR SEGA' header marker at offset 0x${offset.toString(16)}` +
          (ext === ".gg" || ext === ".sms"
            ? ` (disambiguated by extension ${ext})`
            : " (Master System and Game Gear share this header; extension was inconclusive, guessing Master System)"),
      });
      break;
    }
  }

  // SNES: header checksum + complement should XOR to 0xFFFF, at one of three
  // possible ROM-mapping locations depending on LoROM/HiROM/ExHiROM layout.
  // ExHiROM's offset (~4MB) is beyond the 64KB header buffer, so this always
  // goes through a targeted seek rather than the cached header bytes.
  const snesOffsets: Array<[number, string]> = [
    [0x7fc0, "LoROM"],
    [0xffc0, "HiROM"],
    [0x40ffc0, "ExHiROM"],
  ];
  for (const [offset, mode] of snesOffsets) {
    const headerBytes = reader.readAt(offset + 0x1c, 4);
    if (!headerBytes || headerBytes.length < 4) continue;
    const complement = headerBytes.readUInt16LE(0);
    const checksum = headerBytes.readUInt16LE(2);
    const bothZero = complement === 0 && checksum === 0;
    if (!bothZero && (complement ^ checksum) === 0xffff) {
      candidates.push({
        systemId: "snes",
        confidence: 0.75,
        evidence: `SNES header checksum/complement consistent at offset 0x${offset.toString(16)} (${mode} mapping)`,
      });
      break;
    }
  }

  return candidates;
}

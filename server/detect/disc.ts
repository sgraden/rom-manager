import type { ByteReader, DetectionCandidate } from "./types.js";

const GAMECUBE_MAGIC = 0xc2339f3d;
const WII_MAGIC = 0x5d1c9ea3;

/** GameCube/Wii boot-disc magic — the most reliable signal in this module. */
export function detectDiscMagic(reader: ByteReader): DetectionCandidate | null {
  const gc = reader.readAt(0x1c, 4);
  if (gc && gc.length === 4 && gc.readUInt32BE(0) === GAMECUBE_MAGIC) {
    return { systemId: "gamecube", confidence: 0.97, evidence: "GameCube disc magic 0xC2339F3D at offset 0x1C" };
  }
  const wii = reader.readAt(0x18, 4);
  if (wii && wii.length === 4 && wii.readUInt32BE(0) === WII_MAGIC) {
    return { systemId: "wii", confidence: 0.97, evidence: "Wii disc magic 0x5D1C9EA3 at offset 0x18" };
  }
  return null;
}

interface IpBinMarker {
  marker: string;
  systemId: string;
  confidence: number;
}

const IP_BIN_MARKERS: IpBinMarker[] = [
  { marker: "SEGA SEGAKATANA", systemId: "dreamcast", confidence: 0.95 },
  { marker: "SEGA SEGASATURN", systemId: "saturn", confidence: 0.95 },
  { marker: "SEGADISCSYSTEM", systemId: "segacd", confidence: 0.95 },
  { marker: "PC Engine CD-ROM", systemId: "pcenginecd", confidence: 0.9 },
];

/**
 * Searches the first 64KB for known IP.BIN / boot-sector text markers. A
 * substring search (rather than exact offsets) is deliberate: track pregap
 * and sector-header conventions vary enough across bin/iso/cdi dumps that a
 * fixed offset would miss real files.
 */
export function detectIpBinStrings(reader: ByteReader): DetectionCandidate[] {
  const header = reader.readAt(0, Math.min(reader.size, 65536));
  if (!header) return [];
  const text = header.toString("latin1");

  const candidates: DetectionCandidate[] = [];
  for (const { marker, systemId, confidence } of IP_BIN_MARKERS) {
    if (text.includes(marker)) {
      candidates.push({ systemId, confidence, evidence: `IP.BIN string "${marker}" found in first 64KB` });
    }
  }

  // 3DO has no single well-documented magic string as reliable as the above;
  // this is a deliberately low-confidence heuristic, not an authoritative check.
  if (text.includes("3DO") && text.includes("CD-ROM")) {
    candidates.push({
      systemId: "threedo",
      confidence: 0.4,
      evidence: "Low-confidence heuristic: '3DO' and 'CD-ROM' strings both found in first 64KB",
    });
  }

  return candidates;
}

const SECTOR_SIZE = 2048;

export interface Iso9660Entry {
  name: string;
  isDirectory: boolean;
  extentLba: number;
  dataLength: number;
}

/** Reads only the root directory's entries (no recursion into subdirectories — v1 only needs top-level markers). */
export function readIso9660RootEntries(reader: ByteReader): Iso9660Entry[] | null {
  const pvd = reader.readAt(16 * SECTOR_SIZE, SECTOR_SIZE);
  if (!pvd || pvd.length < 190) return null;
  if (pvd[0] !== 1 || pvd.subarray(1, 6).toString("ascii") !== "CD001") return null;

  const rootRecordOffset = 156;
  const extentLba = pvd.readUInt32LE(rootRecordOffset + 2);
  const dataLength = pvd.readUInt32LE(rootRecordOffset + 10);
  if (extentLba === 0 || dataLength === 0) return null;

  const dirData = reader.readAt(extentLba * SECTOR_SIZE, Math.min(dataLength, 65536));
  if (!dirData) return null;

  const entries: Iso9660Entry[] = [];
  let pos = 0;
  while (pos < dirData.length) {
    const recLen = dirData[pos];
    if (recLen === 0) {
      // Padding to the next sector boundary.
      const next = pos + (SECTOR_SIZE - (pos % SECTOR_SIZE));
      if (next <= pos) break;
      pos = next;
      continue;
    }
    if (pos + 34 > dirData.length) break;

    const entryExtentLba = dirData.readUInt32LE(pos + 2);
    const entryDataLength = dirData.readUInt32LE(pos + 10);
    const flags = dirData[pos + 25];
    const idLen = dirData[pos + 32];
    const isSelfOrParent = idLen === 1 && (dirData[pos + 33] === 0 || dirData[pos + 33] === 1);

    if (!isSelfOrParent && pos + 33 + idLen <= dirData.length) {
      const rawName = dirData.subarray(pos + 33, pos + 33 + idLen).toString("ascii");
      entries.push({
        name: rawName.replace(/;\d+$/, ""),
        isDirectory: (flags & 0x02) !== 0,
        extentLba: entryExtentLba,
        dataLength: entryDataLength,
      });
    }

    pos += recLen;
  }

  return entries;
}

export function findEntry(entries: Iso9660Entry[], name: string): Iso9660Entry | undefined {
  const target = name.toLowerCase();
  return entries.find((e) => e.name.toLowerCase() === target);
}

export function readIso9660FileContent(reader: ByteReader, entry: Iso9660Entry, maxBytes = 4096): Buffer | null {
  return reader.readAt(entry.extentLba * SECTOR_SIZE, Math.min(entry.dataLength, maxBytes));
}

/** Identifies PS1/PS2/PSP from the root directory's SYSTEM.CNF / PSP_GAME markers. */
export function detectIso9660(reader: ByteReader): DetectionCandidate[] {
  const entries = readIso9660RootEntries(reader);
  if (!entries) return [];

  const candidates: DetectionCandidate[] = [];

  const systemCnf = findEntry(entries, "SYSTEM.CNF");
  if (systemCnf && !systemCnf.isDirectory) {
    const content = readIso9660FileContent(reader, systemCnf)?.toString("ascii") ?? "";
    if (/BOOT2\s*=/.test(content)) {
      candidates.push({ systemId: "ps2", confidence: 0.95, evidence: "ISO9660 root SYSTEM.CNF contains BOOT2=" });
    } else if (/BOOT\s*=/.test(content)) {
      candidates.push({ systemId: "psx", confidence: 0.95, evidence: "ISO9660 root SYSTEM.CNF contains BOOT=" });
    }
  }

  const pspGame = findEntry(entries, "PSP_GAME");
  if (pspGame?.isDirectory) {
    candidates.push({ systemId: "psp", confidence: 0.9, evidence: "ISO9660 root contains PSP_GAME/ directory" });
  }
  if (findEntry(entries, "UMD_DATA.BIN")) {
    candidates.push({ systemId: "psp", confidence: 0.9, evidence: "ISO9660 root contains UMD_DATA.BIN" });
  }

  return candidates;
}

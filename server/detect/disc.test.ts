import { describe, it, expect } from "vitest";
import { BufferReader } from "./fileReader.js";
import { detectDiscMagic, detectIpBinStrings, detectIso9660 } from "./disc.js";

describe("detectDiscMagic", () => {
  it("detects GameCube magic at 0x1C", () => {
    const buf = Buffer.alloc(0x20);
    buf.writeUInt32BE(0xc2339f3d, 0x1c);
    expect(detectDiscMagic(new BufferReader(buf))?.systemId).toBe("gamecube");
  });

  it("detects Wii magic at 0x18", () => {
    const buf = Buffer.alloc(0x20);
    buf.writeUInt32BE(0x5d1c9ea3, 0x18);
    expect(detectDiscMagic(new BufferReader(buf))?.systemId).toBe("wii");
  });

  it("returns null for non-matching data", () => {
    const buf = Buffer.alloc(0x20);
    expect(detectDiscMagic(new BufferReader(buf))).toBeNull();
  });
});

describe("detectIpBinStrings", () => {
  it("finds the Dreamcast IP.BIN marker", () => {
    const buf = Buffer.alloc(1024);
    buf.write("SEGA SEGAKATANA", 0, "ascii");
    expect(detectIpBinStrings(new BufferReader(buf)).some((c) => c.systemId === "dreamcast")).toBe(true);
  });

  it("finds the Saturn IP.BIN marker", () => {
    const buf = Buffer.alloc(1024);
    buf.write("SEGA SEGASATURN", 16, "ascii");
    expect(detectIpBinStrings(new BufferReader(buf)).some((c) => c.systemId === "saturn")).toBe(true);
  });

  it("finds the Sega CD marker", () => {
    const buf = Buffer.alloc(1024);
    buf.write("SEGADISCSYSTEM", 0, "ascii");
    expect(detectIpBinStrings(new BufferReader(buf)).some((c) => c.systemId === "segacd")).toBe(true);
  });

  it("finds nothing in unrelated data", () => {
    const buf = Buffer.alloc(1024);
    expect(detectIpBinStrings(new BufferReader(buf))).toEqual([]);
  });
});

const SECTOR_SIZE = 2048;

/** Builds a minimal but structurally valid ISO9660 image with one root file: SYSTEM.CNF. */
function buildIso9660WithSystemCnf(content: string): Buffer {
  const contentBuf = Buffer.from(content, "ascii");
  const rootDirLba = 17;
  const fileLba = 18;
  const totalSectors = fileLba + Math.ceil(contentBuf.length / SECTOR_SIZE) + 1;
  const image = Buffer.alloc(totalSectors * SECTOR_SIZE);

  // SYSTEM.CNF's directory record, stored in the root directory's own extent (sector 17).
  const nameBuf = Buffer.from("SYSTEM.CNF;1", "ascii");
  const recLen = 33 + nameBuf.length + (nameBuf.length % 2 === 0 ? 1 : 0);
  const dirRecord = Buffer.alloc(recLen);
  dirRecord[0] = recLen;
  dirRecord.writeUInt32LE(fileLba, 2);
  dirRecord.writeUInt32LE(contentBuf.length, 10);
  dirRecord[25] = 0; // flags: file, not directory
  dirRecord[32] = nameBuf.length;
  nameBuf.copy(dirRecord, 33);
  dirRecord.copy(image, rootDirLba * SECTOR_SIZE);

  // Primary Volume Descriptor at sector 16, pointing at the root directory.
  const pvdOffset = 16 * SECTOR_SIZE;
  image[pvdOffset] = 1;
  image.write("CD001", pvdOffset + 1, "ascii");
  const rootRecord = Buffer.alloc(34);
  rootRecord[0] = 34;
  rootRecord.writeUInt32LE(rootDirLba, 2);
  rootRecord.writeUInt32LE(SECTOR_SIZE, 10);
  rootRecord[25] = 0x02;
  rootRecord.copy(image, pvdOffset + 156);

  // SYSTEM.CNF's actual content, at its own extent (sector 18).
  contentBuf.copy(image, fileLba * SECTOR_SIZE);

  return image;
}

describe("detectIso9660", () => {
  it("reports PS2 when SYSTEM.CNF contains BOOT2=", () => {
    const image = buildIso9660WithSystemCnf("BOOT2 = cdrom0:\\SLES_123.45;1\r\nVER = 1.00\r\n");
    const candidates = detectIso9660(new BufferReader(image));
    expect(candidates.some((c) => c.systemId === "ps2")).toBe(true);
  });

  it("reports PS1 when SYSTEM.CNF contains BOOT= (no '2')", () => {
    const image = buildIso9660WithSystemCnf("BOOT = cdrom:\\SLUS_123.45;1\r\nTCB = 4\r\n");
    const candidates = detectIso9660(new BufferReader(image));
    expect(candidates.some((c) => c.systemId === "psx")).toBe(true);
  });

  it("returns nothing for an image with no ISO9660 PVD", () => {
    const buf = Buffer.alloc(20 * SECTOR_SIZE);
    expect(detectIso9660(new BufferReader(buf))).toEqual([]);
  });
});

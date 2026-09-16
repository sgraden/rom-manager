import { describe, it, expect } from "vitest";
import { BufferReader } from "./fileReader.js";
import { detectCartridgeSignatures } from "./signatures.js";

function blank(size: number): Buffer {
  return Buffer.alloc(size);
}

describe("detectCartridgeSignatures", () => {
  it("detects NES via the iNES header", () => {
    const buf = blank(64);
    buf.write("NES\x1a", 0, "latin1");
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".nes");
    expect(candidates.some((c) => c.systemId === "nes")).toBe(true);
  });

  it("detects 3DS via the 'NCSD' container magic at 0x100", () => {
    const buf = blank(0x200);
    buf.write("NCSD", 0x100, "ascii");
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".3ds");
    expect(candidates.some((c) => c.systemId === "3ds")).toBe(true);
  });

  it("detects Genesis via the 'SEGA' marker at 0x100", () => {
    const buf = blank(0x200);
    buf.write("SEGA", 0x100, "ascii");
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".md");
    expect(candidates.some((c) => c.systemId === "genesis")).toBe(true);
  });

  it("detects N64 via the big-endian (.z64) magic", () => {
    const buf = blank(64);
    buf.writeUInt32BE(0x80371240, 0);
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".z64");
    expect(candidates.some((c) => c.systemId === "n64")).toBe(true);
  });

  it("detects N64 via the byte-swapped (.v64) magic", () => {
    const buf = blank(64);
    buf.writeUInt32BE(0x37804012, 0);
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".v64");
    expect(candidates.some((c) => c.systemId === "n64")).toBe(true);
  });

  it("detects GBC via the Nintendo logo prefix and CGB flag", () => {
    const buf = blank(0x150);
    Buffer.from([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b]).copy(buf, 0x104);
    buf[0x143] = 0xc0;
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".gbc");
    expect(candidates.some((c) => c.systemId === "gbc")).toBe(true);
  });

  it("detects plain GB (no CGB flag) via the same logo prefix", () => {
    const buf = blank(0x150);
    Buffer.from([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b]).copy(buf, 0x104);
    buf[0x143] = 0x00;
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".gb");
    expect(candidates.some((c) => c.systemId === "gb")).toBe(true);
  });

  it("detects GBA via the fixed value 0x96 at 0xB2", () => {
    const buf = blank(0x100);
    buf[0xb2] = 0x96;
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".gba");
    expect(candidates.some((c) => c.systemId === "gba")).toBe(true);
  });

  it("detects NDS via the logo checksum 0xCF56 at 0x15C", () => {
    const buf = blank(0x160);
    buf.writeUInt16LE(0xcf56, 0x15c);
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".nds");
    expect(candidates.some((c) => c.systemId === "nds")).toBe(true);
  });

  it("detects SMS via 'TMR SEGA' plus a .sms extension", () => {
    const buf = blank(0x8000);
    buf.write("TMR SEGA", 0x1ff0, "ascii");
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".sms");
    expect(candidates.some((c) => c.systemId === "mastersystem")).toBe(true);
  });

  it("detects Game Gear via 'TMR SEGA' plus a .gg extension", () => {
    const buf = blank(0x8000);
    buf.write("TMR SEGA", 0x1ff0, "ascii");
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".gg");
    expect(candidates.some((c) => c.systemId === "gamegear")).toBe(true);
  });

  it("detects SNES via LoROM checksum/complement consistency", () => {
    const buf = blank(0x8000);
    const checksum = 0x1234;
    const complement = checksum ^ 0xffff;
    buf.writeUInt16LE(complement, 0x7fc0 + 0x1c);
    buf.writeUInt16LE(checksum, 0x7fc0 + 0x1e);
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".sfc");
    expect(candidates.some((c) => c.systemId === "snes")).toBe(true);
  });

  it("returns no candidates for random, header-less data", () => {
    const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const candidates = detectCartridgeSignatures(new BufferReader(buf), ".xyz");
    expect(candidates.length).toBe(0);
  });
});

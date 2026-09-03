import { describe, it, expect } from "vitest";
import { formatBytes, formatDuration } from "./format";

describe("formatBytes", () => {
  it("picks a unit that keeps the number meaningful", () => {
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512.0 MB");
    expect(formatBytes(40 * 1024)).toBe("40 KB");
    expect(formatBytes(300)).toBe("300 B");
  });

  it("never flattens a small file to '0.0 MB'", () => {
    // The per-page MB-only copies did exactly this, which made every cartridge ROM
    // and every small conversion result read as zero.
    for (const bytes of [1, 300, 4096, 40_000]) {
      expect(formatBytes(bytes)).not.toBe("0.0 MB");
    }
  });

  it("renders an unknown size as a dash rather than NaN", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
  });

  it("handles exact unit boundaries", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("uses seconds below a minute and m/s above", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_600_000)).toBe("60m 00s");
  });

  it("never renders a negative duration", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

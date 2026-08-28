import { describe, it, expect } from "vitest";
import { groupForM3u, m3uFilenameFor, m3uContent } from "./m3u.js";

describe("groupForM3u", () => {
  it("groups files that share a base name apart from a disc token", () => {
    const groups = groupForM3u([
      { folder: "/roms/psx", filename: "Final Game (Disc 1).chd" },
      { folder: "/roms/psx", filename: "Final Game (Disc 2).chd" },
      { folder: "/roms/psx", filename: "Unrelated Game.chd" },
    ]);
    expect(groups.size).toBe(1);
    const [[key, group]] = groups;
    expect(key).toBe("/roms/psx::Final Game.chd");
    expect(group.discs.map((d) => d.filename).sort()).toEqual(["Final Game (Disc 1).chd", "Final Game (Disc 2).chd"]);
  });

  it("recognizes [Disk N] and (CD N) token variants", () => {
    const groups = groupForM3u([
      { folder: "/roms/saturn", filename: "Game [Disk 1].chd" },
      { folder: "/roms/saturn", filename: "Game [Disk 2].chd" },
      { folder: "/roms/segacd", filename: "Other (CD 1).chd" },
      { folder: "/roms/segacd", filename: "Other (CD 2).chd" },
    ]);
    expect(groups.size).toBe(2);
  });

  it("keeps groups from different folders separate even with the same base name", () => {
    const groups = groupForM3u([
      { folder: "/roms/psx", filename: "Game (Disc 1).chd" },
      { folder: "/roms/saturn", filename: "Game (Disc 1).chd" },
    ]);
    expect(groups.size).toBe(2);
  });

  it("ignores files with no disc token", () => {
    const groups = groupForM3u([{ folder: "/roms/psx", filename: "Solo Game.chd" }]);
    expect(groups.size).toBe(0);
  });
});

describe("m3uFilenameFor", () => {
  it("derives a .m3u name from the group key's base name", () => {
    expect(m3uFilenameFor("/roms/psx::Final Game.chd")).toBe("Final Game.m3u");
  });
});

describe("m3uContent", () => {
  it("lists discs in numeric order regardless of input order", () => {
    const content = m3uContent([
      { num: 2, filename: "Game (Disc 2).chd" },
      { num: 1, filename: "Game (Disc 1).chd" },
    ]);
    expect(content).toBe("Game (Disc 1).chd\nGame (Disc 2).chd\n");
  });
});

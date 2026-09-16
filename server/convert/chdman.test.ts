import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createChd } from "./chdman.js";

const dirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rom-manager-chdman-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A fake chdman binary that spams \r-updated progress lines, then prints one real error line and exits 1 — mirrors a real chdman failure deep into a long conversion. */
function makeFakeFailingChdman(dir: string): string {
  const scriptPath = path.join(dir, "fake-chdman.sh");
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) {
    lines.push(`printf 'Compressing, %d.0%% complete... (ratio=54.%d%%)\\r'` + ` ${i % 100} ${i % 10}`);
  }
  const script = `#!/bin/sh\n${lines.join("\n")}\nprintf '\\nFatal error occurred: something specific went wrong\\n'\nexit 1\n`;
  writeFileSync(scriptPath, script, "utf-8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("createChd error reporting", () => {
  it("keeps the real error line and drops repeated progress spam when chdman fails", async () => {
    const dir = makeTempDir();
    const fakeChdman = makeFakeFailingChdman(dir);

    await expect(createChd(fakeChdman, path.join(dir, "in.iso"), path.join(dir, "out.chd"), "createdvd")).rejects.toThrow(
      /Fatal error occurred: something specific went wrong/,
    );
  });

  it("does not let progress spam push the real error line out of the reported message", async () => {
    const dir = makeTempDir();
    const fakeChdman = makeFakeFailingChdman(dir);

    try {
      await createChd(fakeChdman, path.join(dir, "in.iso"), path.join(dir, "out.chd"), "createdvd");
      expect.unreachable("expected createChd to reject");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("Fatal error occurred");
      // 500 spammed progress lines would easily blow well past this if they weren't filtered out.
      expect(message.length).toBeLessThan(500);
    }
  });
});

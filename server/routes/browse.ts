import { Router } from "express";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export const browseRouter = Router();

interface NativeBrowseFile {
  path: string;
  name: string;
  size: number;
}

// `choose file` is a Standard Additions dialog run in osascript's own process — it doesn't
// send an Apple Event to another app, so it needs no Automation/TCC permission grant.
const CHOOSE_FILE_SCRIPT = `
try
  activate
  set theFiles to choose file with prompt "Select ROM files to add" with multiple selections allowed
on error number -128
  return ""
end try
set thePaths to {}
repeat with aFile in theFiles
  set end of thePaths to POSIX path of aFile
end repeat
set AppleScript's text item delimiters to linefeed
return thePaths as text
`;

/** Opens the real macOS file-open panel and returns whatever the user picked (or nothing, if they cancelled). */
browseRouter.post("/native", (req, res) => {
  if (process.platform !== "darwin") {
    res.status(400).json({ error: "The native file picker is only available on macOS." });
    return;
  }

  execFile("osascript", ["-e", CHOOSE_FILE_SCRIPT], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) {
      res.status(500).json({ error: `Couldn't open the file picker: ${err.message}` });
      return;
    }

    const files: NativeBrowseFile[] = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((filePath) => {
        try {
          return [{ path: filePath, name: path.basename(filePath), size: statSync(filePath).size }];
        } catch {
          return [];
        }
      });

    res.json({ files });
  });
});

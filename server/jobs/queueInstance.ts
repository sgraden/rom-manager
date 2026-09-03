import { JobQueue } from "./queue.js";
import { loadConfig } from "../library/config.js";
import { detectTools } from "../convert/tools.js";
import { loadDatIndex } from "../library/dat.js";
import { DATS_DIR } from "../lib/paths.js";

// Loaded once at startup — per PLAN.md, dropping a new DAT file into
// config/dats/ takes a restart to pick up, same as any other config change.
export const datIndex = loadDatIndex(DATS_DIR);

export const jobQueue = new JobQueue(
  () => loadConfig().maxConcurrentJobs,
  () => loadConfig().verifyAfterConvert,
  () => {
    const config = loadConfig();
    const tools = detectTools(config.toolPathOverrides);
    const find = (id: string) => tools.find((t) => t.id === id);
    const chdman = find("chdman");
    const sevenZip = find("sevenZip");
    const dolphinTool = find("dolphinTool");
    return {
      chdmanPath: chdman?.found ? chdman.path : null,
      sevenZipPath: sevenZip?.found ? sevenZip.path : null,
      dolphinToolPath: dolphinTool?.found ? dolphinTool.path : null,
    };
  },
  () => loadConfig().deleteSourceAfterSuccess,
  () => loadConfig().reservedCpuCores,
  datIndex,
);

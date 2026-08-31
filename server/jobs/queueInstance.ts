import { JobQueue } from "./queue.js";
import { loadConfig } from "../library/config.js";
import { detectTools } from "../convert/tools.js";

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
);

export interface ToolInfo {
  id: string;
  name: string;
  required: boolean;
  found: boolean;
  path: string | null;
  version: string | null;
  purpose: string;
  installHint: string;
}

export interface TargetInfo {
  name: string;
  path: string;
  romRoot: string;
  freeBytes: number | null;
  totalBytes: number | null;
  fsType: string | null;
  writable: boolean;
  folders: string[];
}

export type MediaKind = "disc" | "cartridge" | "computer" | "arcade";
export type ConvertAction = "chd-cd" | "chd-dvd" | "rvz" | "keep-zip" | "copy";

export interface SystemDef {
  id: string;
  name: string;
  media: MediaKind;
  extensions: string[];
  folderAliases: string[];
  defaultAction: ConvertAction;
}

export interface DetectionCandidate {
  systemId: string;
  confidence: number;
  evidence: string;
}

export interface PlanOverride {
  systemId?: string;
  action?: ConvertAction;
}

export interface PlannedJob {
  sourcePath: string;
  sourceName: string;
  sourceBytes: number;
  sourceKind: "cartridge" | "disc" | "archive" | "unknown";
  candidates: DetectionCandidate[];
  selectedSystemId: string | null;
  action: ConvertAction | null;
  destinationFolder: string | null;
  destinationFilename: string | null;
  estimatedOutputBytes: number | null;
  warnings: string[];
}

export interface FolderMapResult {
  folderMap: Record<string, string>;
  unmatchedFolders: string[];
  unmappedSystemIds: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await safeErrorText(res)}`);
  return res.json() as Promise<T>;
}

async function sendJson<T>(method: "POST" | "PUT", url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${await safeErrorText(res)}`);
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return sendJson("POST", url, body);
}

function putJson<T>(url: string, body: unknown): Promise<T> {
  return sendJson("PUT", url, body);
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

/** `refresh` re-runs the real tool probes instead of returning the server's memoized result. */
export function fetchTools(refresh = false): Promise<{ tools: ToolInfo[] }> {
  return getJson(refresh ? "/api/tools?refresh=1" : "/api/tools");
}

export function fetchTargets(): Promise<{ targets: TargetInfo[] }> {
  return getJson("/api/targets");
}

export function fetchSystems(): Promise<{ systems: SystemDef[] }> {
  return getJson("/api/systems");
}

export function fetchFolderMap(targetName: string): Promise<FolderMapResult> {
  return getJson(`/api/targets/${encodeURIComponent(targetName)}/folder-map`);
}

export function setFolderMapEntry(targetName: string, systemId: string, folder: string | null): Promise<FolderMapResult> {
  return putJson(`/api/targets/${encodeURIComponent(targetName)}/folder-map`, { systemId, folder });
}

/** Creates a new system folder on the destination (defaults to the system's canonical alias, e.g. "ps2") and maps it. */
export function createFolder(targetName: string, systemId: string, folderName?: string): Promise<FolderMapResult> {
  return postJson(`/api/targets/${encodeURIComponent(targetName)}/folders`, { systemId, folderName });
}

export interface NativeBrowseFile {
  path: string;
  name: string;
  size: number;
}

/** Opens the real macOS file-open panel and returns whatever the user picked. */
export function browseNative(): Promise<{ files: NativeBrowseFile[] }> {
  return postJson("/api/browse/native", {});
}

export interface IngestedFile {
  path: string;
  name: string;
  size: number;
}

export function ingestPath(path: string): Promise<IngestedFile> {
  return postJson("/api/ingest/path", { path });
}

export function uploadFile(file: File, onProgress?: (bytesSent: number, totalBytes: number) => void): Promise<IngestedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/ingest/upload?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed (network error)"));
    xhr.send(file);
  });
}

export function planJobs(sourcePaths: string[], targetName: string, overrides?: Record<string, PlanOverride>): Promise<{ jobs: PlannedJob[] }> {
  return postJson("/api/plan", { sourcePaths, targetName, overrides });
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  sourcePath: string;
  sourceName: string;
  sourceBytes: number;
  selectedSystemId: string;
  action: ConvertAction;
  destinationFolder: string;
  destinationFilename: string;
  destinationPath: string;
  state: JobState;
  percent: number;
  phase: string;
  error: string | null;
  resultBytes: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  m3uWritten: string | null;
  datMatch: string | null;
}

export interface SubmitJobsResult {
  results: Array<{ ok: true; job: JobInfo } | { ok: false; sourcePath: string; error: string }>;
}

export function fetchJobs(): Promise<{ jobs: JobInfo[] }> {
  return getJson("/api/jobs");
}

export function submitJobs(sourcePaths: string[], targetName: string, overrides?: Record<string, PlanOverride>): Promise<SubmitJobsResult> {
  return postJson("/api/jobs", { sourcePaths, targetName, overrides });
}

export function cancelJob(id: string): Promise<{ ok: true }> {
  return postJson(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
}

/** Drops finished jobs from the Queue list. The durable record stays in data/library.jsonl. */
export async function clearCompletedJobs(): Promise<{ removed: number }> {
  const res = await fetch("/api/jobs/completed", { method: "DELETE" });
  if (!res.ok) throw new Error(`/api/jobs/completed -> ${res.status}: ${await safeErrorText(res)}`);
  return res.json() as Promise<{ removed: number }>;
}

export interface PerformanceConfig {
  maxConcurrentJobs: number;
  reservedCpuCores: number;
  verifyAfterConvert: boolean;
  deleteSourceAfterSuccess: boolean;
  cpuCoreCount: number;
}

export function fetchPerformanceConfig(): Promise<PerformanceConfig> {
  return getJson("/api/config");
}

export function setPerformanceConfig(patch: Partial<Omit<PerformanceConfig, "cpuCoreCount">>): Promise<PerformanceConfig> {
  return putJson("/api/config", patch);
}

type JobEvent = { type: "snapshot"; jobs: JobInfo[] } | { type: "update"; job: JobInfo };

/** Subscribes to live job progress over SSE. Returns an unsubscribe function. */
export function subscribeJobEvents(onEvent: (event: JobEvent) => void): () => void {
  const source = new EventSource("/api/jobs/events");
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      // ignore malformed event
    }
  };
  return () => source.close();
}

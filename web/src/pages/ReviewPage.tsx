import { useEffect, useState } from "react";
import {
  fetchSystems,
  planJobs,
  submitJobs,
  createFolder,
  type SystemDef,
  type PlannedJob,
  type ConvertAction,
  type PlanOverride,
} from "../api";
import { useSlowFlag } from "../useSlowFlag";
import { Spinner } from "../Spinner";
import { ActionBar } from "../ActionBar";

const ACTIONS: ConvertAction[] = ["chd-cd", "chd-dvd", "rvz", "keep-zip", "copy"];

const ACTION_EXPLANATION: Record<ConvertAction, string> = {
  "chd-cd": "CD-based discs (PS1, Saturn, Sega CD, Dreamcast, PC Engine CD, 3DO) — chdman's CD mode understands CD track/cue structure.",
  "chd-dvd": "DVD-based discs (PS2, PSP) — same CHD format, but chdman's DVD mode expects flat sector data with no CD track structure.",
  rvz: "GameCube/Wii, via DolphinTool. Falls back to a plain copy if DolphinTool isn't installed.",
  "keep-zip": "Cartridge ROMs — zipped (or re-zipped) since most emulator cores read zip archives directly.",
  copy: "Computer disk images and arcade sets — copied as-is; recompressing would break the structure the emulator expects.",
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function CreateFolderButton({ system, onCreate }: { system: SystemDef | undefined; onCreate: (name: string) => Promise<void> }) {
  const defaultName = system?.folderAliases[0] ?? system?.id ?? "";
  const [name, setName] = useState(defaultName);
  const [creating, setCreating] = useState(false);

  if (!system) return <span className="muted">unmapped</span>;

  return (
    <div className="create-folder">
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="create-folder-input" />
      <button
        onClick={async () => {
          setCreating(true);
          try {
            await onCreate(name);
          } finally {
            setCreating(false);
          }
        }}
        disabled={creating || !name.trim()}
      >
        {creating ? "Creating…" : "Create folder"}
      </button>
    </div>
  );
}

export function ReviewPage({
  targetName,
  initialJobs,
  onProcessed,
}: {
  targetName: string;
  initialJobs: PlannedJob[];
  onProcessed: () => void;
}) {
  const [systems, setSystems] = useState<SystemDef[] | null>(null);
  const [jobs, setJobs] = useState<PlannedJob[]>(initialJobs);
  const [overrides, setOverrides] = useState<Record<string, PlanOverride>>({});
  const [busy, setBusy] = useState(false);
  const slowBusy = useSlowFlag(busy);
  const [processing, setProcessing] = useState(false);
  const slowProcessing = useSlowFlag(processing);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setJobs(initialJobs);
    setOverrides({});
  }, [initialJobs]);

  useEffect(() => {
    fetchSystems()
      .then((r) => setSystems(r.systems))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  /**
   * Re-plans `sourcePaths` and merges the results into the table, leaving every other
   * row untouched. Scoping this matters: planning re-runs detection on each path, and
   * for an archived disc that means 7zz work — so re-planning all twenty rows to
   * reflect one dropdown change was doing nineteen files' worth of pointless work.
   */
  async function replan(nextOverrides: Record<string, PlanOverride>, sourcePaths: string[]) {
    if (sourcePaths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { jobs: replanned } = await planJobs(sourcePaths, targetName, nextOverrides);
      const bySourcePath = new Map(replanned.map((j) => [j.sourcePath, j] as const));
      setJobs((prev) => prev.map((job) => bySourcePath.get(job.sourcePath) ?? job));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyOverride(sourcePath: string, next: PlanOverride) {
    const nextOverrides = { ...overrides, [sourcePath]: { ...overrides[sourcePath], ...next } };
    setOverrides(nextOverrides);
    await replan(nextOverrides, [sourcePath]);
  }

  async function handleCreateFolder(systemId: string, defaultName: string) {
    setError(null);
    try {
      await createFolder(targetName, systemId, defaultName);
      // Unlike an override, a new folder can resolve the destination for every row
      // mapped to that system, so all of them need re-planning — but only those.
      const affected = jobs.filter((j) => j.selectedSystemId === systemId).map((j) => j.sourcePath);
      await replan(overrides, affected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleProcess() {
    setProcessing(true);
    setError(null);
    try {
      const sourcePaths = jobs.map((j) => j.sourcePath);
      const { results } = await submitJobs(sourcePaths, targetName, overrides);
      const failures = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
      if (failures.length > 0) {
        setError(failures.map((f) => `${f.sourcePath}: ${f.error}`).join("; "));
      }
      onProcessed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProcessing(false);
    }
  }

  if (jobs.length === 0) {
    return (
      <div className="review-page">
        <p className="muted">Nothing to review yet — queue and plan some files on the Drop tab first.</p>
      </div>
    );
  }

  const readyCount = jobs.filter((j) => j.selectedSystemId && j.action && j.destinationFolder).length;

  return (
    <div className="review-page">
      <p className="preview-banner">
        Writing to <strong>{targetName}</strong>. Files are converted and copied when you click Process — nothing happens until then.
      </p>
      <details className="action-help">
        <summary>What do these actions mean?</summary>
        <ul>
          {ACTIONS.map((a) => (
            <li key={a}>
              <strong>{a}</strong> — {ACTION_EXPLANATION[a]}
            </li>
          ))}
        </ul>
      </details>
      {error && <p className="error">{error}</p>}
      {busy && (
        <p className="inline-status">
          <Spinner />
          {slowBusy ? "Still working — re-checking the destination takes a moment." : "Re-planning…"}
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Kind</th>
            <th>System</th>
            <th>Action</th>
            <th>Destination</th>
            <th>Size before → est. after</th>
            <th>Warnings</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.sourcePath} className={job.warnings.length > 0 ? "plan-row-warn" : ""}>
              <td className="mono">{job.sourceName}</td>
              <td>{job.sourceKind}</td>
              <td>
                <select
                  value={job.selectedSystemId ?? ""}
                  onChange={(e) => applyOverride(job.sourcePath, { systemId: e.target.value || undefined })}
                >
                  <option value="">— unset —</option>
                  {systems?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {job.candidates.length > 0 && (
                  <div className="evidence">
                    {job.candidates[0].evidence} ({Math.round(job.candidates[0].confidence * 100)}%)
                  </div>
                )}
              </td>
              <td>
                <select
                  value={job.action ?? ""}
                  title={job.action ? ACTION_EXPLANATION[job.action] : undefined}
                  onChange={(e) => applyOverride(job.sourcePath, { action: (e.target.value || undefined) as ConvertAction | undefined })}
                >
                  <option value="">—</option>
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </td>
              <td className="mono">
                {job.destinationFolder ? (
                  `${job.destinationFolder}/${job.destinationFilename}`
                ) : job.selectedSystemId && systems ? (
                  <CreateFolderButton
                    key={job.selectedSystemId}
                    system={systems.find((s) => s.id === job.selectedSystemId)}
                    onCreate={(name) => handleCreateFolder(job.selectedSystemId!, name)}
                  />
                ) : (
                  <span className="muted">{job.selectedSystemId ? "Loading…" : "unmapped"}</span>
                )}
              </td>
              <td>
                {formatBytes(job.sourceBytes)} → {formatBytes(job.estimatedOutputBytes)}
              </td>
              <td>
                {job.warnings.map((w, i) => (
                  <div key={i} className="warning-line">
                    ⚠ {w}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ActionBar
        status={
          processing ? (
            <span className="inline-status">
              <Spinner />
              {slowProcessing ? "Still working — enqueueing a lot of files takes a moment." : "Starting jobs…"}
            </span>
          ) : (
            <span className="muted">
              {readyCount} of {jobs.length} file{jobs.length === 1 ? "" : "s"} ready to process.
            </span>
          )
        }
      >
        <button type="button" className="button-primary" onClick={handleProcess} disabled={readyCount === 0 || processing}>
          {processing ? "Starting…" : `Process (${readyCount})`}
        </button>
      </ActionBar>
    </div>
  );
}

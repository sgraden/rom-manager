import { useEffect, useState } from "react";
import {
  fetchTools,
  fetchTargets,
  fetchSystems,
  fetchFolderMap,
  setFolderMapEntry,
  createFolder,
  fetchPerformanceConfig,
  setPerformanceConfig,
  type ToolInfo,
  type TargetInfo,
  type SystemDef,
  type FolderMapResult,
  type PerformanceConfig,
} from "../api";

const CREATE_FOLDER_SENTINEL = "__create__";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

function FolderMapEditor({ target, systems }: { target: TargetInfo; systems: SystemDef[] }) {
  const [result, setResult] = useState<FolderMapResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    fetchFolderMap(target.name)
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [target.name]);

  async function handleChange(systemId: string, value: string, defaultFolderName: string) {
    setError(null);
    try {
      const next =
        value === CREATE_FOLDER_SENTINEL
          ? await createFolder(target.name, systemId, defaultFolderName)
          : await setFolderMapEntry(target.name, systemId, value || null);
      setResult(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!result) return <p className="muted">Loading folder map…</p>;

  const sortedSystems = [...systems].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>System</th>
            <th>Folder on {target.name}</th>
          </tr>
        </thead>
        <tbody>
          {sortedSystems.map((system) => (
            <tr key={system.id}>
              <td>{system.name}</td>
              <td>
                <select
                  value={result.folderMap[system.id] ?? ""}
                  onChange={(e) => handleChange(system.id, e.target.value, system.folderAliases[0] ?? system.id)}
                >
                  <option value="">— none —</option>
                  {target.folders.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                  {!result.folderMap[system.id] && (
                    <option value={CREATE_FOLDER_SENTINEL}>+ Create "{system.folderAliases[0] ?? system.id}"</option>
                  )}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.unmatchedFolders.length > 0 && (
        <p className="muted">
          Folders on {target.name} with no system assigned: {result.unmatchedFolders.join(", ")}
        </p>
      )}
    </>
  );
}

function PerformanceSettings() {
  const [config, setConfig] = useState<PerformanceConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPerformanceConfig()
      .then(setConfig)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function handleChange(patch: Partial<Omit<PerformanceConfig, "cpuCoreCount">>) {
    setSaving(true);
    setError(null);
    try {
      setConfig(await setPerformanceConfig(patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!config) return <p className="muted">Loading…</p>;

  const threadsPerJob = Math.max(1, Math.floor(Math.max(1, config.cpuCoreCount - config.reservedCpuCores) / Math.max(1, config.maxConcurrentJobs)));

  return (
    <div className="performance-settings">
      <div className="field-row">
        <label htmlFor="max-concurrent">Concurrent conversions</label>
        <input
          id="max-concurrent"
          type="number"
          min={1}
          max={8}
          value={config.maxConcurrentJobs}
          disabled={saving}
          onChange={(e) => handleChange({ maxConcurrentJobs: Math.max(1, Number(e.target.value) || 1) })}
        />
      </div>
      <div className="field-row">
        <label htmlFor="reserved-cores">Cores reserved for other apps</label>
        <input
          id="reserved-cores"
          type="number"
          min={0}
          max={Math.max(0, config.cpuCoreCount - 1)}
          value={config.reservedCpuCores}
          disabled={saving}
          onChange={(e) => handleChange({ reservedCpuCores: Math.max(0, Number(e.target.value) || 0) })}
        />
      </div>
      <p className="muted">
        {config.cpuCoreCount} cores detected. Each conversion is capped to about {threadsPerJob} thread{threadsPerJob === 1 ? "" : "s"}, so
        running {config.maxConcurrentJobs} at once never uses more than ~{config.cpuCoreCount - config.reservedCpuCores} of{" "}
        {config.cpuCoreCount} cores — the rest stays free for browsing and everything else. Raising "Concurrent conversions" starts more
        queued jobs right away; changing the reserved-cores split only applies to jobs that haven't started yet.
      </p>
    </div>
  );
}

export function SettingsPage() {
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [targets, setTargets] = useState<TargetInfo[] | null>(null);
  const [systems, setSystems] = useState<SystemDef[] | null>(null);
  const [folderMapTarget, setFolderMapTarget] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * `reprobeTools` forces the server to re-run the real tool probes rather than
   * answering from its memoized result — which is the whole point of the Re-check
   * button, since the reason to press it is that you just installed something.
   */
  async function refresh(reprobeTools = false) {
    setLoading(true);
    setError(null);
    try {
      const [toolsRes, targetsRes, systemsRes] = await Promise.all([fetchTools(reprobeTools), fetchTargets(), fetchSystems()]);
      setTools(toolsRes.tools);
      setTargets(targetsRes.targets);
      setSystems(systemsRes.systems);
      if (targetsRes.targets.length > 0 && !folderMapTarget) setFolderMapTarget(targetsRes.targets[0].name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="settings">
      <section>
        <h2>Performance</h2>
        <PerformanceSettings />
      </section>

      <section>
        <div className="section-header">
          <h2>Conversion tools</h2>
          <button onClick={() => refresh(true)} disabled={loading}>
            {loading ? "Checking…" : "Re-check"}
          </button>
        </div>
        {error && <p className="error">Failed to load: {error}</p>}
        {tools && (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Tool</th>
                <th>Version</th>
                <th>Path</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id} className={tool.found ? "" : tool.required ? "row-error" : "row-warn"}>
                  <td>{tool.found ? "✓" : tool.required ? "✗" : "–"}</td>
                  <td>{tool.name}</td>
                  <td>{tool.version ?? "—"}</td>
                  <td className="mono">{tool.path ?? tool.installHint}</td>
                  <td className="muted">{tool.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Destinations</h2>
        <p className="muted">Every mounted volume under /Volumes, plus any extra paths added in config.json.</p>
        {targets && targets.length === 0 && <p>No volumes found under /Volumes.</p>}
        {targets && targets.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>ROM root</th>
                <th>Filesystem</th>
                <th>Free / Total</th>
                <th>Writable</th>
                <th>Folders</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => (
                <tr key={target.path}>
                  <td>{target.name}</td>
                  <td className="mono">{target.romRoot}</td>
                  <td>{target.fsType ?? "—"}</td>
                  <td>
                    {formatBytes(target.freeBytes)} / {formatBytes(target.totalBytes)}
                  </td>
                  <td>{target.writable ? "✓" : "✗"}</td>
                  <td>{target.folders.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {targets && targets.length > 0 && systems && (
        <section>
          <div className="section-header">
            <h2>Folder mapping</h2>
            <select value={folderMapTarget} onChange={(e) => setFolderMapTarget(e.target.value)}>
              {targets.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <p className="muted">
            Folders were auto-matched by name where possible (e.g. "ps1" → PlayStation). Override any of them here — folders are never
            created automatically, only assigned.
          </p>
          {folderMapTarget && (
            <FolderMapEditor target={targets.find((t) => t.name === folderMapTarget)!} systems={systems} />
          )}
        </section>
      )}
    </div>
  );
}

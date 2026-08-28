import { useEffect, useState, useCallback } from "react";
import {
  fetchTargets,
  ingestPath,
  uploadFile,
  browseDir,
  planJobs,
  type TargetInfo,
  type BrowseEntry,
  type PlannedJob,
} from "../api";

interface QueuedSource {
  key: string;
  path: string;
  name: string;
  size: number;
  status: "ready" | "uploading";
  progress?: number;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function DropPage({ onPlanned }: { onPlanned: (targetName: string, jobs: PlannedJob[]) => void }) {
  const [targets, setTargets] = useState<TargetInfo[] | null>(null);
  const [targetName, setTargetName] = useState<string>("");
  const [sources, setSources] = useState<QueuedSource[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const [browserOpen, setBrowserOpen] = useState(false);
  const [browseState, setBrowseState] = useState<{ dir: string; parent: string | null; entries: BrowseEntry[] } | null>(null);

  useEffect(() => {
    fetchTargets()
      .then((r) => {
        setTargets(r.targets);
        if (r.targets.length > 0) setTargetName(r.targets[0].name);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  function addIngested(file: { path: string; name: string; size: number }) {
    setSources((prev) => {
      if (prev.some((s) => s.path === file.path)) return prev;
      return [...prev, { key: file.path, path: file.path, name: file.name, size: file.size, status: "ready" }];
    });
  }

  async function handleAddPath() {
    if (!pathInput.trim()) return;
    setError(null);
    try {
      const file = await ingestPath(pathInput.trim());
      addIngested(file);
      setPathInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleUpload(file: globalThis.File) {
    const key = `upload:${file.name}:${file.size}:${Date.now()}`;
    setSources((prev) => [...prev, { key, path: "", name: file.name, size: file.size, status: "uploading", progress: 0 }]);
    try {
      const result = await uploadFile(file, (sent, total) => {
        setSources((prev) => prev.map((s) => (s.key === key ? { ...s, progress: total ? sent / total : 0 } : s)));
      });
      setSources((prev) =>
        prev.map((s) => (s.key === key ? { key: result.path, path: result.path, name: result.name, size: result.size, status: "ready" } : s)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSources((prev) => prev.filter((s) => s.key !== key));
    }
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    for (const file of Array.from(e.dataTransfer.files)) {
      handleUpload(file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function removeSource(key: string) {
    setSources((prev) => prev.filter((s) => s.key !== key));
  }

  async function openBrowser(dir?: string) {
    setError(null);
    try {
      const result = await browseDir(dir);
      setBrowseState(result);
      setBrowserOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleBuildPlan() {
    if (!targetName || sources.length === 0) return;
    setPlanning(true);
    setError(null);
    try {
      const readyPaths = sources.filter((s) => s.status === "ready").map((s) => s.path);
      const { jobs } = await planJobs(readyPaths, targetName);
      onPlanned(targetName, jobs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  const readyCount = sources.filter((s) => s.status === "ready").length;

  return (
    <div className="drop-page">
      {error && <p className="error">{error}</p>}

      <section>
        <label className="field-label" htmlFor="target-select">
          Destination
        </label>
        <select id="target-select" value={targetName} onChange={(e) => setTargetName(e.target.value)}>
          {targets?.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.fsType ?? "unknown fs"}, {t.freeBytes !== null ? formatBytes(t.freeBytes) : "?"} free)
            </option>
          ))}
        </select>
        {targets && targets.length === 0 && <p className="muted">No destinations found — mount a card or drive under /Volumes.</p>}
      </section>

      <section
        className={dragActive ? "dropzone dropzone-active" : "dropzone"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        <p>Drag and drop ROM files here</p>
        <p className="muted">or</p>
        <label className="file-picker-button">
          Choose files…
          <input
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              for (const file of Array.from(e.target.files ?? [])) handleUpload(file);
              e.target.value = "";
            }}
          />
        </label>
      </section>

      <section>
        <label className="field-label" htmlFor="path-input">
          Add by path (for large files already on disk — avoids copying them)
        </label>
        <div className="inline-form">
          <input
            id="path-input"
            type="text"
            placeholder="/path/to/game.iso"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddPath()}
          />
          <button onClick={handleAddPath}>Add</button>
          <button onClick={() => openBrowser()}>Browse…</button>
        </div>

        {browserOpen && browseState && (
          <div className="file-browser">
            <div className="file-browser-header">
              <span className="mono">{browseState.dir}</span>
              <button onClick={() => setBrowserOpen(false)}>Close</button>
            </div>
            <ul>
              {browseState.parent && (
                <li className="file-browser-row" onClick={() => openBrowser(browseState.parent!)}>
                  ⬆ ..
                </li>
              )}
              {browseState.entries.map((entry) => (
                <li
                  key={entry.path}
                  className="file-browser-row"
                  onClick={() => {
                    if (entry.isDirectory) openBrowser(entry.path);
                    else {
                      addIngested(entry);
                      setBrowserOpen(false);
                    }
                  }}
                >
                  {entry.isDirectory ? "📁" : "📄"} {entry.name}
                  {!entry.isDirectory && <span className="muted"> — {formatBytes(entry.size)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2>Queued ({sources.length})</h2>
        {sources.length === 0 && <p className="muted">Nothing queued yet.</p>}
        {sources.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Size</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.key}>
                  <td>{s.name}</td>
                  <td>{formatBytes(s.size)}</td>
                  <td>{s.status === "uploading" ? `Uploading… ${Math.round((s.progress ?? 0) * 100)}%` : "Ready"}</td>
                  <td>
                    <button onClick={() => removeSource(s.key)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="build-plan-row">
          <button onClick={handleBuildPlan} disabled={readyCount === 0 || !targetName || planning}>
            {planning ? "Building plan…" : `Build Plan (${readyCount})`}
          </button>
        </div>
      </section>
    </div>
  );
}

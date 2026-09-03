import { useEffect, useState } from "react";
import { fetchTargets, ingestPath, browseNative, planJobs, setLastUsedTarget, type TargetInfo, type PlannedJob } from "../api";
import { useSlowFlag } from "../useSlowFlag";
import { ErrorPanel } from "../ErrorPanel";
import { toAppError, type AppError, type RemedyKind } from "../AppError";
import { Spinner } from "../Spinner";
import { ActionBar } from "../ActionBar";
import { formatBytes } from "../format";

interface QueuedSource {
  path: string;
  name: string;
  size: number;
}

/**
 * Picks the files to process.
 *
 * Everything here works from a path, never a copy. Browser drag-and-drop and
 * `<input type="file">` cannot give a page a real filesystem path — they hand over
 * file *contents*, which meant uploading a whole disc image into staging/ just to
 * convert it and delete it again. For multi-gigabyte ROMs that's a pointless write of
 * the entire library. The macOS open panel returns real paths, so the file is read
 * where it already lives.
 */
export function DropPage({
  onPlanned,
  onRemedy,
}: {
  onPlanned: (targetName: string, jobs: PlannedJob[]) => void;
  onRemedy: (kind: RemedyKind) => void;
}) {
  const [targets, setTargets] = useState<TargetInfo[] | null>(null);
  const [targetName, setTargetName] = useState<string>("");
  const [sources, setSources] = useState<QueuedSource[]>([]);
  const [pathInput, setPathInput] = useState("");
  const [showPathInput, setShowPathInput] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [planning, setPlanning] = useState(false);
  const slowPlanning = useSlowFlag(planning);
  const [selecting, setSelecting] = useState(false);

  useEffect(() => {
    fetchTargets()
      .then((r) => {
        setTargets(r.targets);
        // Prefer the destination used last time; it's stored server-side so it survives
        // a reload, and someone with two cards mounted shouldn't re-pick on every visit.
        const remembered = r.targets.find((t) => t.name === r.lastUsed);
        if (remembered) setTargetName(remembered.name);
        else if (r.targets.length > 0) setTargetName(r.targets[0].name);
      })
      .catch((e) => setError(toAppError(e)));
  }, []);

  function addSources(files: Array<{ path: string; name: string; size: number }>) {
    setSources((prev) => {
      const seen = new Set(prev.map((s) => s.path));
      const added = files.filter((f) => !seen.has(f.path));
      return [...prev, ...added];
    });
  }

  async function handleSelectFiles() {
    setError(null);
    setSelecting(true);
    try {
      const { files } = await browseNative();
      addSources(files);
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setSelecting(false);
    }
  }

  async function handleAddPath() {
    if (!pathInput.trim()) return;
    setError(null);
    try {
      addSources([await ingestPath(pathInput.trim())]);
      setPathInput("");
    } catch (e) {
      setError(toAppError(e));
    }
  }

  function removeSource(path: string) {
    setSources((prev) => prev.filter((s) => s.path !== path));
  }

  async function handleBuildPlan() {
    if (!targetName || sources.length === 0) return;
    setPlanning(true);
    setError(null);
    try {
      const { jobs } = await planJobs(
        sources.map((s) => s.path),
        targetName,
      );
      onPlanned(targetName, jobs);
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setPlanning(false);
    }
  }

  return (
    <div className="drop-page">
      {error && (
        <ErrorPanel
          error={error}
          onDismiss={() => setError(null)}
          onAction={(kind) => {
            if (kind === "retry") {
              setError(null);
              void handleBuildPlan();
            } else {
              onRemedy(kind);
            }
          }}
        />
      )}

      <section>
        <label className="field-label" htmlFor="target-select">
          Destination
        </label>
        <select
          id="target-select"
          value={targetName}
          onChange={(e) => {
            setTargetName(e.target.value);
            // Remembered for next time. Best-effort: failing to persist a preference
            // should never interrupt what the user is actually doing.
            void setLastUsedTarget(e.target.value).catch(() => {});
          }}
        >
          {targets?.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.fsType ?? "unknown fs"}, {t.freeBytes !== null ? formatBytes(t.freeBytes) : "?"} free)
            </option>
          ))}
        </select>
        {targets && targets.length === 0 && (
          <p className="muted">No destinations found — mount a card or drive under /Volumes, then reload.</p>
        )}
      </section>

      <section className="picker">
        <button type="button" className="picker-cta" onClick={handleSelectFiles} disabled={selecting}>
          {selecting ? "Waiting for Finder…" : "Select files…"}
        </button>
        <p className="muted picker-note">
          Files are read where they are — nothing is copied until it's converted onto {targetName || "the destination"}.
        </p>

        {!showPathInput && (
          <button type="button" className="link-button" onClick={() => setShowPathInput(true)}>
            or type a path
          </button>
        )}

        {showPathInput && (
          <div className="inline-form path-form">
            <label className="visually-hidden" htmlFor="path-input">
              File path
            </label>
            <input
              id="path-input"
              type="text"
              placeholder="/path/to/game.iso"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddPath()}
              autoFocus
            />
            <button type="button" onClick={handleAddPath} disabled={!pathInput.trim()}>
              Add
            </button>
          </div>
        )}
      </section>

      <section>
        <h2>Selected ({sources.length})</h2>
        {sources.length === 0 && <p className="muted">Nothing selected yet — use Select files… above to pick some ROMs.</p>}
        {sources.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Location</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.path}>
                    <td>{s.name}</td>
                    <td>{formatBytes(s.size)}</td>
                    <td className="mono muted">
                      {/* Reassurance that the file is being read in place, not the point of
                          the row — truncated, with the full path on hover. */}
                      <span className="source-location" title={s.path}>
                        {s.path.slice(0, s.path.length - s.name.length).replace(/\/$/, "")}
                      </span>
                    </td>
                    <td>
                      <button type="button" onClick={() => removeSource(s.path)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ActionBar
        status={
          planning ? (
            <span className="inline-status" aria-live="polite">
              <Spinner />
              {slowPlanning
                ? "Still working — inspecting archived or multi-disc files takes longer."
                : "Detecting systems and checking destinations…"}
            </span>
          ) : (
            <span className="muted" aria-live="polite">
              {sources.length > 0 ? `${sources.length} file${sources.length === 1 ? "" : "s"} selected.` : "Select files to get started."}
            </span>
          )
        }
      >
        <button
          type="button"
          className="button-primary"
          onClick={handleBuildPlan}
          disabled={sources.length === 0 || !targetName || planning}
        >
          {planning ? "Building plan…" : `Build Plan (${sources.length})`}
        </button>
      </ActionBar>
    </div>
  );
}

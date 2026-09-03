import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchTargets,
  fetchLibrary,
  fetchSystems,
  deleteLibraryEntry,
  revealLibraryEntry,
  type TargetInfo,
  type LibraryIndex,
  type LibraryEntry,
  type SystemDef,
} from "../api";
import { Spinner } from "../Spinner";
import { ErrorPanel } from "../ErrorPanel";
import { toAppError, type AppError } from "../AppError";
import { ActionBar } from "../ActionBar";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function SystemGroup({
  folder,
  systemName,
  entries,
  totalBytes,
  onDelete,
  onReveal,
}: {
  folder: string;
  systemName: string | null;
  entries: LibraryEntry[];
  totalBytes: number;
  onDelete: (entry: LibraryEntry) => void;
  onReveal: (entry: LibraryEntry) => void;
}) {
  return (
    <details className="library-group" open={entries.length <= 25}>
      <summary>
        <strong>{systemName ?? folder}</strong>{" "}
        <span className="muted">
          {systemName ? `(${folder}) · ` : ""}
          {entries.length} file{entries.length === 1 ? "" : "s"} · {formatBytes(totalBytes)}
        </span>
        {!systemName && <span className="badge-warn">not mapped to a system</span>}
      </summary>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Added</th>
              <th>DAT match</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.fullPath}>
                <td className="mono">{entry.filename}</td>
                <td>{formatBytes(entry.sizeBytes)}</td>
                <td>{formatDate(entry.modifiedAt)}</td>
                <td className="muted">{entry.record?.datMatch ?? "—"}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => onReveal(entry)}>
                    Reveal
                  </button>
                  <button type="button" className="button-danger" onClick={() => onDelete(entry)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function LibraryPage({ onDropFiles }: { onDropFiles: () => void }) {
  const [targets, setTargets] = useState<TargetInfo[] | null>(null);
  const [targetName, setTargetName] = useState("");
  const [systems, setSystems] = useState<SystemDef[] | null>(null);
  const [index, setIndex] = useState<LibraryIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    Promise.all([fetchTargets(), fetchSystems()])
      .then(([targetsRes, systemsRes]) => {
        setTargets(targetsRes.targets);
        setSystems(systemsRes.systems);
        if (targetsRes.targets.length > 0) setTargetName(targetsRes.targets[0].name);
      })
      .catch((e) => setError(toAppError(e)));
  }, []);

  const load = useCallback(async (name: string) => {
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      setIndex(await fetchLibrary(name));
    } catch (e) {
      setIndex(null);
      setError(toAppError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(targetName);
  }, [targetName, load]);

  const systemNameById = useMemo(() => new Map((systems ?? []).map((s) => [s.id, s.name] as const)), [systems]);

  async function handleDelete(entry: LibraryEntry) {
    // Naming the file matters here — this permanently removes it from the card.
    const confirmed = window.confirm(
      `Delete "${entry.filename}" from ${targetName}?\n\nThis permanently removes ${formatBytes(entry.sizeBytes)} from the card and can't be undone.`,
    );
    if (!confirmed) return;

    try {
      await deleteLibraryEntry(targetName, entry.folder, entry.filename);
      await load(targetName);
    } catch (e) {
      setError(toAppError(e));
    }
  }

  async function handleReveal(entry: LibraryEntry) {
    try {
      await revealLibraryEntry(targetName, entry.folder, entry.filename);
    } catch (e) {
      setError(toAppError(e));
    }
  }

  const filteredGroups = useMemo(() => {
    if (!index) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return index.groups;
    return index.groups
      .map((group) => ({ ...group, entries: group.entries.filter((e) => e.filename.toLowerCase().includes(needle)) }))
      .filter((group) => group.entries.length > 0);
  }, [index, search]);

  const matchCount = filteredGroups.reduce((sum, g) => sum + g.entries.length, 0);

  return (
    <div className="library-page">
      {error && (
        <ErrorPanel
          error={error}
          onDismiss={() => setError(null)}
          onAction={(kind) => {
            if (kind === "retry") {
              setError(null);
              void load(targetName);
            }
          }}
        />
      )}

      <section>
        <label className="field-label" htmlFor="library-target">
          Destination
        </label>
        <div className="inline-form">
          <select id="library-target" value={targetName} onChange={(e) => setTargetName(e.target.value)}>
            {targets?.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => load(targetName)} disabled={loading || !targetName}>
            {loading ? "Scanning…" : "Rescan"}
          </button>
        </div>
        {targets && targets.length === 0 && (
          <p className="muted">No destinations found — mount a card or drive under /Volumes, then rescan.</p>
        )}
      </section>

      {loading && !index && (
        <p className="inline-status">
          <Spinner />
          Reading {targetName}…
        </p>
      )}

      {index && (
        <>
          <p className="library-summary">
            <strong>{index.fileCount}</strong> file{index.fileCount === 1 ? "" : "s"} · {formatBytes(index.totalBytes)} used ·{" "}
            {formatBytes(index.freeBytes)} free
          </p>

          <section>
            <label className="field-label" htmlFor="library-search">
              Search
            </label>
            <input
              id="library-search"
              type="search"
              placeholder="Filter by filename…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search.trim() && (
              <p className="muted">
                {matchCount} match{matchCount === 1 ? "" : "es"}.
              </p>
            )}
          </section>

          {index.fileCount === 0 && (
            <p className="muted">
              Nothing on {targetName} yet — add some games from the Drop tab and they'll show up here.
            </p>
          )}

          {filteredGroups.map((group) => (
            <SystemGroup
              key={group.folder}
              folder={group.folder}
              systemName={group.systemId ? (systemNameById.get(group.systemId) ?? group.systemId) : null}
              entries={group.entries}
              totalBytes={group.totalBytes}
              onDelete={handleDelete}
              onReveal={handleReveal}
            />
          ))}
        </>
      )}

      <ActionBar status={null}>
        <button type="button" className="button-primary" onClick={onDropFiles}>
          Add more games
        </button>
      </ActionBar>
    </div>
  );
}

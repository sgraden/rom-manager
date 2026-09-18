import { useEffect, useMemo, useState } from "react";
import {
  fetchSystems,
  planJobs,
  submitJobs,
  createFolder,
  fetchDuplicateMatches,
  fetchPerformanceConfig,
  setPerformanceConfig,
  type SystemDef,
  type PlannedJob,
  type ConvertAction,
  type PlanOverride,
  type DuplicateMatch,
  type WarningLevel,
} from "../api";
import { useSlowFlag } from "../useSlowFlag";
import { ErrorPanel } from "../ErrorPanel";
import { toAppError, type AppError, type RemedyKind } from "../AppError";
import { Spinner } from "../Spinner";
import { ActionBar } from "../ActionBar";
import { formatBytes, formatDate } from "../format";

const ACTIONS: ConvertAction[] = ["chd-cd", "chd-dvd", "rvz", "keep-zip", "copy"];

// Mirrors server/library/discGroup.ts's DISC_TOKEN — duplicated because this needs to run
// before the server has confirmed a group (see propagationSourcePaths below), not after.
const DISC_TOKEN = /\s*[[(]\s*(?:disc|disk|cd)\s*(\d+)\s*[)\]]/i;

/** The filename with its disc-number token stripped — the shared identity across a set's discs, independent of whether the server has agreed on a system for them yet. */
function discBaseName(filename: string): string | null {
  const match = filename.match(DISC_TOKEN);
  return match ? filename.replace(DISC_TOKEN, "").trim() : null;
}

const ACTION_EXPLANATION: Record<ConvertAction, string> = {
  "chd-cd": "CD-based discs (PS1, Saturn, Sega CD, Dreamcast, PC Engine CD, 3DO) — chdman's CD mode understands CD track/cue structure.",
  "chd-dvd": "DVD-based discs (PS2, PSP) — same CHD format, but chdman's DVD mode expects flat sector data with no CD track structure.",
  rvz: "GameCube/Wii, via DolphinTool. Falls back to a plain copy if DolphinTool isn't installed.",
  "keep-zip": "Cartridge ROMs — zipped (or re-zipped) since most emulator cores read zip archives directly.",
  copy: "Computer disk images, arcade sets, and Nintendo 3DS — copied as-is; recompressing would break the structure the emulator expects (or, for 3DS, isn't supported by any common emulator).",
};

/**
 * The destination shown as "folder/filename" rather than its full absolute path.
 * The prefix is identical on every row and already stated in the banner above the
 * table, so showing it in full only crowds out the columns that differ. The whole
 * path stays available as a tooltip.
 */
function shortDestination(folder: string, filename: string): string {
  return `${folder.split("/").filter(Boolean).pop() ?? folder}/${filename}`;
}

/**
 * How the duplicate was identified. Surfaced verbatim next to the choice, because
 * "identical contents" and "similar filename" deserve very different confidence
 * before someone overwrites a file.
 */
/**
 * Warnings are not equal: "low-confidence match" is worth a glance, "not enough free
 * space" means the job cannot run. Rendering both as an identical "⚠" made the row
 * impossible to triage.
 */
const WARNING_ICON: Record<WarningLevel, string> = { blocker: "⛔", warning: "⚠", info: "ⓘ" };

const TIER_LABEL: Record<DuplicateMatch["tier"], string> = {
  exact: "identical contents",
  likely: "same game (DAT match)",
  name: "matching filename",
};

/**
 * The already-on-card notice and its Skip/Replace choice. Skip is the default for
 * every duplicate — the safe option is the one that happens if the user does nothing.
 */
function DuplicateCell({
  match,
  decision,
  estimatedOutputBytes,
  onDecide,
}: {
  match: DuplicateMatch;
  decision: "skip" | "replace";
  estimatedOutputBytes: number | null;
  onDecide: (decision: "skip" | "replace") => void;
}) {
  const existingBytes = match.entry.sizeBytes;
  const delta = estimatedOutputBytes !== null ? existingBytes - estimatedOutputBytes : null;

  return (
    <div className="duplicate-cell">
      <div className="duplicate-headline">⟳ Already on card</div>
      <div className="muted">
        {match.entry.filename} · {formatBytes(existingBytes)} · added {formatDate(match.entry.modifiedAt)}
      </div>
      <div className="muted">matched by: {TIER_LABEL[match.tier]}</div>
      {delta !== null && delta !== 0 && (
        <div className="muted">
          replacing {formatBytes(existingBytes)} with ~{formatBytes(estimatedOutputBytes)} (
          {delta > 0 ? `frees ${formatBytes(delta)}` : `uses ${formatBytes(-delta)} more`})
        </div>
      )}
      <div className="duplicate-actions">
        <button type="button" className={decision === "skip" ? "toggle-active" : ""} onClick={() => onDecide("skip")}>
          Skip
        </button>
        <button type="button" className={decision === "replace" ? "toggle-active" : ""} onClick={() => onDecide("replace")}>
          Replace
        </button>
      </div>
    </div>
  );
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
  onRemedy,
}: {
  targetName: string;
  initialJobs: PlannedJob[];
  onProcessed: () => void;
  onRemedy: (kind: RemedyKind) => void;
}) {
  const [systems, setSystems] = useState<SystemDef[] | null>(null);
  const [jobs, setJobs] = useState<PlannedJob[]>(initialJobs);
  const [overrides, setOverrides] = useState<Record<string, PlanOverride>>({});
  const [busy, setBusy] = useState(false);
  const slowBusy = useSlowFlag(busy);
  const [processing, setProcessing] = useState(false);
  const slowProcessing = useSlowFlag(processing);
  const [error, setError] = useState<AppError | null>(null);
  const [matches, setMatches] = useState<Record<string, DuplicateMatch | null>>({});
  /** Skip is the default for every duplicate — the safe choice is the one that needs no click. */
  const [decisions, setDecisions] = useState<Record<string, "skip" | "replace">>({});
  /** null while loading — the checkbox renders disabled rather than flashing an initial state that might not be the real one. */
  const [groupMultiDiscFolders, setGroupMultiDiscFolders] = useState<boolean | null>(null);

  useEffect(() => {
    setJobs(initialJobs);
    setOverrides({});
    setMatches({});
    setDecisions({});
  }, [initialJobs]);

  /**
   * Checks what's already on the card. Runs alongside the plan rather than blocking
   * it — a duplicate is worth knowing about, but not worth delaying the whole table
   * for, and a failure here should leave the plan perfectly usable.
   */
  useEffect(() => {
    const sourcePaths = jobs.map((j) => j.sourcePath);
    if (sourcePaths.length === 0 || !targetName) return;

    let cancelled = false;
    fetchDuplicateMatches(sourcePaths, targetName, overrides)
      .then(({ matches: results }) => {
        if (cancelled) return;
        const next: Record<string, DuplicateMatch | null> = {};
        for (const result of results) next[result.sourcePath] = result.match;
        setMatches(next);
        setDecisions((prev) => {
          const merged = { ...prev };
          for (const result of results) {
            if (result.match && !merged[result.sourcePath]) merged[result.sourcePath] = "skip";
            if (!result.match) delete merged[result.sourcePath];
          }
          return merged;
        });
      })
      .catch(() => {
        // Non-fatal: the plan is still correct, the user just doesn't get the warning.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, targetName]);

  function decideDuplicate(sourcePath: string, decision: "skip" | "replace") {
    setDecisions((prev) => ({ ...prev, [sourcePath]: decision }));
  }

  function decideAll(decision: "skip" | "replace") {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const job of jobs) if (matches[job.sourcePath]) next[job.sourcePath] = decision;
      return next;
    });
  }

  useEffect(() => {
    fetchSystems()
      .then((r) => setSystems(r.systems))
      .catch((e) => setError(toAppError(e)));
  }, []);

  useEffect(() => {
    fetchPerformanceConfig()
      .then((c) => setGroupMultiDiscFolders(c.groupMultiDiscFolders))
      .catch((e) => setError(toAppError(e)));
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
      setError(toAppError(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyOverride(sourcePath: string, next: PlanOverride) {
    const job = jobs.find((j) => j.sourcePath === sourcePath);
    // A system/action correction for one disc of a set almost always applies to every disc
    // in it — they're the same game, and a second or third disc's own detection is often
    // weaker or absent (title screens, straight audio tracks) even when the set as a whole
    // is obvious from disc 1. Matched by filename pattern rather than the server-confirmed
    // discGroupKey: that key only exists once every disc already agrees on a system, which
    // is exactly not yet true the moment disc 1 gets corrected and disc 2 still shows the old,
    // wrong guess. Only System and Action route through here — the separate Skip/Replace
    // duplicate decision is deliberately left per-file.
    const baseName = discBaseName(job?.sourceName ?? "");
    const groupSourcePaths = baseName ? jobs.filter((j) => discBaseName(j.sourceName) === baseName).map((j) => j.sourcePath) : [sourcePath];

    const nextOverrides = { ...overrides };
    for (const path of groupSourcePaths) {
      nextOverrides[path] = { ...overrides[path], ...next };
    }
    setOverrides(nextOverrides);
    await replan(nextOverrides, groupSourcePaths);
  }

  async function handleToggleGrouping(next: boolean) {
    setError(null);
    const previous = groupMultiDiscFolders;
    setGroupMultiDiscFolders(next);
    try {
      await setPerformanceConfig({ groupMultiDiscFolders: next });
      await replan(overrides, jobs.map((j) => j.sourcePath));
    } catch (e) {
      setGroupMultiDiscFolders(previous);
      setError(toAppError(e));
    }
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
      setError(toAppError(e));
    }
  }

  async function handleProcess() {
    setProcessing(true);
    setError(null);
    try {
      // Skipped duplicates are simply not submitted, and a Replace decision travels
      // with its source as an override so the server re-derives it the same way it
      // re-derives everything else about the job.
      const sourcePaths = jobs.filter((j) => decisions[j.sourcePath] !== "skip").map((j) => j.sourcePath);
      if (sourcePaths.length === 0) {
        setError({
          message: "Every file is set to skip, so there's nothing to process.",
          remedy: { text: "Choose Replace on at least one of the duplicates above, or go back and add different files." },
        });
        return;
      }

      const withReplace: Record<string, PlanOverride> = { ...overrides };
      for (const sourcePath of sourcePaths) {
        if (decisions[sourcePath] === "replace") {
          withReplace[sourcePath] = { ...withReplace[sourcePath], replace: true };
        }
      }

      const { results } = await submitJobs(sourcePaths, targetName, withReplace);
      const failures = results.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok);
      if (failures.length > 0) {
        // Surface the first failure with its remedy; the rest are listed as the cause,
        // since they're usually the same problem repeated across files.
        const primary = toAppError(new Error(failures[0].error));
        setError({
          ...primary,
          message: failures.length === 1 ? primary.message : `${primary.message} (${failures.length} files affected)`,
          cause: failures.map((f) => `${f.sourcePath}: ${f.error}`).join("\n"),
        });
        return;
      }
      onProcessed();
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setProcessing(false);
    }
  }

  /**
   * Clusters a multi-disc set's rows together, ordered by disc number, instead of leaving
   * them scattered wherever they happened to land in `jobs`. A set is placed at the position
   * of whichever of its discs appears first, so adding more files doesn't reshuffle rows
   * that were already visible.
   */
  const displayJobs = useMemo(() => {
    const seenGroups = new Set<string>();
    const result: PlannedJob[] = [];
    for (const job of jobs) {
      if (job.discGroupKey == null) {
        result.push(job);
        continue;
      }
      if (seenGroups.has(job.discGroupKey)) continue;
      seenGroups.add(job.discGroupKey);
      const members = jobs.filter((j) => j.discGroupKey === job.discGroupKey).sort((a, b) => (a.discGroupIndex ?? 0) - (b.discGroupIndex ?? 0));
      result.push(...members);
    }
    return result;
  }, [jobs]);

  if (jobs.length === 0) {
    return (
      <div className="review-page">
        <p className="muted">Nothing to review yet — select some ROMs on the Drop tab and build a plan first.</p>
      </div>
    );
  }

  const plannable = jobs.filter((j) => j.selectedSystemId && j.action && j.destinationFolder);
  const skippedCount = jobs.filter((j) => decisions[j.sourcePath] === "skip").length;
  const readyCount = plannable.filter((j) => decisions[j.sourcePath] !== "skip").length;
  const duplicateCount = jobs.filter((j) => matches[j.sourcePath]).length;
  const hasDiscGroups = jobs.some((j) => j.discGroupKey != null);

  return (
    <div className="review-page">
      <p className="preview-banner">
        Writing to <strong>{targetName}</strong>. Files are converted and copied when you click Process — nothing happens until then.
      </p>
      {hasDiscGroups && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={groupMultiDiscFolders ?? true}
            disabled={groupMultiDiscFolders === null || busy}
            onChange={(e) => handleToggleGrouping(e.target.checked)}
          />
          Group multi-disc games into their own folder (with the .m3u playlist inside)
        </label>
      )}
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
      {error && (
        <ErrorPanel
          error={error}
          onDismiss={() => setError(null)}
          onAction={(kind) => {
            if (kind === "retry") {
              setError(null);
              void replan(overrides, jobs.map((j) => j.sourcePath));
            } else {
              onRemedy(kind);
            }
          }}
        />
      )}
      {duplicateCount > 0 && (
        <div className="duplicate-bulk">
          <span>
            {duplicateCount} of these {duplicateCount === 1 ? "is" : "are"} already on {targetName}.
          </span>
          <button type="button" onClick={() => decideAll("skip")}>
            Skip all duplicates
          </button>
          <button type="button" onClick={() => decideAll("replace")}>
            Replace all duplicates
          </button>
        </div>
      )}
      {busy && (
        <p className="inline-status" aria-live="polite">
          <Spinner />
          {slowBusy ? "Still working — re-checking the destination takes a moment." : "Re-planning…"}
        </p>
      )}

      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Status</th>
            <th>Kind</th>
            <th>System</th>
            <th>Action</th>
            <th>Destination</th>
            <th title="A rough guide based on typical results for this action, not a guarantee — CHD/RVZ compression depends heavily on how compressible the actual disc content is, and can end up larger than the original for content that's already compressed (FMV-heavy compilations especially).">
              Size before → est. after
            </th>
            <th>Warnings</th>
          </tr>
        </thead>
        <tbody>
          {displayJobs.map((job, i) => {
            const isGrouped = job.discGroupKey != null;
            const isGroupFirst = isGrouped && displayJobs[i - 1]?.discGroupKey !== job.discGroupKey;
            const isGroupLast = isGrouped && displayJobs[i + 1]?.discGroupKey !== job.discGroupKey;
            return (
              <tr
                key={job.sourcePath}
                className={[
                  decisions[job.sourcePath] === "skip" ? "plan-row-skipped" : "",
                  job.warnings.some((w) => w.level === "blocker")
                    ? "plan-row-blocked"
                    : job.warnings.some((w) => w.level === "warning")
                      ? "plan-row-warn"
                      : "",
                  isGroupFirst ? "disc-group-first" : "",
                  isGroupLast ? "disc-group-last" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <td data-label="File" className="mono">
                  {job.sourceName}
                  {job.discGroupTotal !== null && (
                    <span className="disc-group-badge" title="Part of a multi-disc set">
                      Disc {job.discGroupIndex}/{job.discGroupTotal}
                    </span>
                  )}
                </td>
              <td data-label="Status">
                {matches[job.sourcePath] ? (
                  <DuplicateCell
                    match={matches[job.sourcePath]!}
                    decision={decisions[job.sourcePath] ?? "skip"}
                    estimatedOutputBytes={job.estimatedOutputBytes}
                    onDecide={(decision) => decideDuplicate(job.sourcePath, decision)}
                  />
                ) : (
                  <span className="muted">New</span>
                )}
              </td>
              <td data-label="Kind">{job.sourceKind}</td>
              <td data-label="System">
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
                  <span
                    className={job.candidates[0].confidence >= 0.6 ? "confidence-badge" : "confidence-badge confidence-low"}
                    title={job.candidates[0].evidence}
                  >
                    {Math.round(job.candidates[0].confidence * 100)}% confident
                  </span>
                )}
              </td>
              <td data-label="Action">
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
              <td data-label="Destination" className="mono">
                {job.destinationFolder ? (
                  <span title={`${job.destinationFolder}/${job.destinationFilename}`}>
                    {shortDestination(job.destinationFolder, job.destinationFilename ?? "")}
                  </span>
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
              <td data-label="Size">
                {formatBytes(job.sourceBytes)} → {formatBytes(job.estimatedOutputBytes)}
              </td>
              <td data-label="Warnings">
                {job.warnings.map((w, wi) => (
                  <div key={wi} className={`warning-line warning-${w.level}`}>
                    {WARNING_ICON[w.level]} {w.text}
                  </div>
                ))}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      <ActionBar
        status={
          processing ? (
            <span className="inline-status">
              <Spinner />
              {slowProcessing ? "Still working — enqueueing a lot of files takes a moment." : "Starting jobs…"}
            </span>
          ) : (
            <span className="muted" aria-live="polite">
              {readyCount} of {jobs.length} file{jobs.length === 1 ? "" : "s"} ready to process
              {skippedCount > 0 ? `, ${skippedCount} skipped as already on the card` : ""}.
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

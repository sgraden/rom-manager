import { useEffect, useState } from "react";
import { subscribeJobEvents, cancelJob, clearCompletedJobs, retryJob, type JobInfo } from "../api";
import { ErrorPanel } from "../ErrorPanel";
import { toAppError } from "../AppError";
import { formatBytes, formatDuration } from "../format";
import { ActionBar } from "../ActionBar";

/** "folder/filename" — the absolute prefix is the same for every row and just crowds the table. */
function shortDestination(folder: string, filename: string): string {
  return `${folder.split("/").filter(Boolean).pop() ?? folder}/${filename}`;
}

const STATE_LABEL: Record<JobInfo["state"], string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function SizeCell({ job }: { job: JobInfo }) {
  if (job.state !== "done" || job.resultBytes === null) {
    return <>{formatBytes(job.sourceBytes)}</>;
  }
  const reduction = job.sourceBytes > 0 ? Math.round((1 - job.resultBytes / job.sourceBytes) * 100) : 0;
  return (
    <>
      {formatBytes(job.sourceBytes)} → {formatBytes(job.resultBytes)}
      {reduction !== 0 && <div className="muted">{reduction > 0 ? `${reduction}% smaller` : `${-reduction}% larger`}</div>}
    </>
  );
}

function JobRow({
  job,
  now,
  onCancel,
  onRetry,
}: {
  job: JobInfo;
  /** Passed in rather than read per row, so every row ticks off one shared timer. */
  now: number;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <tr className={job.state === "failed" ? "row-error" : ""}>
      <td data-label="File" className="mono">{job.sourceName}</td>
      <td data-label="Action">{job.action}</td>
      <td data-label="Destination" className="mono">
        <span title={`${job.destinationFolder}/${job.destinationFilename}`}>
          {shortDestination(job.destinationFolder, job.destinationFilename)}
        </span>
      </td>
      <td data-label="Status">
        <div className="job-state">
          <span>{STATE_LABEL[job.state]}</span>
          {job.state === "running" && (
            <span className="muted">
              {" "}
              — {job.phase} {Math.round(job.percent)}%
              {job.startedAt && <> · {formatDuration(now - new Date(job.startedAt).getTime())} elapsed</>}
            </span>
          )}
        </div>
        {(job.state === "running" || job.state === "queued") && (
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ transform: `scaleX(${(job.state === "running" ? job.percent : 0) / 100})` }}
            />
          </div>
        )}
        {job.error && (
          <ErrorPanel
            error={toAppError(new Error(job.error))}
            onAction={(kind) => {
              // Every remedy offered on a failed job comes down to trying it again once
              // the underlying cause is dealt with; navigation remedies aren't reachable
              // from a row, so retry is the only action wired here.
              if (kind === "retry" || kind === "recheck-tools") onRetry(job.id);
            }}
          />
        )}
        {job.m3uWritten && <div className="muted">Playlist written: {job.m3uWritten}</div>}
        {job.datMatch && <div className="muted">DAT match: {job.datMatch}</div>}
        {job.replaced && <div className="muted">Replaced the previous {job.replaced}</div>}
      </td>
      <td data-label="Size">
        <SizeCell job={job} />
      </td>
      <td data-label="">
        {(job.state === "queued" || job.state === "running") && <button onClick={() => onCancel(job.id)}>Cancel</button>}
        {(job.state === "failed" || job.state === "cancelled") && (
          <button type="button" onClick={() => onRetry(job.id)}>
            Retry
          </button>
        )}
      </td>
    </tr>
  );
}

export function QueuePage({ onDropMore }: { onDropMore: () => void }) {
  const [jobs, setJobs] = useState<Map<string, JobInfo>>(new Map());
  const [order, setOrder] = useState<string[]>([]);
  const [retryError, setRetryError] = useState<ReturnType<typeof toAppError> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One timer for the whole page rather than one per row. Only ticks while something is
  // actually running, so an idle queue costs nothing.
  const hasActive = [...jobs.values()].some((j) => j.state === "running");
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActive]);

  useEffect(() => {
    const unsubscribe = subscribeJobEvents((event) => {
      if (event.type === "snapshot") {
        const map = new Map(event.jobs.map((j) => [j.id, j] as const));
        setJobs(map);
        setOrder(event.jobs.map((j) => j.id));
      } else {
        setJobs((prev) => {
          const next = new Map(prev);
          next.set(event.job.id, event.job);
          return next;
        });
        setOrder((prev) => (prev.includes(event.job.id) ? prev : [...prev, event.job.id]));
      }
    });
    return unsubscribe;
  }, []);

  async function handleCancel(id: string) {
    try {
      await cancelJob(id);
    } catch {
      // the job row will reflect the real state on the next SSE update regardless
    }
  }

  async function handleRetry(id: string) {
    setRetryError(null);
    try {
      await retryJob(id);
    } catch (e) {
      setRetryError(toAppError(e));
    }
  }

  async function handleClearFinished() {
    try {
      await clearCompletedJobs();
      // The server no longer knows about these jobs, and it only pushes updates for
      // ones that change — so drop them here rather than waiting for an event that
      // will never arrive.
      setJobs((prev) => {
        const next = new Map(prev);
        for (const [id, job] of prev) {
          if (job.state !== "queued" && job.state !== "running") next.delete(id);
        }
        return next;
      });
      setOrder((prev) => prev.filter((id) => {
        const state = jobs.get(id)?.state;
        return state === "queued" || state === "running";
      }));
    } catch {
      // nothing destructive happened server-side if this failed; the list stays as-is
    }
  }

  const jobList = order.map((id) => jobs.get(id)).filter((j): j is JobInfo => !!j);
  const activeCount = jobList.filter((j) => j.state === "queued" || j.state === "running").length;
  const doneCount = jobList.filter((j) => j.state === "done").length;
  const failedCount = jobList.filter((j) => j.state === "failed").length;
  const finishedCount = jobList.filter((j) => j.state !== "queued" && j.state !== "running").length;

  if (jobList.length === 0) {
    return (
      <div className="queue-page">
        <p className="muted">
          Nothing has been processed yet. Pick some ROMs on the Drop tab and build a plan — converted files show up here with live
          progress.
        </p>
        <ActionBar status={null}>
          <button type="button" className="button-primary" onClick={onDropMore}>
            Go to Drop
          </button>
        </ActionBar>
      </div>
    );
  }

  // Bytes written so far vs. the whole batch, so a long run has a single honest number
  // rather than only per-row percentages.
  const totalJobs = jobList.length;
  const finishedJobs = jobList.filter((j) => j.state !== "queued" && j.state !== "running").length;
  const runningPercent = jobList.filter((j) => j.state === "running").reduce((sum, j) => sum + j.percent / 100, 0);
  const overallPercent = totalJobs > 0 ? Math.min(100, ((finishedJobs + runningPercent) / totalJobs) * 100) : 0;
  const writtenBytes = jobList.reduce((sum, j) => sum + (j.resultBytes ?? 0), 0);

  const firstStart = jobList.reduce<number | null>((earliest, j) => {
    if (!j.startedAt) return earliest;
    const started = new Date(j.startedAt).getTime();
    return earliest === null || started < earliest ? started : earliest;
  }, null);
  // Only offered once there's enough progress for the extrapolation to mean anything.
  const elapsed = firstStart !== null ? now - firstStart : 0;
  const estimatedRemaining =
    activeCount > 0 && overallPercent > 10 && elapsed > 0 ? (elapsed / overallPercent) * (100 - overallPercent) : null;

  return (
    <div className="queue-page">
      {retryError && <ErrorPanel error={retryError} onDismiss={() => setRetryError(null)} />}

      <div className="queue-overall" aria-live="polite">
        <div className="queue-overall-line">
          <strong>
            {finishedJobs} of {totalJobs} done
          </strong>
          {activeCount > 0 && <span className="muted"> · {activeCount} in progress</span>}
          {writtenBytes > 0 && <span className="muted"> · {formatBytes(writtenBytes)} written</span>}
          {estimatedRemaining !== null && <span className="muted"> · ~{formatDuration(estimatedRemaining)} remaining</span>}
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ transform: `scaleX(${overallPercent / 100})` }} />
        </div>
      </div>
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Action</th>
            <th>Destination</th>
            <th>Status</th>
            <th>Size before → after</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobList.map((job) => (
            <JobRow key={job.id} job={job} now={now} onCancel={handleCancel} onRetry={handleRetry} />
          ))}
        </tbody>
      </table>
      </div>

      <ActionBar
        status={
          <span className="muted" aria-live="polite">
            {activeCount > 0 ? `${activeCount} in progress. ` : ""}
            {doneCount} done{failedCount > 0 ? `, ${failedCount} failed` : ""}.
          </span>
        }
      >
        {finishedCount > 0 && (
          <button type="button" onClick={handleClearFinished}>
            Clear finished ({finishedCount})
          </button>
        )}
        <button type="button" className="button-primary" onClick={onDropMore}>
          Drop more files
        </button>
      </ActionBar>
    </div>
  );
}

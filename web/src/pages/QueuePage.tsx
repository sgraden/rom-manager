import { useEffect, useState } from "react";
import { subscribeJobEvents, cancelJob, clearCompletedJobs, type JobInfo } from "../api";
import { ActionBar } from "../ActionBar";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
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

function JobRow({ job, onCancel }: { job: JobInfo; onCancel: (id: string) => void }) {
  return (
    <tr className={job.state === "failed" ? "row-error" : ""}>
      <td className="mono">{job.sourceName}</td>
      <td>{job.action}</td>
      <td className="mono">
        {job.destinationFolder}/{job.destinationFilename}
      </td>
      <td>
        <div className="job-state">
          <span>{STATE_LABEL[job.state]}</span>
          {job.state === "running" && <span className="muted"> — {job.phase} {Math.round(job.percent)}%</span>}
        </div>
        {(job.state === "running" || job.state === "queued") && (
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{ transform: `scaleX(${(job.state === "running" ? job.percent : 0) / 100})` }}
            />
          </div>
        )}
        {job.error && <div className="warning-line">⚠ {job.error}</div>}
        {job.m3uWritten && <div className="muted">Playlist written: {job.m3uWritten}</div>}
        {job.datMatch && <div className="muted">DAT match: {job.datMatch}</div>}
      </td>
      <td>
        <SizeCell job={job} />
      </td>
      <td>
        {(job.state === "queued" || job.state === "running") && <button onClick={() => onCancel(job.id)}>Cancel</button>}
      </td>
    </tr>
  );
}

export function QueuePage({ onDropMore }: { onDropMore: () => void }) {
  const [jobs, setJobs] = useState<Map<string, JobInfo>>(new Map());
  const [order, setOrder] = useState<string[]>([]);

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
        <p className="muted">No jobs yet — add files on the Drop tab and build a plan to get started.</p>
        <ActionBar status={null}>
          <button type="button" className="button-primary" onClick={onDropMore}>
            Go to Drop
          </button>
        </ActionBar>
      </div>
    );
  }

  return (
    <div className="queue-page">
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
            <JobRow key={job.id} job={job} onCancel={handleCancel} />
          ))}
        </tbody>
      </table>

      <ActionBar
        status={
          <span className="muted">
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

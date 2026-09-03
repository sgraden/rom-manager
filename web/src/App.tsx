import { useState } from "react";
import { SettingsPage } from "./pages/SettingsPage";
import { DropPage } from "./pages/DropPage";
import { ReviewPage } from "./pages/ReviewPage";
import { QueuePage } from "./pages/QueuePage";
import { Stepper, type StepId } from "./Stepper";
import type { PlannedJob } from "./api";

type Tab = StepId | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("drop");
  const [plan, setPlan] = useState<{ targetName: string; jobs: PlannedJob[] }>({ targetName: "", jobs: [] });
  const [hasProcessed, setHasProcessed] = useState(false);

  function handlePlanned(targetName: string, jobs: PlannedJob[]) {
    setPlan({ targetName, jobs });
    setTab("review");
  }

  function handleProcessed() {
    setHasProcessed(true);
    setTab("queue");
  }

  const reached: Record<StepId, boolean> = {
    drop: true,
    review: plan.jobs.length > 0,
    queue: hasProcessed,
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>ROM Manager</h1>
        <Stepper current={tab === "settings" ? null : tab} reached={reached} onSelect={setTab} />
        <button type="button" className={tab === "settings" ? "settings-link active" : "settings-link"} onClick={() => setTab("settings")}>
          ⚙️ Settings
        </button>
      </header>
      <main className="app-main">
        {tab === "drop" && <DropPage onPlanned={handlePlanned} />}
        {tab === "review" && <ReviewPage targetName={plan.targetName} initialJobs={plan.jobs} onProcessed={handleProcessed} />}
        {tab === "queue" && <QueuePage onDropMore={() => setTab("drop")} />}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

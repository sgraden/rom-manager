import { useState } from "react";
import { SettingsPage } from "./pages/SettingsPage";
import { DropPage } from "./pages/DropPage";
import { ReviewPage } from "./pages/ReviewPage";
import { QueuePage } from "./pages/QueuePage";
import { LibraryPage } from "./pages/LibraryPage";
import { Stepper, type StepId } from "./Stepper";
import type { PlannedJob } from "./api";
import type { RemedyKind } from "./AppError";

type Tab = StepId | "library" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("drop");
  const [plan, setPlan] = useState<{ targetName: string; jobs: PlannedJob[] }>({ targetName: "", jobs: [] });
  const [hasProcessed, setHasProcessed] = useState(false);

  function handlePlanned(targetName: string, jobs: PlannedJob[]) {
    setPlan({ targetName, jobs });
    setTab("review");
  }

  /**
   * Carries out the in-app remedies offered by ErrorPanel that only this component can
   * do — the ones that mean "take me where I can fix this". Page-local remedies (retry,
   * re-check tools) are handled by the page that raised the error.
   */
  function handleRemedy(kind: RemedyKind) {
    if (kind === "open-settings") setTab("settings");
    if (kind === "open-library") setTab("library");
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
        <Stepper current={tab === "settings" || tab === "library" ? null : tab} reached={reached} onSelect={setTab} />
        <nav className="header-links">
          <button type="button" className={tab === "library" ? "settings-link active" : "settings-link"} onClick={() => setTab("library")}>
            🗂 Library
          </button>
          <button type="button" className={tab === "settings" ? "settings-link active" : "settings-link"} onClick={() => setTab("settings")}>
            ⚙️ Settings
          </button>
        </nav>
      </header>
      <main className="app-main">
        {tab === "drop" && <DropPage onPlanned={handlePlanned} onRemedy={handleRemedy} />}
        {tab === "review" && (
          <ReviewPage targetName={plan.targetName} initialJobs={plan.jobs} onProcessed={handleProcessed} onRemedy={handleRemedy} />
        )}
        {tab === "queue" && <QueuePage onDropMore={() => setTab("drop")} />}
        {tab === "library" && <LibraryPage onDropFiles={() => setTab("drop")} />}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

import { useState } from "react";
import { SettingsPage } from "./pages/SettingsPage";
import { DropPage } from "./pages/DropPage";
import { ReviewPage } from "./pages/ReviewPage";
import { QueuePage } from "./pages/QueuePage";
import type { PlannedJob } from "./api";

type Tab = "drop" | "review" | "queue" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "drop", label: "Drop" },
  { id: "review", label: "Review" },
  { id: "queue", label: "Queue" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("drop");
  const [plan, setPlan] = useState<{ targetName: string; jobs: PlannedJob[] }>({ targetName: "", jobs: [] });

  function handlePlanned(targetName: string, jobs: PlannedJob[]) {
    setPlan({ targetName, jobs });
    setTab("review");
  }

  function handleProcessed() {
    setTab("queue");
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>ROM Manager</h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {tab === "drop" && <DropPage onPlanned={handlePlanned} />}
        {tab === "review" && <ReviewPage targetName={plan.targetName} initialJobs={plan.jobs} onProcessed={handleProcessed} />}
        {tab === "queue" && <QueuePage />}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

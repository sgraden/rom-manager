export type StepId = "drop" | "review" | "queue";

interface StepDef {
  id: StepId;
  number: number;
  label: string;
}

const STEPS: StepDef[] = [
  { id: "drop", number: 1, label: "Drop" },
  { id: "review", number: 2, label: "Review" },
  { id: "queue", number: 3, label: "Queue" },
];

type StepState = "current" | "complete" | "upcoming";

function stateOf(step: StepDef, current: StepId | null, reached: Record<StepId, boolean>): StepState {
  if (step.id === current) return "current";
  const nextStep = STEPS[STEPS.findIndex((s) => s.id === step.id) + 1];
  if (nextStep && reached[nextStep.id]) return "complete";
  return "upcoming";
}

/**
 * Drop -> Review -> Queue as a connected step sequence rather than flat tabs,
 * so the workflow reads as a sequence at a glance. Every step stays directly
 * clickable — this communicates progress, it doesn't gate navigation.
 */
export function Stepper({
  current,
  reached,
  onSelect,
}: {
  current: StepId | null;
  reached: Record<StepId, boolean>;
  onSelect: (id: StepId) => void;
}) {
  return (
    <nav className="stepper" aria-label="Workflow steps">
      {STEPS.map((step, i) => {
        const state = stateOf(step, current, reached);
        return (
          <div key={step.id} className={`step step-${state}`}>
            <button
              type="button"
              className="step-button"
              onClick={() => onSelect(step.id)}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="step-marker">{state === "complete" ? "✓" : step.number}</span>
              <span className="step-label">{step.label}</span>
            </button>
            {i < STEPS.length - 1 && <span className={`step-connector ${state === "complete" ? "step-connector-filled" : ""}`} />}
          </div>
        );
      })}
    </nav>
  );
}

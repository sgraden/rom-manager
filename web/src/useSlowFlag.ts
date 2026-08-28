import { useEffect, useState } from "react";

/**
 * True once `active` has been true for longer than `delayMs`. Lets a
 * loading indicator escalate to a "still working" message for operations
 * that take a real few seconds (e.g. inspecting several archived discs),
 * so the UI doesn't read as frozen.
 */
export function useSlowFlag(active: boolean, delayMs = 2500): boolean {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return slow;
}

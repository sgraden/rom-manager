import type { ReactNode } from "react";

/**
 * The one shared primary-action location every page renders into — sticky to
 * the bottom of the viewport, same padding and layout everywhere, so the CTA
 * is always in the same place regardless of which page or how far you've
 * scrolled its content.
 */
export function ActionBar({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <div className="action-bar">
      <div className="action-bar-status">{status}</div>
      <div className="action-bar-buttons">{children}</div>
    </div>
  );
}

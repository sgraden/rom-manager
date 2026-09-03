import { useState } from "react";
import type { AppError, RemedyKind } from "./AppError";

/**
 * Renders an error as something actionable: what went wrong, what to do about it,
 * and — behind a disclosure — the raw detail worth pasting into a bug report but not
 * worth showing to someone who just wants to get on with it.
 */
export function ErrorPanel({
  error,
  onAction,
  onDismiss,
}: {
  error: AppError;
  /** Runs an in-app remedy. Without this handler no action button is offered. */
  onAction?: (kind: RemedyKind) => void;
  onDismiss?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the command is selectable on screen regardless.
    }
  }

  return (
    <div className="error-panel" role="alert">
      <div className="error-panel-head">
        <strong>{error.message}</strong>
        {onDismiss && (
          <button type="button" className="error-dismiss" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>

      {error.remedy && (
        <div className="error-remedy">
          <p>{error.remedy.text}</p>

          {error.remedy.command && (
            <div className="error-command">
              <code>{error.remedy.command}</code>
              <button type="button" onClick={() => copyCommand(error.remedy!.command!)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}

          {error.remedy.action && onAction && (
            <button type="button" onClick={() => onAction(error.remedy!.action!.kind)}>
              {error.remedy.action.label}
            </button>
          )}
        </div>
      )}

      {error.cause && (
        <details className="error-cause">
          <summary>Technical details</summary>
          <code>{error.cause}</code>
        </details>
      )}
    </div>
  );
}

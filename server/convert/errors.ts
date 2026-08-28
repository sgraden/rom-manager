export class CancelledError extends Error {
  constructor() {
    super("Job was cancelled");
    this.name = "CancelledError";
  }
}

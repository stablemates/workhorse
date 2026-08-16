export const MAX_EXTERNAL_WAIT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ExternalWaitOptions {
  /** Fail the job if the boundary remains unanswered for this many milliseconds. */
  timeoutMs?: number;
}

export function validateExternalWaitOptions(options: ExternalWaitOptions): number | null {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs === undefined) return null;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_EXTERNAL_WAIT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `External wait timeoutMs must be an integer between 1 and ${MAX_EXTERNAL_WAIT_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

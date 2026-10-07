// Node replaces a setTimeout delay above 2^31 - 1 milliseconds, about 24.8 days, with 1 ms.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Milliseconds on the process's monotonic clock.
 *
 * Lease windows and expiry timers read this clock, never the wall clock. A wall clock that an
 * operator or NTP steps forward or backward would end a window early or keep it open past the
 * database's lease. Values compare only with other values from this function in the same process.
 */
export function monotonicNow(): number {
  return performance.now();
}

/**
 * Runs `callback` once the monotonic clock reaches `atMs`, however far away that is.
 *
 * A wait longer than MAX_TIMER_DELAY_MS re-arms in capped steps, so it neither fires early nor
 * emits a TimeoutOverflowWarning. The timer never holds the process open. Returns a cancel function.
 */
export function setUnrefTimeoutAt(atMs: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    const remainingMs = Math.max(0, atMs - monotonicNow());
    timer = setTimeout(
      () => {
        timer = undefined;
        if (monotonicNow() < atMs) arm();
        else callback();
      },
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
    timer.unref();
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

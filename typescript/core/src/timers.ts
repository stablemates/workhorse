// Node replaces a setTimeout delay above 2^31 - 1 milliseconds, about 24.8 days, with 1 ms.
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Runs `callback` once the wall clock reaches `atMs`, however far away that is.
 *
 * A wait longer than MAX_TIMER_DELAY_MS re-arms in capped steps, so it neither fires early nor
 * emits a TimeoutOverflowWarning. The timer never holds the process open. Returns a cancel function.
 */
export function setUnrefTimeoutAt(atMs: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    const remainingMs = Math.max(0, atMs - Date.now());
    timer = setTimeout(
      () => {
        timer = undefined;
        if (Date.now() < atMs) arm();
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

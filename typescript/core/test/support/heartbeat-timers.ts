import { vi } from "vitest";
import type { Worker } from "../../src/index.js";

/** The scheduling state of a worker that a heartbeat test reads. */
export interface HeartbeatSchedule {
  scheduleHeartbeatBatch(): void;
  heartbeatInFlight: boolean;
  heartbeatTimer: unknown;
  heartbeatTimerIsRetry: boolean;
  heartbeatLeases: Map<string, unknown>;
  nextHeartbeatAt?: number;
  busyRetryAt: number;
}

/** One timer that the worker armed for its next heartbeat round. */
export interface ArmedHeartbeatTimer {
  /** The monotonic time when the worker armed the timer. */
  at: number;
  /** The delay that the worker gave the timer. */
  delayMs: number;
  /** The slot that the timer waits for: the busy retry time or the next regular slot. */
  dueAt: number;
  retry: boolean;
  /** True once the worker's callback ran. */
  fired: boolean;
  /** The number of registered leases when the callback ran. */
  leasesWhenFired?: number;
  /** True if the timer fell due while `hold` returned true, so its callback did not run. */
  held: boolean;
  cleared: boolean;
}

/**
 * Record each timer that `worker` arms for a heartbeat round, with its delay, and whether it fired
 * or the worker cleared it. A test reads the delay that the worker chose, so a slow host cannot
 * change the result. `vi.restoreAllMocks()` removes the recording.
 *
 * If `hold` returns true when a timer falls due, its callback does not run. The worker still sees
 * the timer as armed, so a test can require that the worker clears it.
 */
export function recordHeartbeatTimers(
  worker: Worker,
  hold: () => boolean = () => false,
): ArmedHeartbeatTimer[] {
  const armed: ArmedHeartbeatTimer[] = [];
  const byTimer = new Map<unknown, ArmedHeartbeatTimer>();
  const schedule = worker as unknown as HeartbeatSchedule;
  const original = schedule.scheduleHeartbeatBatch.bind(worker);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  vi.spyOn(schedule, "scheduleHeartbeatBatch").mockImplementation(() => {
    const armedNow: { timer?: unknown; record?: ArmedHeartbeatTimer } = {};
    // scheduleHeartbeatBatch arms its timer synchronously, so only that timer goes through this
    // replacement.
    globalThis.setTimeout = ((callback: () => void, delayMs = 0) => {
      const record: ArmedHeartbeatTimer = {
        at: performance.now(),
        delayMs,
        dueAt: Number.NaN,
        retry: false,
        fired: false,
        held: false,
        cleared: false,
      };
      const timer = realSetTimeout(() => {
        if (record.cleared) return;
        if (hold()) {
          record.held = true;
          return;
        }
        record.fired = true;
        record.leasesWhenFired = schedule.heartbeatLeases.size;
        callback();
      }, delayMs);
      armedNow.timer = timer;
      armedNow.record = record;
      return timer;
    }) as typeof setTimeout;
    try {
      original();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    if (armedNow.record === undefined) return;
    const { timer, record } = armedNow;
    record.retry = schedule.heartbeatTimerIsRetry;
    record.dueAt = record.retry ? schedule.busyRetryAt : schedule.nextHeartbeatAt!;
    byTimer.set(timer, record);
    armed.push(record);
  });
  vi.spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    const record = byTimer.get(timer);
    if (record !== undefined && !record.fired) record.cleared = true;
    realClearTimeout(timer);
  });
  return armed;
}

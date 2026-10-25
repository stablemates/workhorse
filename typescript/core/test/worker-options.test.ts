import { describe, expect, it } from "vitest";
import { MAX_TIMER_DELAY_MS } from "../src/timers.js";
import { Worker, type WorkerOptions, type WorkerQueueApi } from "../src/worker.js";

// SM-1034: a comparison with NaN is always false, so the Worker constructor accepted NaN, the
// infinities, and fractions for its timing and limit options. Each value then failed later in a
// timer, the heartbeat statement timeout, or an integer SQL parameter.
//
// SM-1169: a Node timer whose delay exceeds MAX_TIMER_DELAY_MS fires after 1 ms, so an interval
// above it would run every millisecond.

const overTimerMaximum = MAX_TIMER_DELAY_MS + 1;

function recordingQueue() {
  const calls: string[] = [];
  const queue = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "defaultQueue") return "options";
        if (typeof property === "symbol") return undefined;
        return (..._args: unknown[]) => {
          calls.push(property);
          return undefined;
        };
      },
    },
  ) as WorkerQueueApi;
  return { queue, calls };
}

const invalid: Array<[keyof WorkerOptions, number[]]> = [
  ["leaseMs", [Number.NaN, Infinity, -1, 0, 1.5, 99, 86_400_001]],
  ["heartbeatMs", [Number.NaN, Infinity, -1, 0, 1.5, overTimerMaximum]],
  // SM-1778 (ADR 0112): every SDK refuses an explicit poll interval of 0. Before, TypeScript
  // accepted it and waited 1 ms.
  ["pollMs", [Number.NaN, Infinity, -1, 0, 1.5, overTimerMaximum]],
  ["maintenanceIntervalMs", [Number.NaN, Infinity, -1, 99, 100.5, overTimerMaximum]],
  ["maintenanceRoutinePollMs", [Number.NaN, Infinity, -1, 99, 100.5, overTimerMaximum]],
  ["registryIntervalMs", [Number.NaN, Infinity, -1, 99, 100.5, overTimerMaximum]],
  ["scheduleCatchupLimit", [Number.NaN, Infinity, -1, 0, 1.5, 10_001]],
  // SM-1654: fail_v1 takes the delay as a PostgreSQL integer, so a larger fixed delay passed
  // construction and then stopped the worker at its first handler failure.
  ["retryDelayMs", [Number.NaN, Infinity, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER]],
];

describe("Worker timing and limit options", () => {
  for (const [name, values] of invalid) {
    it(`rejects an invalid ${name} before any queue operation`, () => {
      for (const value of values) {
        const { queue, calls } = recordingQueue();
        expect(() => new Worker(queue, { [name]: value }), `${name}: ${value}`).toThrow(
          `${name} must be a safe integer`,
        );
        expect(calls.filter((call) => call !== "supportsTaskNotifications")).toEqual([]);
      }
    });
  }

  // SM-1668 PAR-09 (ADR 0112): 0 stays the TypeScript way to turn registration off. A forced
  // refresh then sends nothing to the registry.
  it("sends no registration when registryIntervalMs is 0", async () => {
    const { queue, calls } = recordingQueue();
    const worker = new Worker(queue, { registryIntervalMs: 0 }) as unknown as {
      refreshRegistration(force?: boolean): Promise<void>;
    };
    await worker.refreshRegistration(true);
    expect(calls).not.toContain("registerWorker");
  });

  it("accepts the documented zero values and range limits", () => {
    const { queue } = recordingQueue();
    expect(
      () =>
        new Worker(queue, {
          registryIntervalMs: 0,
          pollMs: 1,
          retryDelayMs: 0,
          scheduleCatchupLimit: 10_000,
          maintenanceIntervalMs: 100,
          maintenanceRoutinePollMs: 100,
          leaseMs: 100,
          heartbeatMs: 1,
        }),
    ).not.toThrow();
    expect(
      () =>
        new Worker(queue, {
          pollMs: MAX_TIMER_DELAY_MS,
          maintenanceIntervalMs: MAX_TIMER_DELAY_MS,
          maintenanceRoutinePollMs: MAX_TIMER_DELAY_MS,
          registryIntervalMs: MAX_TIMER_DELAY_MS,
          retryDelayMs: 2_147_483_647,
          // The heartbeat must stay shorter than the largest lease.
          leaseMs: 86_400_000,
          heartbeatMs: 86_399_999,
        }),
    ).not.toThrow();
    expect(() => new Worker(queue, { retryDelayMs: () => undefined })).not.toThrow();
  });
});

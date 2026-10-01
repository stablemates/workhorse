import { describe, expect, it } from "vitest";
import { Worker, type WorkerOptions, type WorkerQueueApi } from "../src/worker.js";

// SM-1034: a comparison with NaN is always false, so the Worker constructor accepted NaN, the
// infinities, and fractions for its timing and limit options. Each value then failed later in a
// timer, the heartbeat statement timeout, or an integer SQL parameter.

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
  ["leaseMs", [Number.NaN, Infinity, -1, 0, 1.5]],
  ["heartbeatMs", [Number.NaN, Infinity, -1, 0, 1.5]],
  ["pollMs", [Number.NaN, Infinity, -1, 1.5]],
  ["maintenanceIntervalMs", [Number.NaN, Infinity, -1, 99, 100.5]],
  ["maintenanceRoutinePollMs", [Number.NaN, Infinity, -1, 99, 100.5]],
  ["registryIntervalMs", [Number.NaN, Infinity, -1, 99, 100.5]],
  ["scheduleCatchupLimit", [Number.NaN, Infinity, -1, 0, 1.5, 10_001]],
  ["retryDelayMs", [Number.NaN, Infinity, -1, 1.5]],
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

  it("accepts the documented zero values and range limits", () => {
    const { queue } = recordingQueue();
    expect(
      () =>
        new Worker(queue, {
          registryIntervalMs: 0,
          pollMs: 0,
          retryDelayMs: 0,
          scheduleCatchupLimit: 10_000,
          maintenanceIntervalMs: 100,
          maintenanceRoutinePollMs: 100,
          leaseMs: 2,
          heartbeatMs: 1,
        }),
    ).not.toThrow();
    expect(() => new Worker(queue, { retryDelayMs: () => undefined })).not.toThrow();
  });
});

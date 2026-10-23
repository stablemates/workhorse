import { getEventListeners } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Worker, type WorkerQueueApi } from "../src/worker.js";

// SM-1669 TS-13: each worker wait composed the caller's signal with `AbortSignal.any`. Node 22
// keeps one record on the input signal for each composed signal while the input lives, so a
// long-lived caller signal grew without limit over the waits of one run.

function idleQueue() {
  const counts = { claims: 0 };
  const queue = {
    defaultQueue: "waits",
    claim: async () => null,
    claimMany: async () => {
      counts.claims += 1;
      return [];
    },
    tick: async () => [],
    runMaintenance: async () => [],
    registerWorker: async () => ({ paused: false }),
    deregisterWorker: async () => undefined,
  } as unknown as WorkerQueueApi;
  return { queue, counts };
}

// The records Node 22 keeps on a source signal for each `AbortSignal.any` result. Later Node
// versions keep none, and then this count is 0.
function dependentSignals(signal: AbortSignal): number {
  const key = Object.getOwnPropertySymbols(signal).find(
    (symbol) => symbol.description === "kDependantSignals",
  );
  if (key === undefined) return 0;
  // Node keeps the records in an internal set class, so `instanceof Set` is false here.
  const records = (signal as unknown as Record<symbol, { size?: unknown } | undefined>)[key];
  return typeof records?.size === "number" ? records.size : 0;
}

const longIntervals = {
  queue: "waits",
  pollMs: 1,
  maintenanceIntervalMs: 60_000,
  maintenanceRoutinePollMs: 60_000,
  registryIntervalMs: 60_000,
};

describe("worker waits on a long-lived caller signal", () => {
  it("keep no composition state on the caller signal after each wait", async () => {
    const fake = idleQueue();
    const caller = new AbortController();
    const worker = new Worker(fake.queue, longIntervals);
    const run = worker.run(caller.signal);

    // Each pause and resume wakes the maintenance, registration, and dispatch waits, and each
    // woken loop starts a new wait.
    for (let round = 0; round < 200; round += 1) {
      worker.pause();
      await sleep(0);
      worker.resume();
      await sleep(1);
    }

    expect(fake.counts.claims).toBeGreaterThan(100);
    expect(dependentSignals(caller.signal)).toBeLessThanOrEqual(4);
    expect(getEventListeners(caller.signal, "abort").length).toBeLessThanOrEqual(4);

    // The caller's abort still ends the 60 s waits at once.
    const started = performance.now();
    caller.abort();
    await run;
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("ends the waits when another caller listener stops the abort propagation", async () => {
    const fake = idleQueue();
    const caller = new AbortController();
    caller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
    const worker = new Worker(fake.queue, longIntervals);
    const run = worker.run(caller.signal);
    await sleep(20);

    const started = performance.now();
    caller.abort();
    await run;

    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("ends the waits on stop while the caller signal stays live", async () => {
    const fake = idleQueue();
    const caller = new AbortController();
    const worker = new Worker(fake.queue, longIntervals);
    const run = worker.run(caller.signal);
    await sleep(20);

    const started = performance.now();
    worker.stop();
    await run;

    expect(performance.now() - started).toBeLessThan(5_000);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(dependentSignals(caller.signal)).toBe(0);
  });
});

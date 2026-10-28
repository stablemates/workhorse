import { describe, expect, it, vi } from "vitest";
import type { ClaimedTask, CompletionClaim, HeartbeatBatchStatus, Json } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";
import {
  workerHeartbeatReservation,
  type WorkerHeartbeatChannel,
  type WorkerReadinessFailure,
} from "../src/worker-internal.js";

// ADR 0071 rule 6 for the TypeScript worker (SM-1575): no claim of any kind, ordinary or fused,
// while the reserved heartbeat connection is not usable. The fake queue lends a fake channel
// through the same internal capability that a Workhorse Queue implements.

function claimedTask(id: string): ClaimedTask {
  return {
    id,
    queue: "gate",
    type: "gate.task",
    priority: 0,
    payload: null,
    contractVersion: null,
    resultMaxBytes: 1_048_576,
    redactErrorDetails: false,
    traceContext: null,
    attempt: 1,
    maxAttempts: 1,
    retryPolicy: null,
    deadlineAt: null,
    executionTimeoutMs: null,
    attemptTimeoutAt: null,
    fenceToken: 1n,
    leaseExpiresAt: new Date(Date.now() + 30_000),
  };
}

/** A heartbeat channel whose readiness the test sets. */
function fakeChannel(
  options: {
    readiness?: WorkerReadinessFailure | "wait-for-stop";
    readyWaitsForStop?: boolean;
  } = {},
) {
  const listeners = new Set<() => void>();
  // closedReads counts the reads of a closed gate, and the started flags mark the waits that began,
  // so a test waits on them instead of a fixed time.
  const state = { usable: true, closedReads: 0, checkStarted: false, readyStarted: false };
  const channel: WorkerHeartbeatChannel = {
    pool: "the test pool",
    reserve() {},
    usable: () => {
      if (!state.usable) state.closedReads += 1;
      return state.usable;
    },
    onReady(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ready(_timeoutMs, signal) {
      state.readyStarted = true;
      if (state.usable || options.readyWaitsForStop !== true) return state.usable;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve());
      });
      return false;
    },
    async checkReadiness(_timeoutMs, signal) {
      state.checkStarted = true;
      if (options.readiness === "wait-for-stop") {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        return { step: "stopped" };
      }
      return options.readiness;
    },
    async heartbeatMany(tasks) {
      return new Map<string, HeartbeatBatchStatus>(tasks.map((task) => [task.id, "accepted"]));
    },
    async close() {},
  };
  return {
    channel,
    state,
    lose() {
      state.usable = false;
    },
    recover() {
      state.usable = true;
      for (const listener of listeners) listener();
    },
  };
}

/** A fast-tier queue that hands out `tasks` one claim at a time and records every claim. */
function fastQueue(channel: WorkerHeartbeatChannel, tasks: ClaimedTask[]) {
  const claims: number[] = [];
  const completions: CompletionClaim[] = [];
  const queue = {
    defaultQueue: "gate",
    claim: async () => null,
    claimMany: async () => [],
    claimFast: async (_workerId: string, limit: number) => {
      claims.push(limit);
      return tasks.splice(0, 1);
    },
    completeAndClaim: async (
      _task: ClaimedTask,
      _workerId: string,
      _result: Json,
      claim: CompletionClaim,
    ) => {
      completions.push(claim);
      return { accepted: true, claimed: [] };
    },
    complete: async () => true,
    fail: async () => "failed",
    heartbeatStatus: async () => "accepted",
    tick: async () => [],
    runMaintenance: async () => [],
    [workerHeartbeatReservation]: () => channel,
  } as unknown as WorkerQueueApi;
  return { queue, claims, completions };
}

const options = { queue: "gate", concurrency: 4, registryIntervalMs: 0, heartbeatMs: 100 };

describe("worker heartbeat gate", () => {
  it("sends no ordinary claim while the heartbeat connection is lost, and wakes at recovery", async () => {
    const gate = fakeChannel();
    gate.lose();
    const fake = fastQueue(gate.channel, [claimedTask("a")]);
    const handled: string[] = [];
    // Only a wake can start a claim soon: the poll interval is one minute.
    const worker = new Worker(fake.queue, { ...options, pollMs: 60_000 }).handle(
      "gate.task",
      async (_payload, context) => {
        handled.push(context.task.id);
        return null;
      },
    );
    const run = worker.run();
    try {
      // Dispatch read the closed gate. Nothing else wakes it before the poll interval ends.
      await vi.waitFor(() => expect(gate.state.closedReads).toBeGreaterThan(0));
      expect(fake.claims).toEqual([]);

      gate.recover();
      await vi.waitFor(() => expect(handled).toEqual(["a"]), { timeout: 5_000 });
    } finally {
      worker.stop();
      await run;
    }
  });

  it("completes with a claim limit of zero while the heartbeat connection is lost", async () => {
    const gate = fakeChannel();
    const fake = fastQueue(gate.channel, [claimedTask("a")]);
    const worker = new Worker(fake.queue, { ...options, pollMs: 10 }).handle(
      "gate.task",
      async () => {
        // The connection is lost while the handler runs.
        gate.lose();
        return null;
      },
    );
    const run = worker.run();
    try {
      await vi.waitFor(() => expect(fake.completions).toHaveLength(1));
      expect(fake.completions[0]!.limit).toBe(0);
      const claimsBefore = fake.claims.length;
      // The slot is free, and dispatch reads the closed gate again instead of claiming into it.
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(0));
      const readsBefore = gate.state.closedReads;
      await vi.waitFor(() => expect(gate.state.closedReads).toBeGreaterThan(readsBefore));
      expect(fake.claims).toHaveLength(claimsBefore);
    } finally {
      worker.stop();
      await run;
    }
  });

  it("refuses to start with an error that names the pool, the budget, and the next step", async () => {
    const gate = fakeChannel({ readiness: { step: "heartbeat", reason: "timeout" } });
    const fake = fastQueue(gate.channel, []);
    const worker = new Worker(fake.queue, { ...options, heartbeatMs: 7_000, leaseMs: 30_000 });

    await expect(worker.run()).rejects.toThrow(
      "Worker refused to start: the test pool did not lend the dedicated heartbeat connection " +
        "within the startup budget of 7000 ms (max(heartbeatMs, 5000)). Give the pool more free " +
        "connections.",
    );
    expect(fake.claims).toEqual([]);
  });

  it("ends the startup check at once when the worker stops", async () => {
    const gate = fakeChannel({ readiness: "wait-for-stop" });
    const fake = fastQueue(gate.channel, []);
    const worker = new Worker(fake.queue, options);
    const run = worker.run();
    try {
      await vi.waitFor(() => expect(gate.state.checkStarted).toBe(true));
    } finally {
      worker.stop();
    }
    await expect(run).resolves.toBeUndefined();
    expect(fake.claims).toEqual([]);
  });

  it("lets runOnce() claim nothing while the heartbeat connection is lost", async () => {
    const gate = fakeChannel();
    gate.lose();
    const fake = fastQueue(gate.channel, [claimedTask("a")]);
    const worker = new Worker(fake.queue, options).handle("gate.task", async () => null);

    await expect(worker.runOnce()).rejects.toThrow(/Worker\.runOnce\(\) claimed nothing/);
    expect(fake.claims).toEqual([]);

    gate.recover();
    await expect(worker.runOnce()).resolves.toBe(true);
  });

  it("ends the runOnce() wait for the heartbeat connection when the worker stops", async () => {
    const gate = fakeChannel({ readyWaitsForStop: true });
    gate.lose();
    const fake = fastQueue(gate.channel, [claimedTask("a")]);
    const worker = new Worker(fake.queue, options).handle("gate.task", async () => null);
    const pass = worker.runOnce();
    try {
      await vi.waitFor(() => expect(gate.state.readyStarted).toBe(true));
    } finally {
      worker.stop();
    }

    await expect(pass).resolves.toBe(false);
    expect(fake.claims).toEqual([]);
  });
});

/**
 * A queue with one registry row per worker ID. deregisterWorker waits until the test lets it go,
 * as a statement waits for a pooled connection. It then deletes the row only while the row names
 * the instance of the caller, as deregister_worker_v2 does.
 */
function registryQueue(behavior: { holdFirstRegistration?: boolean } = {}) {
  const rows = new Map<string, string>();
  const events: string[] = [];
  const held: Array<() => void> = [];
  // The first registration waits until the test answers it, and its answer says "paused".
  const heldRegistrations: Array<() => void> = [];
  let registrations = 0;
  const queue = {
    defaultQueue: "registry",
    claim: async () => null,
    claimMany: async () => [],
    complete: async () => true,
    fail: async () => "failed",
    heartbeatStatus: async () => "accepted",
    tick: async () => [],
    runMaintenance: async () => [],
    registerWorker: async (registration: { workerId: string; instanceId: string }) => {
      registrations += 1;
      if (behavior.holdFirstRegistration === true && registrations === 1) {
        events.push("first register sent");
        await new Promise<void>((resolve) => {
          heldRegistrations.push(resolve);
        });
        rows.set(registration.workerId, registration.instanceId);
        events.push("first register done");
        return { paused: true };
      }
      rows.set(registration.workerId, registration.instanceId);
      events.push("register");
      return { paused: false };
    },
    deregisterWorker: async (workerId: string, instanceId: string) => {
      events.push("deregister sent");
      if (behavior.holdFirstRegistration !== true) {
        await new Promise<void>((resolve) => {
          held.push(resolve);
        });
      }
      if (rows.get(workerId) === instanceId) rows.delete(workerId);
      events.push("deregister done");
    },
  } as unknown as WorkerQueueApi;
  return { queue, rows, events, held, heldRegistrations };
}

describe("worker stop path across runs", () => {
  // Only the startup registration and the refresh at stop() write to the registry.
  const registryOptions = { queue: "registry", registryIntervalMs: 60_000, heartbeatMs: 100 };

  it("does not let the late deregistration of an ended run delete the row of the next run", async () => {
    const registry = registryQueue();
    const worker = new Worker(registry.queue, { ...registryOptions, workerId: "same-worker" });
    let second: Promise<void> | undefined;
    try {
      const first = worker.run();
      await vi.waitFor(() => expect(registry.events).toContain("register"));
      worker.stop();
      // The deregistration of the first run waits past its unwind window, and the run ends.
      await vi.waitFor(() => expect(registry.held).toHaveLength(1));
      await first;
      const registrations = registry.events.filter((event) => event === "register").length;

      second = worker.run();
      // The late deregistration of the first run now reaches the database.
      registry.held.shift()!();
      await vi.waitFor(() =>
        expect(registry.events.filter((event) => event === "register")).toHaveLength(
          registrations + 1,
        ),
      );
      // The next run registers only after the deregistration of the first run settled.
      expect(registry.events.lastIndexOf("register")).toBeGreaterThan(
        registry.events.indexOf("deregister done"),
      );
      expect(registry.rows.has("same-worker")).toBe(true);
    } finally {
      worker.stop();
      for (const release of registry.held.splice(0)) release();
      await second?.catch(() => undefined);
      for (const release of registry.held.splice(0)) release();
    }
  }, 20_000);

  it("refuses to start while a stop-path statement of the previous run has not settled", async () => {
    const registry = registryQueue();
    const worker = new Worker(registry.queue, { ...registryOptions, workerId: "same-worker" });
    let second: Promise<void> | undefined;
    try {
      const first = worker.run();
      await vi.waitFor(() => expect(registry.events).toContain("register"));
      worker.stop();
      await vi.waitFor(() => expect(registry.held).toHaveLength(1));
      await first;
      const before = [...registry.events];

      second = worker.run();
      await expect(second).rejects.toThrow(
        /stop path of its previous run did not settle within the startup budget of 5000 ms/,
      );
      // The refused run wrote nothing to the registry.
      expect(registry.events).toEqual(before);
    } finally {
      worker.stop();
      for (const release of registry.held.splice(0)) release();
      await second?.catch(() => undefined);
      for (const release of registry.held.splice(0)) release();
    }
  }, 30_000);

  it("does not let the late registration of an ended run change the next run", async () => {
    const registry = registryQueue({ holdFirstRegistration: true });
    const worker = new Worker(registry.queue, { ...registryOptions, workerId: "same-worker" });
    let second: Promise<void> | undefined;
    try {
      // 1. The first registration of the first run waits, and stop() ends that run.
      const first = worker.run();
      await vi.waitFor(() => expect(registry.heldRegistrations).toHaveLength(1));
      worker.stop();
      await first;

      // 2. The next run starts, and then the late registration of the first run answers "paused".
      second = worker.run();
      registry.heldRegistrations.shift()!();
      await vi.waitFor(() => expect(registry.events).toContain("register"));
      // The next run registered after the late registration settled, and its answer counts.
      expect(registry.events.indexOf("register")).toBeGreaterThan(
        registry.events.indexOf("first register done"),
      );
      expect(worker.isPaused()).toBe(false);
      expect(registry.rows.has("same-worker")).toBe(true);
    } finally {
      worker.stop();
      for (const release of registry.heldRegistrations.splice(0)) release();
      await second?.catch(() => undefined);
    }
  }, 20_000);
});

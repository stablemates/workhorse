import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { InjectedCrashError, type MaintenancePhaseResult, Queue, Worker } from "../src/index.js";
import { Pool } from "pg";
import { createIntegrationTestContext } from "./support/integration.js";

const { databaseUrl, deferred, pool, queue, admin, adminAudit } = createIntegrationTestContext(
  import.meta.url,
);

describe("worker registry", () => {
  it("claims configured queues through one worker identity and shared slot budget", async () => {
    const firstQueue = `multi-queue-first-${randomUUID()}`;
    const secondQueue = `multi-queue-second-${randomUUID()}`;
    const handled: string[] = [];
    await queue.enqueue("multi-queue", null, { queue: firstQueue });
    await queue.enqueue("multi-queue", null, { queue: secondQueue });

    const worker = new Worker(queue, {
      workerId: "multi-queue-worker",
      queues: [firstQueue, secondQueue],
      concurrency: 2,
      pollMs: 0,
    }).handle("multi-queue", (_payload, { job }) => {
      handled.push(job.queue);
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(handled.toSorted()).toEqual([firstQueue, secondQueue].toSorted());
  });

  it("registers every queue served by one worker", async () => {
    const worker = new Worker(queue, {
      workerId: "multi-queue-registration",
      queues: ["mail", "billing"],
      registryIntervalMs: 100,
    });

    await worker.runOnce();

    await expect(
      admin
        .listWorkers()
        .then((workers) => workers.find((entry) => entry.workerId === "multi-queue-registration")),
    ).resolves.toMatchObject({ queues: ["mail", "billing"] });
  });

  it("subscribes to notifications for every configured queue", async () => {
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const subscribe = vi.spyOn(queue, "subscribeToJobNotifications").mockResolvedValue({ close });
    const worker = new Worker(queue, {
      workerId: "multi-queue-notifications",
      queues: ["mail", "billing"],
      pollMs: 10,
      registryIntervalMs: 0,
    });

    try {
      const running = worker.run();
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
      expect(subscribe.mock.calls.map(([queueName]) => queueName)).toEqual(["mail", "billing"]);
      worker.stop();
      await running;
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      subscribe.mockRestore();
    }
  });

  it("registers a running worker durably and deregisters it once its loop stops", async () => {
    const worker = new Worker(queue, {
      workerId: "registry-lifecycle",
      queue: "default",
      concurrency: 4,
      pollMs: 10,
      registryIntervalMs: 100,
    }).handle("registry-lifecycle", () => ({ ok: true }));

    const registration = async () =>
      (await admin.listWorkers()).find((entry) => entry.workerId === "registry-lifecycle");

    const running = worker.run();
    await vi.waitFor(async () => {
      expect(await registration()).toMatchObject({
        workerId: "registry-lifecycle",
        queue: "default",
        concurrency: 4,
        paused: false,
        draining: false,
        // Placement is recorded independently of the configured name, so a stably named worker
        // still answers "which host and process is this".
        hostname: expect.any(String),
        pid: process.pid,
      });
    });

    worker.stop();
    await running;
    await expect(registration()).resolves.toBeUndefined();
  });

  it("deregisters when notification subscription cleanup fails", async () => {
    const closeFailure = new Error("notification close failed");
    const close = vi.fn<() => Promise<void>>(async () => {
      throw closeFailure;
    });
    const subscribe = vi.spyOn(queue, "subscribeToJobNotifications").mockResolvedValue({ close });
    const worker = new Worker(queue, {
      workerId: "registry-notification-close-failure",
      queue: "default",
      pollMs: 10,
      registryIntervalMs: 100,
    }).handle("registry-notification-close-failure", () => null);
    const registration = async () =>
      (await admin.listWorkers()).find(
        (entry) => entry.workerId === "registry-notification-close-failure",
      );

    try {
      const running = worker.run();
      await vi.waitFor(async () => expect(await registration()).toBeDefined());
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

      worker.stop();
      await expect(running).rejects.toBe(closeFailure);
      expect(close).toHaveBeenCalledOnce();
      await expect(registration()).resolves.toBeUndefined();
    } finally {
      subscribe.mockRestore();
    }
  });

  it("preserves cleanup failures while still deregistering", async () => {
    const closeFailure = new Error("notification close failed");
    const registrationFailure = new Error("draining registration failed");
    let failRegistration = false;
    const rejectingQueue = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "registerWorker") {
          return async (...args: Parameters<Queue["registerWorker"]>) => {
            if (failRegistration) throw registrationFailure;
            return target.registerWorker(...args);
          };
        }
        if (property === "subscribeToJobNotifications") {
          return async () => ({
            close: async () => {
              throw closeFailure;
            },
          });
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const workerId = "registry-multiple-cleanup-failures";
    const worker = new Worker(rejectingQueue, {
      workerId,
      queue: "default",
      pollMs: 10,
      registryIntervalMs: 100,
      onRegistrationError: (error) => {
        throw error;
      },
    }).handle("registry-multiple-cleanup-failures", () => null);
    const registration = async () =>
      (await admin.listWorkers()).find((entry) => entry.workerId === workerId);

    const running = worker.run();
    await vi.waitFor(async () => expect(await registration()).toBeDefined());
    failRegistration = true;
    worker.stop();

    await expect(running).rejects.toEqual(
      new AggregateError([closeFailure, registrationFailure], "Worker shutdown failed"),
    );
    await expect(registration()).resolves.toBeUndefined();
  });

  it("applies an operator pause written to PostgreSQL by another process", async () => {
    // The pause is written through a separate Queue instance holding no reference to the worker
    // object, which is exactly the situation of a dashboard running outside the worker process.
    const handled: number[] = [];
    const worker = new Worker(queue, {
      workerId: "registry-remote-pause",
      pollMs: 10,
      registryIntervalMs: 100,
    }).handle<{ sequence: number }>("registry-remote-pause", ({ sequence }) => {
      handled.push(sequence);
      return { sequence };
    });

    const running = worker.run();
    await vi.waitFor(async () => {
      expect((await admin.listWorkers()).map((entry) => entry.workerId)).toContain(
        "registry-remote-pause",
      );
    });

    await expect(
      admin.setWorkerPaused("registry-remote-pause", true, {
        ...adminAudit("rolling deploy"),
        actor: "operator",
      }),
    ).resolves.toMatchObject({ paused: true, pausedBy: "operator", reason: "rolling deploy" });
    await vi.waitFor(() => expect(worker.isPaused()).toBe(true));
    expect(worker.runtimeState()).toMatchObject({
      paused: true,
      remotelyPaused: true,
      locallyPaused: false,
    });

    // A worker paused by an operator must not claim, and a local resume() must not override it.
    await queue.enqueue("registry-remote-pause", { sequence: 1 });
    worker.resume();
    await sleep(300);
    expect(handled).toEqual([]);
    expect(worker.isPaused()).toBe(true);

    await admin.setWorkerPaused("registry-remote-pause", false, adminAudit("resume worker"));
    await vi.waitFor(() => expect(handled).toEqual([1]));
    expect(worker.runtimeState()).toMatchObject({ paused: false, remotelyPaused: false });

    worker.stop();
    await running;
  });

  it("returns null when pausing a worker that has never registered", async () => {
    await expect(
      admin.setWorkerPaused("never-registered", true, adminAudit("pause missing worker")),
    ).resolves.toBeNull();
  });

  it("scopes an operator pause to the running process rather than to the worker name", async () => {
    const instance = randomUUID();
    const registration = {
      workerId: "registry-process-scope",
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    };

    await queue.registerWorker({ ...registration, instanceId: instance });
    await expect(
      admin.setWorkerPaused("registry-process-scope", true, adminAudit("pause process")),
    ).resolves.toMatchObject({ paused: true });

    // The same process refreshing must keep the pause, or a pause would clear on its own heartbeat.
    await expect(queue.registerWorker({ ...registration, instanceId: instance })).resolves.toEqual({
      paused: true,
    });

    // A replacement process for the same worker name comes back running, and inherits no
    // attribution from the operator decision that was aimed at the process it replaced.
    await expect(
      queue.registerWorker({ ...registration, instanceId: randomUUID() }),
    ).resolves.toEqual({ paused: false });
    const entry = (await admin.listWorkers()).find(
      (worker) => worker.workerId === "registry-process-scope",
    );
    expect(entry).toMatchObject({ paused: false, pausedBy: null, reason: null, pausedAt: null });
  });

  it("prunes only registrations whose heartbeat aged past the requested window", async () => {
    await queue.registerWorker({
      workerId: "registry-prune",
      instanceId: randomUUID(),
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    });

    await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(0);
    await pool.query(
      "UPDATE workhorse.worker_registry SET last_heartbeat_at = clock_timestamp() - interval '10 minutes'",
    );
    await expect(queue.pruneWorkerRegistry(60_000)).resolves.toBe(1);
    await expect(
      admin.listWorkers().then((entries) => entries.map((entry) => entry.workerId)),
    ).resolves.not.toContain("registry-prune");
  });

  it("prunes stale worker registrations during automatic maintenance", async () => {
    await queue.registerWorker({
      workerId: "registry-automatic-prune",
      instanceId: randomUUID(),
      hostname: "test-host",
      pid: 4321,
      queue: "default",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    });
    await pool.query(
      "UPDATE workhorse.worker_registry SET last_heartbeat_at = clock_timestamp() - interval '10 minutes'",
    );

    const worker = new Worker(queue, { workerId: "registry-maintenance-runner" });
    await worker.runOnce();

    await expect(
      admin.listWorkers().then((entries) => entries.map((entry) => entry.workerId)),
    ).resolves.not.toContain("registry-automatic-prune");
  });

  it("bounds overlap, claims only free slots, and breaks the claim loop on the first null", async () => {
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    for (const sequence of [1, 2]) await queue.enqueue("bounded-batch", { sequence });
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, {
      workerId: "bounded-batch-worker",
      concurrency: 5,
      pollMs: 0,
    }).handle("bounded-batch", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await release.promise;
      active -= 1;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));

      expect(claim).toHaveBeenCalledTimes(3);
      expect(worker.runtimeState()).toEqual({
        concurrency: 5,
        activeSlots: 2,
        paused: false,
        locallyPaused: false,
        remotelyPaused: false,
        draining: false,
      });

      release.resolve();
      await expect(run).resolves.toBe(true);
      expect(maxActive).toBe(2);
      expect(worker.runtimeState().activeSlots).toBe(0);
    } finally {
      claim.mockRestore();
    }
  });

  it("refills a freed run slot while a sibling handler remains blocked", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const thirdRelease = deferred();
    const thirdStarted = deferred();
    const started: number[] = [];
    let secondBlocked = true;
    for (const sequence of [1, 2, 3]) await queue.enqueue("continuous-refill", { sequence });
    const worker = new Worker(queue, {
      workerId: "continuous-refill-worker",
      concurrency: 2,
      pollMs: 1_000,
    }).handle<{ sequence: number }>("continuous-refill", async ({ sequence }) => {
      started.push(sequence);
      if (sequence === 1) await firstRelease.promise;
      if (sequence === 2) {
        await secondRelease.promise;
        secondBlocked = false;
      }
      if (sequence === 3) {
        thirdStarted.resolve();
        await thirdRelease.promise;
      }
      return { sequence };
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(started).toEqual([1, 2]));
      firstRelease.resolve();
      await thirdStarted.promise;

      expect(secondBlocked).toBe(true);
      expect(started).toEqual([1, 2, 3]);
      expect(worker.runtimeState().activeSlots).toBe(2);
    } finally {
      worker.stop();
      firstRelease.resolve();
      secondRelease.resolve();
      thirdRelease.resolve();
      await running;
    }
  });

  it("serializes public runOnce calls and preserves default single-job compatibility", async () => {
    const firstRelease = deferred();
    const secondRelease = deferred();
    const started: number[] = [];
    for (const sequence of [1, 2]) await queue.enqueue("serialized-run-once", { sequence });
    const worker = new Worker(queue, {
      workerId: "serialized-run-once-worker",
      pollMs: 0,
    }).handle<{ sequence: number }>("serialized-run-once", async ({ sequence }) => {
      started.push(sequence);
      await (sequence === 1 ? firstRelease.promise : secondRelease.promise);
      return { sequence };
    });

    const first = worker.runOnce();
    const second = worker.runOnce();
    await vi.waitFor(() => expect(started).toEqual([1]));
    expect(worker.concurrency).toBe(1);
    expect(worker.runtimeState().activeSlots).toBe(1);

    firstRelease.resolve();
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    secondRelease.resolve();
    await expect(second).resolves.toBe(true);
    expect(worker.runtimeState().activeSlots).toBe(0);
  });

  it("keeps per-job heartbeats running while paused and does not claim more work", async () => {
    const release = deferred();
    const ids = await Promise.all(
      [1, 2, 3].map((sequence) => queue.enqueue("paused-concurrency", { sequence })),
    );
    const heartbeat = vi.spyOn(queue, "heartbeatStatus");
    const worker = new Worker(queue, {
      workerId: "paused-concurrency-worker",
      concurrency: 2,
      heartbeatMs: 20,
      leaseMs: 500,
      pollMs: 0,
    }).handle("paused-concurrency", async () => {
      await release.promise;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));
      worker.pause();
      await vi.waitFor(() => {
        const heartbeatingIds = new Set(heartbeat.mock.calls.map(([job]) => job.id));
        expect(heartbeatingIds.size).toBe(2);
        expect([...heartbeatingIds].every((id) => ids.includes(id))).toBe(true);
      });

      expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, paused: true });
      release.resolve();
      await expect(run).resolves.toBe(true);
      expect(await worker.runOnce()).toBe(false);
      const states = await Promise.all(ids.map(async (id) => (await admin.getJob(id))?.state));
      expect(states.filter((state) => state === "ready")).toHaveLength(1);
      expect(states.filter((state) => state === "succeeded")).toHaveLength(2);
    } finally {
      heartbeat.mockRestore();
    }
  });

  it("runs independent per-job heartbeats without overlapping a slow heartbeat", async () => {
    const releaseHandlers = deferred();
    const heartbeatGates = new Map<string, ReturnType<typeof deferred<"accepted">>[]>();
    const heartbeatCalls = new Map<string, number>();
    const inFlight = new Map<string, number>();
    const maxInFlight = new Map<string, number>();
    for (const sequence of [1, 2]) await queue.enqueue("slow-heartbeat", { sequence });
    const heartbeat = vi.spyOn(queue, "heartbeatStatus").mockImplementation((job) => {
      const active = (inFlight.get(job.id) ?? 0) + 1;
      inFlight.set(job.id, active);
      maxInFlight.set(job.id, Math.max(maxInFlight.get(job.id) ?? 0, active));
      heartbeatCalls.set(job.id, (heartbeatCalls.get(job.id) ?? 0) + 1);
      const gate = deferred<"accepted">();
      const gates = heartbeatGates.get(job.id) ?? [];
      gates.push(gate);
      heartbeatGates.set(job.id, gates);
      return gate.promise.finally(() => {
        inFlight.set(job.id, (inFlight.get(job.id) ?? 1) - 1);
      });
    });
    const worker = new Worker(queue, {
      workerId: "slow-heartbeat-worker",
      concurrency: 2,
      heartbeatMs: 10,
      leaseMs: 500,
      pollMs: 0,
    }).handle("slow-heartbeat", async () => {
      await releaseHandlers.promise;
      return null;
    });

    try {
      const run = worker.runOnce();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));
      await vi.waitFor(() => expect(heartbeatGates.size).toBe(2));
      const [firstId, secondId] = [...heartbeatGates.keys()];
      expect(firstId).toBeDefined();
      expect(secondId).toBeDefined();

      await sleep(40);
      expect(heartbeatCalls.get(firstId!)).toBe(1);
      expect(heartbeatCalls.get(secondId!)).toBe(1);
      heartbeatGates.get(firstId!)![0]!.resolve("accepted");
      await vi.waitFor(() => expect(heartbeatCalls.get(firstId!)).toBe(2));

      expect(heartbeatCalls.get(secondId!)).toBe(1);
      expect(inFlight.get(firstId!)).toBe(1);
      expect(inFlight.get(secondId!)).toBe(1);
      expect(maxInFlight.get(firstId!)).toBe(1);
      expect(maxInFlight.get(secondId!)).toBe(1);

      releaseHandlers.resolve();
      await expect(run).resolves.toBe(true);
      const callsAtSettlement = new Map(heartbeatCalls);
      for (const gates of heartbeatGates.values()) {
        for (const gate of gates) gate.resolve("accepted");
      }
      await sleep(30);
      expect(heartbeatCalls).toEqual(callsAtSettlement);
    } finally {
      releaseHandlers.resolve();
      for (const gates of heartbeatGates.values()) {
        for (const gate of gates) gate.resolve("accepted");
      }
      heartbeat.mockRestore();
    }
  });

  it("stops new claims and resolves run only after every active slot drains", async () => {
    const release = deferred();
    const ids = await Promise.all(
      [1, 2, 3].map((sequence) => queue.enqueue("graceful-concurrency-drain", { sequence })),
    );
    const worker = new Worker(queue, {
      workerId: "graceful-concurrency-drain-worker",
      concurrency: 2,
      pollMs: 0,
    }).handle("graceful-concurrency-drain", async () => {
      await release.promise;
      return null;
    });

    const running = worker.run();
    await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(2));
    const blockedRunOnce = worker.runOnce();
    let runOnceResolved = false;
    void blockedRunOnce.then(() => {
      runOnceResolved = true;
    });
    await sleep(20);
    expect(runOnceResolved).toBe(false);

    worker.stop();
    expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, draining: true });
    let resolved = false;
    void running.then(() => {
      resolved = true;
    });
    await sleep(20);
    expect(resolved).toBe(false);

    release.resolve();
    await expect(running).resolves.toBeUndefined();
    await expect(blockedRunOnce).resolves.toBe(false);
    expect(worker.runtimeState()).toEqual({
      concurrency: 2,
      activeSlots: 0,
      paused: false,
      locallyPaused: false,
      remotelyPaused: false,
      draining: false,
    });
    const states = await Promise.all(ids.map(async (id) => (await admin.getJob(id))?.state));
    expect(states.filter((state) => state === "ready")).toHaveLength(1);
    expect(states.filter((state) => state === "succeeded")).toHaveLength(2);
  });

  it("drains both active handlers after signal abort without claiming queued work", async () => {
    const controller = new AbortController();
    const releases = [deferred(), deferred()];
    const bothStarted = deferred();
    const startedIds: string[] = [];
    const ids: string[] = [];
    for (const sequence of [0, 1, 2]) {
      ids.push(await queue.enqueue("signal-abort-drain", { sequence }));
    }
    const claim = vi.spyOn(queue, "claim");
    const heartbeat = vi.spyOn(queue, "heartbeatStatus");
    const worker = new Worker(queue, {
      workerId: "signal-abort-drain-worker",
      concurrency: 2,
      heartbeatMs: 10,
      leaseMs: 500,
      pollMs: 0,
    }).handle<{ sequence: number }>("signal-abort-drain", async ({ sequence }, context) => {
      startedIds.push(context.job.id);
      if (startedIds.length === 2) bothStarted.resolve();
      await releases[sequence]!.promise;
      return { sequence };
    });

    const heartbeatCount = (id: string) =>
      heartbeat.mock.calls.filter(([job]) => job.id === id).length;
    const running = worker.run(controller.signal);

    try {
      await bothStarted.promise;
      expect(startedIds).toEqual(ids.slice(0, 2));
      expect(worker.runtimeState()).toMatchObject({ activeSlots: 2, paused: false });

      const countsAtAbort = new Map(ids.slice(0, 2).map((id) => [id, heartbeatCount(id)]));
      controller.abort();
      await vi.waitFor(() => {
        for (const id of ids.slice(0, 2)) {
          expect(heartbeatCount(id)).toBeGreaterThan(countsAtAbort.get(id)!);
        }
      });
      expect(claim).toHaveBeenCalledTimes(2);
      await expect(admin.getJob(ids[2]!)).resolves.toMatchObject({ state: "ready" });

      let runSettled = false;
      void running.then(() => {
        runSettled = true;
      });
      releases[0]!.resolve();
      await vi.waitFor(async () => expect((await admin.getJob(ids[0]!))?.state).toBe("succeeded"));
      expect(runSettled).toBe(false);
      expect(worker.runtimeState().activeSlots).toBe(1);

      const secondCountAfterFirstRelease = heartbeatCount(ids[1]!);
      await vi.waitFor(() =>
        expect(heartbeatCount(ids[1]!)).toBeGreaterThan(secondCountAfterFirstRelease),
      );
      expect(claim).toHaveBeenCalledTimes(2);
      await expect(admin.getJob(ids[2]!)).resolves.toMatchObject({ state: "ready" });

      releases[1]!.resolve();
      await expect(running).resolves.toBeUndefined();
      expect(worker.runtimeState().activeSlots).toBe(0);
      await expect(Promise.all(ids.slice(0, 2).map((id) => admin.getJob(id)))).resolves.toEqual(
        ids.slice(0, 2).map((id) => expect.objectContaining({ id, state: "succeeded" })),
      );
      await expect(admin.getJob(ids[2]!)).resolves.toMatchObject({ state: "ready" });
    } finally {
      controller.abort();
      for (const release of releases) release.resolve();
      await running.catch(() => undefined);
      claim.mockRestore();
      heartbeat.mockRestore();
    }
  });

  it("honors a same-turn stop before run starts without claiming", async () => {
    const id = await queue.enqueue("same-turn-stop", {});
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, { workerId: "same-turn-stop-worker" }).handle(
      "same-turn-stop",
      () => null,
    );

    try {
      const running = worker.run();
      worker.stop();
      await expect(running).resolves.toBeUndefined();
      expect(claim).not.toHaveBeenCalled();
      await expect(admin.getJob(id)).resolves.toMatchObject({ state: "ready" });
    } finally {
      claim.mockRestore();
    }
  });

  it("honors stop while run is queued behind runOnce without claiming again", async () => {
    const release = deferred();
    const started = deferred();
    const firstId = await queue.enqueue("queued-run-stop", { sequence: 1 });
    const secondId = await queue.enqueue("queued-run-stop", { sequence: 2 });
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, {
      workerId: "queued-run-stop-worker",
      pollMs: 0,
    }).handle("queued-run-stop", async () => {
      started.resolve();
      await release.promise;
      return null;
    });

    try {
      const once = worker.runOnce();
      await started.promise;
      const queuedRun = worker.run();
      worker.stop();
      release.resolve();

      await expect(once).resolves.toBe(true);
      await expect(queuedRun).resolves.toBeUndefined();
      expect(claim).toHaveBeenCalledTimes(1);
      await expect(admin.getJob(firstId)).resolves.toMatchObject({ state: "succeeded" });
      await expect(admin.getJob(secondId)).resolves.toMatchObject({ state: "ready" });
    } finally {
      release.resolve();
      claim.mockRestore();
    }
  });

  it.each([
    { maxAttempts: 2, expectedState: "ready", expectedAttempt: 2 },
    { maxAttempts: 1, expectedState: "failed", expectedAttempt: 1 },
  ] as const)(
    "settles successful siblings and recovers a concurrent crash with maxAttempts $maxAttempts",
    async ({ maxAttempts, expectedState, expectedAttempt }) => {
      const siblingsStarted = deferred();
      const crashObserved = deferred();
      const releaseSiblings = deferred();
      const startedSiblings = new Set<number>();
      let crashedClaim:
        | { id: string; attempt: number; fenceToken: bigint; leaseExpiresAt: Date }
        | undefined;
      const [crashedId, ...siblingIds] = await Promise.all([
        queue.enqueue("batch-crash-settlement", { sequence: 1 }, { maxAttempts }),
        queue.enqueue("batch-crash-settlement", { sequence: 2 }),
        queue.enqueue("batch-crash-settlement", { sequence: 3 }),
      ]);
      const workerId = `batch-crash-settlement-${maxAttempts}`;
      const worker = new Worker(queue, {
        workerId,
        concurrency: 3,
        leaseMs: 10_000,
        heartbeatMs: 1_000,
        pollMs: 0,
        failpoint: (point, job) => {
          const shouldCrash =
            point === "beforeHandler" && (job.payload as { sequence: number }).sequence === 1;
          if (shouldCrash) {
            crashedClaim = {
              id: job.id,
              attempt: job.attempt,
              fenceToken: job.fenceToken,
              leaseExpiresAt: job.leaseExpiresAt,
            };
            crashObserved.resolve();
          }
          return shouldCrash;
        },
      }).handle<{ sequence: number }>("batch-crash-settlement", async ({ sequence }) => {
        startedSiblings.add(sequence);
        if (startedSiblings.size === 2) siblingsStarted.resolve();
        await releaseSiblings.promise;
        return { sequence };
      });

      const run = worker.runOnce();
      await Promise.all([siblingsStarted.promise, crashObserved.promise]);
      expect(crashedClaim).toBeDefined();
      const crash = crashedClaim!;
      expect(crash).toMatchObject({ id: crashedId, attempt: 1 });

      let settled = false;
      void run.catch(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseSiblings.resolve();
      await expect(run).rejects.toMatchObject({
        name: "InjectedCrashError",
        failpoint: "beforeHandler",
      });
      expect(worker.runtimeState().activeSlots).toBe(0);
      await expect(Promise.all(siblingIds.map((id) => admin.getJob(id)))).resolves.toEqual(
        siblingIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
      );

      const active = await pool.query<{
        state: string;
        current_attempt: number;
        fence_token: string;
        worker_id: string | null;
        expires_at: Date | null;
      }>(
        `SELECT state, current_attempt, fence_token::text, worker_id, expires_at
         FROM workhorse.job_runtime WHERE job_id = $1`,
        [crashedId],
      );
      expect(active.rows[0]).toEqual({
        state: "active",
        current_attempt: 1,
        fence_token: crash.fenceToken.toString(),
        worker_id: workerId,
        expires_at: crash.leaseExpiresAt,
      });
      await expect(admin.getJob(crashedId)).resolves.toMatchObject({
        state: "active",
        currentAttempt: 1,
        fenceToken: crash.fenceToken,
        result: null,
        error: null,
      });
      expect(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM workhorse.attempt_history WHERE job_id = $1",
            [crashedId],
          )
        ).rows[0]!.count,
      ).toBe(0);

      await pool.query(
        "UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 ms' WHERE job_id = $1",
        [crashedId],
      );
      expect(await queue.recoverExpired(100, 0)).toBe(1);
      await expect(admin.getJob(crashedId)).resolves.toMatchObject({
        state: expectedState,
        currentAttempt: expectedAttempt,
        result: null,
      });

      const recoveredRuntime = await pool.query<{
        state: string;
        current_attempt: number;
        fence_token: string;
        worker_id: string | null;
        expires_at: Date | null;
      }>(
        `SELECT state, current_attempt, fence_token::text, worker_id, expires_at
         FROM workhorse.job_runtime WHERE job_id = $1`,
        [crashedId],
      );
      const expectedRuntimeRows =
        expectedState === "ready"
          ? [
              {
                state: "ready",
                current_attempt: 2,
                fence_token: "0",
                worker_id: null,
                expires_at: null,
              },
            ]
          : [];
      expect(recoveredRuntime.rows).toEqual(expectedRuntimeRows);
    },
  );

  it("keeps run maintenance cadence independent from active handlers", async () => {
    const release = deferred();
    await queue.enqueue("maintenance-during-handler", {});
    const tick = vi.spyOn(queue, "tick");
    const worker = new Worker(queue, {
      workerId: "maintenance-during-handler-worker",
      heartbeatMs: 50,
      leaseMs: 500,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 1_000,
      pollMs: 1_000,
    }).handle("maintenance-during-handler", async () => {
      await release.promise;
      return null;
    });

    try {
      const running = worker.run();
      await vi.waitFor(() => expect(worker.runtimeState().activeSlots).toBe(1));
      await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(2), { timeout: 500 });

      worker.stop();
      release.resolve();
      await expect(running).resolves.toBeUndefined();
    } finally {
      tick.mockRestore();
    }
  });

  it("does not wake maintenance when a job notification wakes dispatch", async () => {
    let notify: (() => void) | undefined;
    const subscribe = vi
      .spyOn(queue, "subscribeToJobNotifications")
      .mockImplementation(async (_queueName, onJobsAvailable) => {
        notify = onJobsAvailable;
        return { close: async () => undefined };
      });
    const worker = new Worker(queue, {
      workerId: "notification-dispatch-only",
      pollMs: 15_000,
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 100,
      registryIntervalMs: 0,
    });
    const maintenanceTimes: number[] = [];
    const privateWorker = worker as unknown as { runMaintenance(): Promise<void> };
    const originalRunMaintenance = privateWorker.runMaintenance.bind(worker);
    const runMaintenance = vi
      .spyOn(privateWorker, "runMaintenance")
      .mockImplementation(async () => {
        maintenanceTimes.push(Date.now());
        await originalRunMaintenance();
      });

    const running = worker.run();
    let notificationLoad: NodeJS.Timeout | undefined;
    try {
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
      expect(runMaintenance).toHaveBeenCalledOnce();
      expect(notify).toBeDefined();
      notificationLoad = setInterval(() => notify?.(), 10);
      await vi.waitFor(() => expect(runMaintenance).toHaveBeenCalledTimes(3), { timeout: 500 });
      clearInterval(notificationLoad);
      notificationLoad = undefined;

      for (let index = 1; index < maintenanceTimes.length; index += 1) {
        expect(maintenanceTimes[index]! - maintenanceTimes[index - 1]!).toBeGreaterThanOrEqual(80);
      }
    } finally {
      if (notificationLoad) clearInterval(notificationLoad);
      worker.stop();
      await running;
      subscribe.mockRestore();
    }
  });

  it("runs tick and scheduled maintenance tasks on independent cadences with phase telemetry", async () => {
    const jobId = await queue.enqueue(
      "scheduled-worker",
      { ok: true },
      { runAt: new Date(Date.now() + 80) },
    );
    await sleep(100);
    await queue.syncMaintenancePolicy({ timezone: "UTC", historyRetentionLocalTime: "00:00" });

    const telemetry: ReturnType<Worker["maintenanceTelemetry"]> = [];
    const worker = new Worker(queue, {
      workerId: "worker-maintenance",
      maintenanceIntervalMs: 100,
      maintenanceTaskPollMs: 1_000,
      onMaintenance: (event) => telemetry.push(event),
    }).handle("scheduled-worker", () => ({ ok: true }));
    expect(await worker.runOnce()).toBe(true);
    expect((await admin.getJob(jobId))?.state).toBe("succeeded");
    expect(telemetry.map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
      // Statistics roll up before retention so the same pass can reclaim the history it summarized.
      "statistics_rollup:stat_rollup",
      "statistics_rollup:stat_retention",
      "background_tasks:history_partitions",
      "background_tasks:event_retention",
      "background_tasks:attempt_retention",
      "background_tasks:schedule_occurrences",
      "background_tasks:enqueue_idempotency",
      "background_tasks:released_dependencies",
      "background_tasks:terminal_jobs",
      "background_tasks:worker_registry",
    ]);
    expect(worker.maintenanceTelemetry()).toEqual(telemetry);

    const firstPassLength = telemetry.length;
    await sleep(110);
    expect(await worker.runOnce()).toBe(false);
    expect(telemetry.slice(firstPassLength).map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
    ]);
  });

  it("keeps idle claim polling on pollMs despite more frequent maintenance wakeups", async () => {
    const tickResults: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
    ];
    const partitionResults: MaintenancePhaseResult[] = [
      {
        phase: "history_partitions",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const retentionResults: MaintenancePhaseResult[] = [
      {
        phase: "event_retention",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "attempt_retention",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "schedule_occurrences",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const terminalResults: MaintenancePhaseResult[] = [
      {
        phase: "enqueue_idempotency",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "released_dependencies",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "terminal_jobs",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValue(tickResults);
    const prepareHistoryPartitions = vi
      .spyOn(queue, "prepareHistoryPartitions")
      .mockResolvedValue(partitionResults);
    const retainHistory = vi.spyOn(queue, "retainHistory").mockResolvedValue(retentionResults);
    const pruneTerminalStorage = vi
      .spyOn(queue, "pruneTerminalStorage")
      .mockResolvedValue(terminalResults);
    const claim = vi.spyOn(queue, "claim").mockResolvedValue(null);

    try {
      const worker = new Worker(queue, {
        workerId: "idle-cadence",
        pollMs: 15_000,
        maintenanceIntervalMs: 1_000,
        maintenanceTaskPollMs: 60_000,
      });

      await worker.runOnce();
      now.mockReturnValue(1_000);
      await worker.runOnce();
      now.mockReturnValue(2_000);
      await worker.runOnce();
      now.mockReturnValue(14_999);
      await worker.runOnce();

      expect(tick).toHaveBeenCalledTimes(4);
      expect(claim).toHaveBeenCalledTimes(1);

      now.mockReturnValue(15_000);
      await worker.runOnce();
      expect(claim).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      prepareHistoryPartitions.mockRestore();
      retainHistory.mockRestore();
      pruneTerminalStorage.mockRestore();
      claim.mockRestore();
    }
  });

  it("wakes idle dispatch when PostgreSQL notifies a matching queue", async () => {
    const handled: string[] = [];
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, {
      workerId: "notification-dispatch",
      pollMs: 15_000,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-dispatch", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
      await queue.enqueue("notification-dispatch", { message: "prompt" });

      await vi.waitFor(() => expect(handled).toEqual(["prompt"]), { timeout: 1_000 });
    } finally {
      worker.stop();
      await running;
      claim.mockRestore();
    }
  });

  it("wakes a policy-blocked worker when another process releases capacity", async () => {
    const queueName = `capacity-wake-${randomUUID()}`;
    const policyQueue = new Queue(pool, queueName);
    await policyQueue.syncConcurrencyPolicies("test", [{ queue: queueName, maxActive: 1 }]);
    const firstId = await policyQueue.enqueue("capacity-wake", { ordinal: 1 });
    const secondId = await policyQueue.enqueue("capacity-wake", { ordinal: 2 });
    const held = await policyQueue.claim("capacity-holder", { queue: queueName });
    expect(held?.id).toBe(firstId);

    const handled: string[] = [];
    const worker = new Worker(policyQueue, {
      workerId: "capacity-waiter",
      pollMs: 15_000,
      registryIntervalMs: 0,
    }).handle("capacity-wake", (_payload, context) => {
      handled.push(context.job.id);
      return null;
    });

    const running = worker.run();
    try {
      await sleep(100);
      expect(handled).toEqual([]);
      await expect(policyQueue.complete(held!, "capacity-holder", null)).resolves.toBe(true);
      await vi.waitFor(() => expect(handled).toEqual([secondId]), { timeout: 1_000 });
    } finally {
      worker.stop();
      await running;
    }
  });

  it("latches a notification that arrives while an empty claim is in flight", async () => {
    const claimStarted = deferred();
    const releaseEmptyClaim = deferred();
    const handled: string[] = [];
    const claim = vi.spyOn(queue, "claim").mockImplementationOnce(async () => {
      claimStarted.resolve();
      await releaseEmptyClaim.promise;
      return null;
    });
    const worker = new Worker(queue, {
      workerId: "notification-during-claim",
      pollMs: 15_000,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-during-claim", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      await claimStarted.promise;
      await vi.waitFor(async () => {
        const listeners = await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND state = 'idle'
              AND query = 'LISTEN workhorse_jobs'`,
        );
        expect(listeners.rows[0]?.count).toBeGreaterThan(0);
      });
      await queue.enqueue("notification-during-claim", { message: "latched" });
      releaseEmptyClaim.resolve();

      await vi.waitFor(() => expect(handled).toEqual(["latched"]), { timeout: 1_000 });
    } finally {
      worker.stop();
      releaseEmptyClaim.resolve();
      await running;
      claim.mockRestore();
    }
  });

  it("reconnects notification dispatch after PostgreSQL terminates the listener", async () => {
    const handled: string[] = [];
    const notificationErrors: unknown[] = [];
    const worker = new Worker(queue, {
      workerId: "notification-reconnect",
      pollMs: 15_000,
      registryIntervalMs: 0,
      onNotificationError: (error) => notificationErrors.push(error),
    }).handle<{ message: string }>("notification-reconnect", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      const listenerPid = await vi.waitFor(async () => {
        const listeners = await pool.query<{ pid: number }>(
          `SELECT pid
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'idle'
              AND query = 'LISTEN workhorse_jobs'
            ORDER BY backend_start DESC
            LIMIT 1`,
        );
        expect(listeners.rows[0]?.pid).toBeDefined();
        return listeners.rows[0]!.pid;
      });
      await pool.query("SELECT pg_terminate_backend($1)", [listenerPid]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      await queue.enqueue("notification-reconnect", { message: "after reconnect" });

      await vi.waitFor(() => expect(handled).toEqual(["after reconnect"]), { timeout: 1_000 });
      expect(notificationErrors).toHaveLength(1);
      expect(notificationErrors[0]).toBeInstanceOf(Error);
    } finally {
      worker.stop();
      await running;
    }
  });

  it("keeps bounded polling as the fallback when the database cannot LISTEN", async () => {
    const pollingQueue = new Queue({ query: pool.query.bind(pool) });
    const handled: string[] = [];
    const claim = vi.spyOn(pollingQueue, "claim");
    const worker = new Worker(pollingQueue, {
      workerId: "notification-fallback",
      pollMs: 100,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-fallback", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
      await queue.enqueue("notification-fallback", { message: "polled" });

      await vi.waitFor(() => expect(handled).toEqual(["polled"]), { timeout: 1_000 });
    } finally {
      worker.stop();
      await running;
      claim.mockRestore();
    }
  });

  it("starts polling and stops while the initial LISTEN connection is still pending", async () => {
    const pendingListenerDatabase = {
      query: pool.query.bind(pool),
      connect: () => new Promise<never>(() => undefined),
    };
    const pendingQueue = new Queue(pendingListenerDatabase);
    const claim = vi.spyOn(pendingQueue, "claim");
    const worker = new Worker(pendingQueue, {
      workerId: "notification-pending-listener",
      pollMs: 100,
      registryIntervalMs: 0,
    });

    const running = worker.run();
    await vi.waitFor(() => expect(claim).toHaveBeenCalled(), { timeout: 1_000 });
    worker.stop();
    await expect(running).resolves.toBeUndefined();
    claim.mockRestore();
  });

  it("starts polling and stops while the initial LISTEN query is still pending", async () => {
    const listener = {
      query: vi.fn<() => Promise<never>>(() => new Promise<never>(() => undefined)),
      on: vi.fn<() => void>(),
      removeListener: vi.fn<() => void>(),
      release: vi.fn<(error?: Error) => void>(),
    };
    const pendingListenerDatabase = {
      query: pool.query.bind(pool),
      connect: async () => listener,
    };
    const pendingQueue = new Queue(pendingListenerDatabase);
    const claim = vi.spyOn(pendingQueue, "claim");
    const worker = new Worker(pendingQueue, {
      workerId: "notification-pending-listen",
      pollMs: 100,
      registryIntervalMs: 0,
    });

    const running = worker.run();
    await vi.waitFor(() => expect(claim).toHaveBeenCalled(), { timeout: 1_000 });
    worker.stop();
    await expect(running).resolves.toBeUndefined();
    expect(listener.release).toHaveBeenCalledWith(expect.any(Error));
    claim.mockRestore();
  });

  it("keeps single-connection pools polling-only so LISTEN cannot block claims", async () => {
    const singleConnectionPool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      expect(new Queue(singleConnectionPool).supportsJobNotifications()).toBe(false);
    } finally {
      await singleConnectionPool.end();
    }
  });

  it("notifies only the queue whose scheduled work was promoted", async () => {
    const queueName = `notification-routing-${randomUUID()}`;
    const handled: string[] = [];
    const claim = vi.spyOn(queue, "claim");
    const worker = new Worker(queue, {
      queue: queueName,
      workerId: "notification-routing",
      pollMs: 15_000,
      maintenanceIntervalMs: 10_000,
      registryIntervalMs: 0,
    }).handle<{ message: string }>("notification-routing", ({ message }) => {
      handled.push(message);
      return null;
    });

    const running = worker.run();
    try {
      await vi.waitFor(() => expect(claim).toHaveBeenCalled());
      const initialClaimCount = claim.mock.calls.length;
      await queue.enqueue("other-queue-notification", null, {
        queue: `${queueName}-other`,
        runAt: new Date(Date.now() + 100),
      });
      await sleep(120);
      await queue.promote();
      await sleep(50);
      expect(claim).toHaveBeenCalledTimes(initialClaimCount);

      await queue.enqueue(
        "notification-routing",
        { message: "promoted" },
        { queue: queueName, runAt: new Date(Date.now() + 100) },
      );
      await sleep(120);
      await queue.promote();
      await vi.waitFor(() => expect(handled).toEqual(["promoted"]), { timeout: 1_000 });
    } finally {
      worker.stop();
      await running;
      claim.mockRestore();
    }
  });

  it("shares one notification connection across workers backed by the same pool", async () => {
    const firstQueue = new Queue(pool, `notification-shared-${randomUUID()}`);
    const secondQueue = new Queue(pool, `notification-shared-${randomUUID()}`);
    const firstClaim = vi.spyOn(firstQueue, "claim");
    const secondClaim = vi.spyOn(secondQueue, "claim");
    const first = new Worker(firstQueue, {
      workerId: "notification-shared-first",
      pollMs: 15_000,
      registryIntervalMs: 0,
    });
    const second = new Worker(secondQueue, {
      workerId: "notification-shared-second",
      pollMs: 15_000,
      registryIntervalMs: 0,
    });

    const firstRun = first.run();
    const secondRun = second.run();
    try {
      await vi.waitFor(() => {
        expect(firstClaim).toHaveBeenCalled();
        expect(secondClaim).toHaveBeenCalled();
      });
      const listeners = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'idle'
            AND query = 'LISTEN workhorse_jobs'`,
      );

      expect(listeners.rows).toEqual([{ count: 1 }]);
    } finally {
      first.stop();
      second.stop();
      await Promise.all([firstRun, secondRun]);
      firstClaim.mockRestore();
      secondClaim.mockRestore();
    }

    const listenersAfterStop = await pool.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'idle'
          AND query = 'LISTEN workhorse_jobs'`,
    );
    expect(listenersAfterStop.rows).toEqual([{ count: 0 }]);
  });

  it("does not scan recurring schedules when the tick advisory lock is skipped", async () => {
    const skippedTick: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
    ];
    const ownedTick: MaintenancePhaseResult[] = skippedTick.map((result) => ({
      ...result,
      skippedLock: false,
    }));
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValueOnce(skippedTick);
    const prepareHistoryPartitions = vi
      .spyOn(queue, "prepareHistoryPartitions")
      .mockResolvedValue([]);
    const retainHistory = vi.spyOn(queue, "retainHistory").mockResolvedValue([]);
    const pruneTerminalStorage = vi.spyOn(queue, "pruneTerminalStorage").mockResolvedValue([]);
    const fireDueSchedules = vi.spyOn(queue, "fireDueSchedules").mockResolvedValue();
    const claim = vi.spyOn(queue, "claim").mockResolvedValue(null);

    try {
      const worker = new Worker(queue, {
        workerId: "schedule-lock-gate",
        pollMs: 15_000,
        maintenanceIntervalMs: 100,
        scheduleNamespaces: ["integration"],
      });

      await worker.runOnce();
      expect(fireDueSchedules).not.toHaveBeenCalled();

      tick.mockResolvedValueOnce(ownedTick);
      now.mockReturnValue(100);
      await worker.runOnce();
      expect(fireDueSchedules).toHaveBeenCalledOnce();
      expect(fireDueSchedules.mock.calls[0]?.[0]).toEqual(["integration"]);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      prepareHistoryPartitions.mockRestore();
      retainHistory.mockRestore();
      pruneTerminalStorage.mockRestore();
      fireDueSchedules.mockRestore();
      claim.mockRestore();
    }
  });

  it("runs a registered handler end to end", async () => {
    const id = await queue.enqueue("sum", { a: 2, b: 3 });
    const worker = new Worker(queue, { workerId: "worker-a" }).handle<
      { a: number; b: number },
      { total: number }
    >("sum", ({ a, b }) => ({ total: a + b }));
    expect(await worker.runOnce()).toBe(true);
    expect((await admin.getJob<{ total: number }>(id))?.result).toEqual({ total: 5 });
  });

  it.each([
    ["afterClaim", 0, "active"],
    ["beforeHandler", 0, "active"],
    ["afterHandler", 1, "active"],
    ["beforeComplete", 1, "active"],
    ["afterComplete", 1, "succeeded"],
  ] as const)("models a crash at %s", async (failpoint, expectedEffects, expectedState) => {
    const id = await queue.enqueue("work", {}, { maxAttempts: 2 });
    let effects = 0;
    const worker = new Worker(queue, {
      workerId: "crashing-worker",
      leaseMs: 100,
      heartbeatMs: 50,
      failpoint,
    }).handle("work", () => {
      effects += 1;
      return { ok: true };
    });

    await expect(worker.runOnce()).rejects.toBeInstanceOf(InjectedCrashError);
    expect(effects).toBe(expectedEffects);
    expect((await admin.getJob(id))?.state).toBe(expectedState);

    if (expectedState === "active") await sleep(130);
    const recovered = await queue.recoverExpired();
    const stateAfterRecovery = (await admin.getJob(id))?.state;
    expect(recovered).toBe(expectedState === "active" ? 1 : 0);
    expect(stateAfterRecovery).toBe(expectedState === "active" ? "ready" : "succeeded");
  });
  it("lets running workers drain work while a paused worker stops claiming until resumed", async () => {
    const handledBy: string[] = [];
    const pausedWorker = new Worker(queue, {
      workerId: "paused-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`paused:${sequence}`);
      return { sequence };
    });
    const runningWorker = new Worker(queue, {
      workerId: "running-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`running:${sequence}`);
      return { sequence };
    });
    const initialIds: string[] = [];
    for (const sequence of [1, 2, 3]) {
      initialIds.push(await queue.enqueue("pause-control", { sequence }));
    }

    pausedWorker.pause();
    expect(pausedWorker.isPaused()).toBe(true);
    expect(await pausedWorker.runOnce()).toBe(false);
    while (await runningWorker.runOnce()) {
      // Drain all ready work without allowing the paused worker to compete for claims.
    }

    expect(handledBy).toEqual(["running:1", "running:2", "running:3"]);
    await expect(Promise.all(initialIds.map((id) => admin.getJob(id)))).resolves.toEqual(
      initialIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
    );

    const resumedId = await queue.enqueue("pause-control", { sequence: 4 });
    pausedWorker.resume();
    expect(pausedWorker.isPaused()).toBe(false);
    expect(await pausedWorker.runOnce()).toBe(true);
    expect(handledBy.at(-1)).toBe("paused:4");
    await expect(admin.getJob(resumedId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("allows an active job to finish after its worker is paused", async () => {
    let releaseHandler!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "pause-in-flight",
      heartbeatMs: 50,
      leaseMs: 500,
    }).handle("pause-in-flight", async () => {
      markStarted();
      await released;
      return { completedWhilePaused: true };
    });
    const jobId = await queue.enqueue("pause-in-flight", {});

    const run = worker.runOnce();
    await started;
    worker.pause();
    releaseHandler();

    await expect(run).resolves.toBe(true);
    expect(worker.isPaused()).toBe(true);
    await expect(admin.getJob(jobId)).resolves.toMatchObject({
      state: "succeeded",
      result: { completedWhilePaused: true },
    });
    expect(await worker.runOnce()).toBe(false);
  });
});

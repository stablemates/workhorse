import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedTask, WorkhorseAdapter, WorkerProcessSignal } from "../src/index.js";
import { Worker, defineWorkerProcess, runWorkerProcess, startWorkerProcess } from "../src/index.js";
import type { WorkerQueueApi } from "../src/worker.js";
import { observeWorkerFailure } from "../src/worker-failure.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeWorker {
  readonly runResult = deferred<void>();
  readonly run = vi.fn<() => Promise<void>>(() => this.runResult.promise);
  readonly stop = vi.fn<() => void>(() => {
    if (this.drainOnStop) this.runResult.resolve();
  });
  readonly handle = vi.fn<() => FakeWorker>(() => this);

  constructor(private readonly drainOnStop = true) {}
}

class FakeSignalSource {
  private readonly listeners = new Map<WorkerProcessSignal, Set<() => void>>();

  on(signal: WorkerProcessSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: WorkerProcessSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: WorkerProcessSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  count(signal: WorkerProcessSignal): number {
    return this.listeners.get(signal)?.size ?? 0;
  }
}

function fixture(workers: FakeWorker[], close = vi.fn<() => Promise<void>>(async () => undefined)) {
  let index = 0;
  const adapter = {
    createWorker: vi.fn<WorkhorseAdapter["createWorker"]>(
      () => workers[index++] as unknown as Worker,
    ),
    close,
  } as unknown as WorkhorseAdapter;
  const definition = defineWorkerProcess({
    adapter: () => adapter,
    workers: workers.map(() => ({ configure: vi.fn<(worker: Worker) => void>() })),
    logger: {
      info: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string, error?: unknown) => void>(),
    },
  });
  return { adapter, close, definition };
}

describe("dedicated worker process runtime", () => {
  it("starts configured workers and closes resources after an idempotent graceful shutdown", async () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    const { adapter, close, definition } = fixture(workers);
    const runtime = await startWorkerProcess(definition);

    expect(adapter.createWorker).toHaveBeenCalledTimes(2);
    expect(workers.every((worker) => worker.run.mock.calls.length === 1)).toBe(true);

    const first = runtime.shutdown();
    const second = runtime.shutdown();
    await Promise.all([first, second, runtime.completed]);

    expect(workers.every((worker) => worker.stop.mock.calls.length === 1)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops sibling workers and rejects when one worker fails unexpectedly", async () => {
    const workers = [new FakeWorker(false), new FakeWorker()];
    const failure = new Error("dispatch failed");
    const { close, definition } = fixture(workers);
    const runtime = await startWorkerProcess(definition);

    workers[0]!.runResult.reject(failure);

    await expect(runtime.completed).rejects.toBe(failure);
    expect(workers[0]!.stop).toHaveBeenCalledOnce();
    expect(workers[1]!.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the adapter when worker configuration throws", async () => {
    const worker = new FakeWorker();
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const adapter = {
      createWorker: vi.fn<WorkhorseAdapter["createWorker"]>(() => worker as unknown as Worker),
      close,
    } as unknown as WorkhorseAdapter;
    const failure = new Error("bad handler configuration");
    const configure = (): void => {
      throw failure;
    };

    await expect(
      startWorkerProcess(
        defineWorkerProcess({
          adapter: () => adapter,
          workers: [{ configure }],
        }),
      ),
    ).rejects.toBe(failure);
    expect(worker.run).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("turns the first termination signal into a graceful drain", async () => {
    const worker = new FakeWorker();
    const signals = new FakeSignalSource();
    const forceExit = vi.fn<(code: number) => void>();
    const { close, definition } = fixture([worker]);

    const running = runWorkerProcess(definition, { signalSource: signals, forceExit });
    await vi.waitFor(() => expect(signals.count("SIGTERM")).toBe(1));
    signals.emit("SIGTERM");
    await running;

    expect(worker.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(forceExit).not.toHaveBeenCalled();
    expect(signals.count("SIGINT")).toBe(0);
    expect(signals.count("SIGTERM")).toBe(0);
  });

  it("captures termination signals received during asynchronous startup", async () => {
    const worker = new FakeWorker();
    const signals = new FakeSignalSource();
    const adapterReady = deferred<WorkhorseAdapter>();
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const adapter = {
      createWorker: vi.fn<WorkhorseAdapter["createWorker"]>(() => worker as unknown as Worker),
      close,
    } as unknown as WorkhorseAdapter;
    const definition = defineWorkerProcess({
      adapter: () => adapterReady.promise,
      workers: [{ configure: vi.fn<(worker: Worker) => void>() }],
      logger: {
        info: vi.fn<(message: string) => void>(),
        error: vi.fn<(message: string, error?: unknown) => void>(),
      },
    });

    const running = runWorkerProcess(definition, {
      signalSource: signals,
      forceExit: vi.fn<(code: number) => void>(),
    });
    expect(signals.count("SIGTERM")).toBe(1);
    signals.emit("SIGTERM");
    adapterReady.resolve(adapter);
    await running;

    expect(worker.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("serves probe-only liveness and readiness without application ingress", async () => {
    const worker = new FakeWorker(false);
    const { definition } = fixture([worker]);
    const runtime = await startWorkerProcess({
      ...definition,
      probes: { port: 0 },
    });

    expect(runtime.probeUrl).not.toBeNull();
    await expect(
      fetch(`${runtime.probeUrl}/livez`).then((response) => response.status),
    ).resolves.toBe(200);
    await expect(
      fetch(`${runtime.probeUrl}/readyz`).then((response) => response.status),
    ).resolves.toBe(200);

    const shutdown = runtime.shutdown();
    await expect(
      fetch(`${runtime.probeUrl}/readyz`).then((response) => response.status),
    ).resolves.toBe(503);
    await expect(
      fetch(`${runtime.probeUrl}/livez`).then((response) => response.status),
    ).resolves.toBe(200);
    worker.runResult.resolve();
    await shutdown;
  });

  it("forces conventional signal exit on a second termination signal", async () => {
    const worker = new FakeWorker(false);
    const signals = new FakeSignalSource();
    const forceExit = vi.fn<(code: number) => void>();
    const { definition } = fixture([worker]);

    const running = runWorkerProcess(definition, { signalSource: signals, forceExit });
    await vi.waitFor(() => expect(signals.count("SIGTERM")).toBe(1));
    signals.emit("SIGTERM");
    signals.emit("SIGINT");

    expect(forceExit).toHaveBeenCalledWith(130);
    worker.runResult.resolve();
    await running;
  });

  it("forces exit when graceful shutdown exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(false);
      const signals = new FakeSignalSource();
      const forceExit = vi.fn<(code: number) => void>();
      const { definition } = fixture([worker]);

      const running = runWorkerProcess(definition, {
        signalSource: signals,
        forceExit,
        shutdownTimeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(0);
      signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(50);

      expect(forceExit).toHaveBeenCalledWith(1);
      worker.runResult.resolve();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds sibling drain after an unexpected worker failure", async () => {
    vi.useFakeTimers();
    try {
      const workers = [new FakeWorker(false), new FakeWorker(false)];
      const failure = new Error("worker loop failed");
      const signals = new FakeSignalSource();
      const forceExit = vi.fn<(code: number) => void>();
      const { definition } = fixture(workers);

      const running = runWorkerProcess(definition, {
        signalSource: signals,
        forceExit,
        shutdownTimeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(0);
      workers[0]!.runResult.reject(failure);
      await vi.advanceTimersByTimeAsync(50);

      expect(forceExit).toHaveBeenCalledWith(1);
      workers[1]!.runResult.resolve();
      await expect(running).rejects.toBe(failure);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid process definitions before allocating resources", async () => {
    await expect(
      startWorkerProcess({ adapter: vi.fn<() => WorkhorseAdapter>(), workers: [] }),
    ).rejects.toThrow("at least one worker");
    await expect(
      runWorkerProcess(
        {
          adapter: vi.fn<() => WorkhorseAdapter>(),
          workers: [{ configure: vi.fn<(worker: Worker) => void>() }],
          shutdownTimeoutMs: 0,
        },
        { signalSource: new FakeSignalSource(), forceExit: vi.fn<(code: number) => void>() },
      ),
    ).rejects.toThrow("shutdownTimeoutMs");
  });
});

function stalledTask(id = "stalled", type = "stalled"): ClaimedTask {
  return {
    id,
    queue: "default",
    type,
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

// One real worker whose only handler ignores cancellation, over a queue that fails on demand.
function stalledWorkerFixture(failing: "claim" | "maintenance", failure: unknown) {
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  const calls = { claims: 0, ticks: 0 };
  const queue = {
    defaultQueue: "default",
    claim: async () => {
      calls.claims += 1;
      if (calls.claims === 1) return stalledTask();
      if (failing === "claim") throw failure;
      return null;
    },
    heartbeatStatus: async () => "accepted",
    complete: async () => true,
    fail: async () => "failed",
    tick: async () => {
      calls.ticks += 1;
      if (failing === "maintenance" && calls.ticks > 1) throw failure;
      return [];
    },
    runMaintenance: async () => [],
  } as unknown as WorkerQueueApi;
  const worker = new Worker(queue, {
    concurrency: 2,
    registryIntervalMs: 0,
    maintenanceIntervalMs: 100,
    maintenanceRoutinePollMs: 100,
    pollMs: 5,
  });
  const adapter = {
    createWorker: vi.fn<WorkhorseAdapter["createWorker"]>(() => worker),
    close: vi.fn<() => Promise<void>>(async () => undefined),
  } as unknown as WorkhorseAdapter;
  const definition = defineWorkerProcess({
    adapter: () => adapter,
    workers: [
      {
        configure: (configured: Worker) => {
          configured.handle("stalled", async () => {
            handlerStarted.resolve();
            await releaseHandler.promise;
            return null;
          });
        },
      },
    ],
    probes: { port: 0 },
    logger: {
      info: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string, error?: unknown) => void>(),
    },
  });
  return { calls, definition, handlerStarted, releaseHandler, worker };
}

async function probeStatus(url: string | null, path: string): Promise<number> {
  return fetch(`${url}${path}`).then((response) => response.status);
}

describe("fatal worker errors while a handler ignores cancellation", () => {
  for (const failing of ["claim", "maintenance"] as const) {
    it(`reports a ${failing} failure to readiness before the stalled handler drains`, async () => {
      const failure = new Error(`PostgreSQL unavailable during ${failing}`);
      const { calls, definition, handlerStarted, releaseHandler, worker } = stalledWorkerFixture(
        failing,
        failure,
      );
      const runtime = await startWorkerProcess(definition);
      await handlerStarted.promise;

      await expect(runtime.failure).resolves.toBe(failure);
      expect(worker.runtimeState()).toMatchObject({ activeSlots: 1, draining: true });
      expect(await probeStatus(runtime.probeUrl, "/readyz")).toBe(503);
      expect(await probeStatus(runtime.probeUrl, "/livez")).toBe(200);

      // Neither dispatch nor maintenance touches the queue again while the handler stalls.
      const observed = { ...calls };
      await sleep(250);
      expect(calls).toEqual(observed);

      releaseHandler.resolve();
      await expect(runtime.completed).rejects.toBe(failure);
    });
  }

  it("reports a maintenance rejection with undefined as a failure", async () => {
    const { definition, handlerStarted, releaseHandler } = stalledWorkerFixture(
      "maintenance",
      undefined,
    );
    const runtime = await startWorkerProcess(definition);
    await handlerStarted.promise;

    const failure = await runtime.failure;
    expect(failure.message).toBe("undefined");
    expect(await probeStatus(runtime.probeUrl, "/readyz")).toBe(503);

    releaseHandler.resolve();
    await expect(runtime.completed).rejects.toBe(failure);
  });

  it("starts the failure deadline before the stalled handler drains", async () => {
    const failure = new Error("PostgreSQL unavailable during claim");
    const { definition, handlerStarted, releaseHandler } = stalledWorkerFixture("claim", failure);
    const forceExit = vi.fn<(code: number) => void>();

    const running = runWorkerProcess(definition, {
      signalSource: new FakeSignalSource(),
      forceExit,
      shutdownTimeoutMs: 50,
    });
    await handlerStarted.promise;
    await vi.waitFor(() => expect(forceExit).toHaveBeenCalledWith(1), { timeout: 2_000 });

    releaseHandler.resolve();
    await expect(running).rejects.toBe(failure);
  });

  it("reports a settlement failure that the worker first observes during a stop drain", async () => {
    const failure = new Error("PostgreSQL unavailable during completion");
    const handlerStarted = deferred();
    const releaseHandler = deferred();
    const finishCompleting = deferred();
    const finishSettling = deferred();
    const completed: string[] = [];
    const tasks = [
      stalledTask(),
      stalledTask("completes", "completes"),
      stalledTask("settles", "settles"),
    ];
    const queue = {
      defaultQueue: "default",
      claim: async () => tasks.shift() ?? null,
      heartbeatStatus: async () => "accepted",
      complete: async (task: ClaimedTask) => {
        if (task.id === "settles") throw failure;
        completed.push(task.id);
        return true;
      },
      fail: async () => "failed",
      tick: async () => [],
      runMaintenance: async () => [],
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { concurrency: 3, registryIntervalMs: 0, pollMs: 5 })
      .handle("stalled", async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return null;
      })
      .handle("completes", async () => {
        await finishCompleting.promise;
        return null;
      })
      .handle("settles", async () => {
        await finishSettling.promise;
        return null;
      });
    const reported: unknown[] = [];
    observeWorkerFailure(worker, (error) => reported.push(error));

    const running = worker.run();
    await handlerStarted.promise;
    // The next settlement ends the dispatch loop, so the failure arrives during the drain.
    worker.stop();
    finishCompleting.resolve();
    await vi.waitFor(() => expect(completed).toEqual(["completes"]));
    finishSettling.resolve();

    await vi.waitFor(() => expect(reported).toEqual([failure]));
    expect(worker.runtimeState()).toMatchObject({ activeSlots: 1, draining: true });
    releaseHandler.resolve();
    await expect(running).rejects.toBe(failure);
  });
});

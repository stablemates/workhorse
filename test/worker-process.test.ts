import { describe, expect, it, vi } from "vitest";
import type { WorkhorseAdapter, Worker, WorkerProcessSignal } from "../src/index.js";
import { defineWorkerProcess, runWorkerProcess, startWorkerProcess } from "../src/index.js";

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

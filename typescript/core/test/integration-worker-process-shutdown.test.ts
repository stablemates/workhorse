import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  type HandlerContext,
  type Json,
  type Queue,
  type WorkerProcessSignal,
  type WorkhorseAdapter,
  Worker,
  defineWorkerProcess,
  runWorkerProcess,
} from "../src/index.js";
import { abortWorkerHandlers } from "../src/worker-failure.js";
import { workerCompletionPrepare } from "../src/worker-internal.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { admin, pool, queue } = createIntegrationTestContext(import.meta.url);

class SignalSource {
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
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function taskState(taskId: string): Promise<{ state: string; currentAttempt: number }> {
  const task = await admin.getTask(taskId);
  return { state: task!.state, currentAttempt: task!.currentAttempt };
}

async function taskEvents(taskId: string): Promise<string[]> {
  const result = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM workhorse.task_event WHERE task_id = $1
     ORDER BY occurred_at, event_id`,
    [taskId],
  );
  return result.rows.map((row) => row.event_type);
}

// Runs one real worker in runWorkerProcess, sends SIGTERM once the handler started, and returns the
// exit code that the runner gave at the end of its grace. `afterExit` lets a handler that ignored
// the abort return, so the runner can settle.
async function stopAtGrace(
  queueName: string,
  configure: (worker: Worker, started: () => void) => void,
  afterExit: () => void = () => undefined,
  workerQueue: Queue = queue,
): Promise<number> {
  let started!: () => void;
  const handlerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let exited!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    exited = resolve;
  });
  const signals = new SignalSource();
  const definition = defineWorkerProcess({
    adapter: () =>
      ({
        createWorker: () =>
          new Worker(workerQueue, {
            workerId: `shutdown-${randomUUID()}`,
            queue: queueName,
            leaseMs: 2_000,
            pollMs: 5,
            concurrency: 2,
          }),
        close: async () => undefined,
      }) as unknown as WorkhorseAdapter,
    workers: [{ configure: (worker) => configure(worker, started) }],
    logger: {
      info: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string, error?: unknown) => void>(),
    },
  });
  const running = runWorkerProcess(definition, {
    signalSource: signals,
    forceExit: exited,
    shutdownTimeoutMs: 100,
  });
  await handlerStarted;
  signals.emit("SIGTERM");
  const code = await exitCode;
  afterExit();
  await running.catch(() => undefined);
  return code;
}

// SM-1919: at the end of the shutdown grace, runWorkerProcess exited the process, and lease
// recovery charged the attempt of each task that still ran. The runner now aborts the handlers
// first. A handler that reacts gives its task back, and the task keeps its attempt.
describe("runWorkerProcess at the end of its shutdown grace", () => {
  it("releases the task of a handler that throws after the abort", async () => {
    const queueName = `shutdown-release-${randomUUID()}`;
    const taskId = await queue.enqueue("stopping", null, { queue: queueName, maxAttempts: 1 });
    let reason: unknown;

    const code = await stopAtGrace(queueName, (worker, started) => {
      worker.handle("stopping", async (_payload: Json, context: HandlerContext) => {
        started();
        await untilAborted(context.signal);
        reason = context.signal.reason;
        throw context.signal.reason;
      });
    });

    expect(code).toBe(0);
    expect((reason as Error).name).toBe("WorkerShutdownError");
    expect(await taskState(taskId)).toEqual({ state: "ready", currentAttempt: 1 });
    expect(await taskEvents(taskId)).toEqual(["enqueued", "claimed", "released"]);
  });

  it("completes the task of a handler that returns a value after the abort", async () => {
    const queueName = `shutdown-complete-${randomUUID()}`;
    const taskId = await queue.enqueue("stopping", null, { queue: queueName, maxAttempts: 1 });

    const code = await stopAtGrace(queueName, (worker, started) => {
      worker.handle("stopping", async (_payload: Json, context: HandlerContext) => {
        started();
        await untilAborted(context.signal);
        return { stoppedAt: "safe point" };
      });
    });

    expect(code).toBe(0);
    expect(await taskState(taskId)).toEqual({ state: "succeeded", currentAttempt: 1 });
  });

  // SM-2073: a release that fails after the abort leaves the task to lease recovery. The run then
  // rejects with that error, as in every other SDK, so the stop is not clean.
  it("exits with code 1 when the release after the abort fails", async () => {
    const queueName = `shutdown-release-fails-${randomUUID()}`;
    const taskId = await queue.enqueue("stopping", null, { queue: queueName, maxAttempts: 1 });
    const failingQueue = Object.create(queue) as Queue;
    failingQueue.releaseOwned = () => Promise.reject(new Error("release write failed"));

    const code = await stopAtGrace(
      queueName,
      (worker, started) => {
        worker.handle("stopping", async (_payload: Json, context: HandlerContext) => {
          started();
          await untilAborted(context.signal);
          throw context.signal.reason;
        });
      },
      () => undefined,
      failingQueue,
    );

    expect(code).toBe(1);
    expect((await taskState(taskId)).state).toBe("active");
  });

  // SM-2073: a completion that fails after the abort fails the stop too, as a failed release does.
  it("exits with code 1 when the completion after the abort fails", async () => {
    const queueName = `shutdown-complete-fails-${randomUUID()}`;
    const taskId = await queue.enqueue("stopping", null, { queue: queueName, maxAttempts: 1 });
    // The queue validates the result first and hands the worker a write, which fails here.
    Object.defineProperty(queue, workerCompletionPrepare, {
      configurable: true,
      value: async () => () => Promise.reject(new Error("completion write failed")),
    });

    let code: number;
    try {
      code = await stopAtGrace(queueName, (worker, started) => {
        worker.handle("stopping", async (_payload: Json, context: HandlerContext) => {
          started();
          await untilAborted(context.signal);
          return { stoppedAt: "safe point" };
        });
      });
    } finally {
      // The own property hid the prototype method; deleting it restores the queue.
      Reflect.deleteProperty(queue, workerCompletionPrepare);
    }

    expect(code).toBe(1);
    expect((await taskState(taskId)).state).toBe("active");
  });

  // SM-2073: the exit code tells a clean stop at the abort from a handler that kept running.
  it("exits with code 1 when a handler ignores the abort", async () => {
    const queueName = `shutdown-ignore-${randomUUID()}`;
    await queue.enqueue("stubborn", null, { queue: queueName, maxAttempts: 1 });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const code = await stopAtGrace(
      queueName,
      (worker, started) => {
        worker.handle("stubborn", async () => {
          started();
          await finished;
          return null;
        });
      },
      finish,
    );

    expect(code).toBe(1);
  });

  it("releases a batch member that still waits for its batch", async () => {
    const queueName = `shutdown-batch-${randomUUID()}`;
    const taskId = await queue.enqueue("waiting", null, { queue: queueName, maxAttempts: 1 });
    let batches = 0;

    const code = await stopAtGrace(queueName, (worker, started) => {
      worker.handleBatch("waiting", { maxSize: 2, lingerMs: 60_000 }, (items) => {
        batches += 1;
        return items.map(() => ({ status: "succeeded" as const, result: null }));
      });
      // The member waits for a second task that never comes, so the batch never runs.
      void (async () => {
        for (;;) {
          if ((await taskState(taskId)).state === "active") break;
          await sleep(5);
        }
        started();
      })();
    });

    expect(code).toBe(0);
    expect(batches).toBe(0);
    expect(await taskState(taskId)).toEqual({ state: "ready", currentAttempt: 1 });
  });
});

// ADR 0117: the abort decides the settlement only if it came before the handler returned. A stop
// that comes later cannot turn a failure of the handler's own into a release.
describe("a shutdown abort after the handler returned", () => {
  it("fails a result that the task cannot store under the retry policy", async () => {
    const queueName = `shutdown-late-${randomUUID()}`;
    const taskId = await queue.enqueue("late", null, { queue: queueName, maxAttempts: 1 });
    let abortedAtReturn: boolean | undefined;
    const worker: Worker = new Worker(queue, {
      workerId: `shutdown-late-${randomUUID()}`,
      queue: queueName,
      registryIntervalMs: 0,
      failpoint: (point) => {
        if (point === "afterHandler") {
          worker.stop();
          abortWorkerHandlers(worker);
        }
        return false;
      },
    }).handle("late", async (_payload: Json, context: HandlerContext) => {
      abortedAtReturn = context.signal.aborted;
      return Array.from({ length: 349_526 }, () => 0);
    });

    await worker.runOnce();

    expect(abortedAtReturn).toBe(false);
    expect(await taskState(taskId)).toEqual({ state: "failed", currentAttempt: 1 });
  });
});

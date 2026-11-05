import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  type HandlerContext,
  type Json,
  type WorkerProcessSignal,
  type WorkhorseAdapter,
  Worker,
  defineWorkerProcess,
  runWorkerProcess,
} from "../src/index.js";
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
// exit code that the runner gave at the end of its grace.
async function stopAtGrace(
  queueName: string,
  configure: (worker: Worker, started: () => void) => void,
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
          new Worker(queue, {
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

    expect(code).toBe(1);
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

    expect(code).toBe(1);
    expect(await taskState(taskId)).toEqual({ state: "succeeded", currentAttempt: 1 });
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

    expect(code).toBe(1);
    expect(batches).toBe(0);
    expect(await taskState(taskId)).toEqual({ state: "ready", currentAttempt: 1 });
  });
});

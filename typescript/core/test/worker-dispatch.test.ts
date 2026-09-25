import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { ClaimedTask } from "../src/types.js";
import { Worker, dispatchRefillBatch, type WorkerQueueApi } from "../src/worker.js";

// SM-909: a busy run() loop keeps its slots full with overlapping batched claims instead of one
// serial claim round trip per task. The fake queue lets each test hold a claim open and decide when
// every handler finishes.

async function unsupportedWorkerQueueOperation(): Promise<never> {
  throw new Error("Unexpected worker queue operation");
}

function claimedTask(id: string, type = "dispatch"): ClaimedTask {
  return {
    id,
    queue: "dispatch",
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil;
  });
  return { promise, resolve };
}

interface HeldClaim {
  limit: number;
  answer: Deferred<ClaimedTask[]>;
}

interface FakeQueueOptions {
  // Answers a claim immediately. Without it every claim is held until the test answers it.
  answer?: (limit: number) => ClaimedTask[];
}

function fakeQueue(options: FakeQueueOptions = {}) {
  const limits: number[] = [];
  const held: HeldClaim[] = [];
  const completed: string[] = [];
  const released: string[] = [];
  const claimWaiters: Array<() => void> = [];
  const queue = {
    defaultQueue: "dispatch",
    claim: unsupportedWorkerQueueOperation,
    claimMany: async (_workerId: string, limit: number) => {
      limits.push(limit);
      for (const waiter of claimWaiters.splice(0)) waiter();
      if (options.answer) return options.answer(limit);
      const answer = deferred<ClaimedTask[]>();
      held.push({ limit, answer });
      return answer.promise;
    },
    complete: async (task: ClaimedTask) => {
      completed.push(task.id);
      return true;
    },
    fail: unsupportedWorkerQueueOperation,
    expireOwned: unsupportedWorkerQueueOperation,
    releaseOwned: async (task: ClaimedTask) => {
      released.push(task.id);
      return "released";
    },
    heartbeatStatus: async () => "active",
    tick: async () => [],
    runMaintenance: async () => [],
  } as unknown as WorkerQueueApi;

  // Resolves once the fake has received `count` claims in total.
  const claimsReceived = async (count: number): Promise<void> => {
    while (limits.length < count) {
      await new Promise<void>((resolve) => {
        claimWaiters.push(resolve);
      });
    }
  };
  return { queue, limits, held, completed, released, claimsReceived };
}

// Lets every settled promise run its continuations, so the worker reaches its next decision.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await nextTurn();
}

// Handlers that block until the test finishes them one by one.
function gatedHandlers() {
  const gates = new Map<string, Deferred<void>>();
  const gate = (id: string): Deferred<void> => {
    let entry = gates.get(id);
    if (!entry) {
      entry = deferred<void>();
      gates.set(id, entry);
    }
    return entry;
  };
  const handler = async (_payload: unknown, context: { task: ClaimedTask }): Promise<null> => {
    await gate(context.task.id).promise;
    return null;
  };
  const finish = (id: string): void => gate(id).resolve();
  const finishAll = (): void => {
    for (const entry of gates.values()) entry.resolve();
  };
  return { handler, finish, finishAll };
}

function tasks(prefix: string, count: number, type = "dispatch"): ClaimedTask[] {
  return Array.from({ length: count }, (_, index) => claimedTask(`${prefix}-${index}`, type));
}

describe("worker dispatch", () => {
  it("sizes the refill batch at a quarter of the concurrency, rounded up", () => {
    expect([1, 2, 4, 5, 8, 16].map(dispatchRefillBatch)).toEqual([1, 1, 1, 2, 2, 4]);
  });

  it("overlaps a batched refill claim with one already in flight", async () => {
    const fake = fakeQueue();
    const { handler, finish, finishAll } = gatedHandlers();
    const worker = new Worker(fake.queue, { concurrency: 8, registryIntervalMs: 0 }).handle(
      "dispatch",
      handler,
    );
    const running = worker.run();

    await fake.claimsReceived(1);
    fake.held[0]!.answer.resolve(tasks("first", 8));
    await settle();
    expect(fake.limits).toEqual([8]);

    // One free slot with no claim in flight starts a claim at once.
    finish("first-0");
    await fake.claimsReceived(2);
    expect(fake.limits).toEqual([8, 1]);

    // With that claim still held, one more free slot is below the refill batch of two.
    finish("first-1");
    await settle();
    expect(fake.limits).toEqual([8, 1]);

    // The second free slot reaches the refill batch, so a claim overlaps the held one.
    finish("first-2");
    await fake.claimsReceived(3);
    expect(fake.limits).toEqual([8, 1, 2]);
    expect(fake.held.slice(1).map((claim) => claim.limit)).toEqual([1, 2]);

    worker.stop();
    fake.held[1]!.answer.resolve(tasks("second", 1));
    fake.held[2]!.answer.resolve(tasks("third", 2));
    await settle();
    finishAll();
    await running;

    // Tasks claimed after stop still ran, because each one holds a lease.
    expect(fake.completed).toHaveLength(11);
    expect(fake.completed).toEqual(expect.arrayContaining(["second-0", "third-0", "third-1"]));
  });

  it("never holds more claimed tasks than its concurrency", async () => {
    let supplied = 0;
    let running = 0;
    let peak = 0;
    const fake = fakeQueue({
      answer: (limit) => {
        const batch = tasks(`batch-${supplied}`, Math.min(limit, 200 - supplied));
        supplied += batch.length;
        return batch;
      },
    });
    const worker = new Worker(fake.queue, {
      concurrency: 16,
      registryIntervalMs: 0,
      pollMs: 10,
    }).handle("dispatch", async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(Math.random() * 3);
      running -= 1;
      return null;
    });
    const done = worker.run();
    while (fake.completed.length < 200) await sleep(5);
    worker.stop();
    await done;

    expect(peak).toBeLessThanOrEqual(16);
    // The empty claims at the end only find the queue drained.
    const workingClaims = fake.limits.length - 1;
    expect(workingClaims / 200).toBeLessThan(1);
  });

  it("starts no claim while paused and resumes claiming afterwards", async () => {
    const fake = fakeQueue();
    const { handler, finish, finishAll } = gatedHandlers();
    const worker = new Worker(fake.queue, {
      concurrency: 2,
      registryIntervalMs: 0,
      pollMs: 10,
    }).handle("dispatch", handler);
    const running = worker.run();

    await fake.claimsReceived(1);
    fake.held[0]!.answer.resolve(tasks("first", 2));
    await settle();

    worker.pause();
    finish("first-0");
    finish("first-1");
    await sleep(50);
    expect(fake.completed).toEqual(["first-0", "first-1"]);
    expect(fake.limits).toEqual([2]);

    worker.resume();
    await fake.claimsReceived(2);
    expect(fake.limits).toEqual([2, 2]);

    worker.stop();
    fake.held[1]!.answer.resolve([]);
    finishAll();
    await running;
  });

  it("drains a claim in flight at stop and runs the tasks it returns", async () => {
    const fake = fakeQueue();
    const { handler, finish } = gatedHandlers();
    const worker = new Worker(fake.queue, { concurrency: 4, registryIntervalMs: 0 }).handle(
      "dispatch",
      handler,
    );
    let stopped = false;
    const running = worker.run().then(() => {
      stopped = true;
    });

    await fake.claimsReceived(1);
    worker.stop();
    await settle();
    expect(stopped).toBe(false);

    fake.held[0]!.answer.resolve(tasks("late", 1));
    await settle();
    expect(stopped).toBe(false);

    finish("late-0");
    await running;
    expect(fake.completed).toEqual(["late-0"]);
    expect(fake.limits).toEqual([4]);
  });

  it("waits out the poll interval after an empty claim", async () => {
    const fake = fakeQueue({ answer: () => [] });
    const worker = new Worker(fake.queue, {
      concurrency: 4,
      registryIntervalMs: 0,
      pollMs: 200,
    }).handle("dispatch", async () => null);
    const running = worker.run();

    await fake.claimsReceived(1);
    await sleep(100);
    expect(fake.limits).toHaveLength(1);

    worker.stop();
    await running;
  });

  it("treats a claim of only unhandled tasks as empty and releases them", async () => {
    let supplied = 0;
    const fake = fakeQueue({
      answer: () => {
        supplied += 1;
        return [claimedTask(`unknown-${supplied}`, "no-handler")];
      },
    });
    const worker = new Worker(fake.queue, {
      concurrency: 4,
      registryIntervalMs: 0,
      pollMs: 200,
    }).handle("dispatch", async () => null);
    const running = worker.run();

    await fake.claimsReceived(1);
    await sleep(100);
    expect(fake.limits).toHaveLength(1);
    expect(fake.released).toEqual(["unknown-1"]);

    worker.stop();
    await running;
  });
});

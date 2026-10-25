import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedTask, CompletionClaim, Json } from "../src/types.js";
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

interface FastQueueOptions {
  // Tasks a fused completion claims for its limit. Without it a completion claims nothing.
  refill?: (limit: number) => ClaimedTask[];
  // Answers a plain claim immediately. Without it every plain claim is held.
  answer?: (limit: number) => ClaimedTask[];
}

// A fast-tier queue: plain claims go through claimFast, and each completion carries its claim.
function fastQueue(options: FastQueueOptions = {}) {
  const base = fakeQueue();
  const completions: CompletionClaim[] = [];
  const queue = {
    ...base.queue,
    claimMany: unsupportedWorkerQueueOperation,
    claimFast: async (_workerId: string, limit: number) => {
      if (options.answer) {
        base.limits.push(limit);
        return options.answer(limit);
      }
      return (base.queue.claimMany as (workerId: string, limit: number) => Promise<ClaimedTask[]>)(
        _workerId,
        limit,
      );
    },
    completeAndClaim: async (
      task: ClaimedTask,
      _workerId: string,
      _result: Json,
      claim: CompletionClaim,
    ) => {
      completions.push(claim);
      base.completed.push(task.id);
      return { accepted: true, claimed: options.refill?.(claim.limit) ?? [] };
    },
  } as unknown as WorkerQueueApi;
  return { ...base, queue, completions };
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
    // Concurrency 8 defaults to two cohorts, but a full-tier queue keeps whole-worker claims.
    expect(worker.cohorts).toBe(2);
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

  it("claims before its startup maintenance pass returns", async () => {
    const fake = fakeQueue({ answer: () => [] });
    const maintenance = deferred<[]>();
    let maintenanceCalls = 0;
    const queue = {
      ...fake.queue,
      runMaintenance: async () => {
        maintenanceCalls += 1;
        return maintenance.promise;
      },
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { registryIntervalMs: 0 }).handle(
      "dispatch",
      async () => null,
    );
    const running = worker.run();

    await fake.claimsReceived(1);
    expect(maintenanceCalls).toBe(1);

    worker.stop();
    maintenance.resolve([]);
    await running;
  });

  it("ends the run with the error of a failed startup maintenance pass", async () => {
    const fake = fakeQueue({ answer: () => [] });
    const queue = {
      ...fake.queue,
      runMaintenance: async () => {
        throw new Error("startup maintenance failed");
      },
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, { registryIntervalMs: 0 }).handle(
      "dispatch",
      async () => null,
    );

    await expect(worker.run()).rejects.toThrow("startup maintenance failed");
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
    expect(worker.cohorts).toBe(2);
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
    expect(worker.cohorts).toBe(1);
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

  // SM-1247: each release notifies the queue. If that notification ended the wait, the worker
  // claimed and released the same task again after the notification delay only.
  it("keeps a release wait through a notification and ends it on pause", async () => {
    const fake = fakeQueue();
    let notify: (() => void) | undefined;
    const queue = {
      ...fake.queue,
      subscribeToTaskNotifications: async (_queue: string, onNotification: () => void) => {
        notify = onNotification;
        return { close: async () => {} };
      },
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, {
      concurrency: 2,
      registryIntervalMs: 0,
      pollMs: 60_000,
    }).handle("dispatch", async () => null);
    const running = worker.run();
    await fake.claimsReceived(1);
    fake.held[0]!.answer.resolve([claimedTask("unknown-1", "no-handler")]);
    await settle();
    expect(fake.released).toEqual(["unknown-1"]);

    notify?.();
    await sleep(100);
    expect(fake.limits).toHaveLength(1);

    // A resume claims at once, without the rest of the release wait.
    worker.pause();
    await settle();
    worker.resume();
    await fake.claimsReceived(2);

    worker.stop();
    fake.held[1]!.answer.resolve([]);
    await running;
  });

  // SM-933: a dependency release notifies the queue on every completion. A busy worker that paid
  // the notification delay on each of those claims spent most of its time asleep.
  it("delays a notified claim only after a claim that found nothing", async () => {
    const fake = fakeQueue();
    let notify: (() => void) | undefined;
    const queue = {
      ...fake.queue,
      subscribeToTaskNotifications: async (_queue: string, onNotification: () => void) => {
        notify = onNotification;
        return { close: async () => {} };
      },
    } as unknown as WorkerQueueApi;
    // The delay draws the longest spread, so a delayed claim cannot land within settle().
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { handler, finish, finishAll } = gatedHandlers();
    const worker = new Worker(queue, {
      concurrency: 2,
      registryIntervalMs: 0,
      pollMs: 60_000,
    }).handle("dispatch", handler);
    try {
      const running = worker.run();
      await fake.claimsReceived(1);
      fake.held[0]!.answer.resolve(tasks("first", 2));
      await settle();

      // The last claim found work, so the claim a notification precedes starts at once.
      notify?.();
      finish("first-0");
      await settle();
      expect(fake.limits).toEqual([2, 1]);

      // After an empty claim the worker is idle, so a notification ends its wait with the delay.
      fake.held[1]!.answer.resolve([]);
      await settle();
      notify?.();
      await settle();
      expect(fake.limits).toEqual([2, 1]);
      await fake.claimsReceived(3);
      expect(fake.limits).toEqual([2, 1, 1]);

      worker.stop();
      fake.held[2]!.answer.resolve([]);
      finishAll();
      await running;
    } finally {
      random.mockRestore();
    }
  });

  it("defaults to one cohort per 8 slots from concurrency 8 and validates an explicit count", () => {
    const fake = fakeQueue();
    const cohorts = [1, 4, 7, 8, 16, 17, 32, 64, 65, 100].map(
      (concurrency) => new Worker(fake.queue, { concurrency, registryIntervalMs: 0 }).cohorts,
    );
    expect(cohorts).toEqual([1, 1, 1, 2, 2, 3, 4, 8, 8, 8]);
    expect(
      new Worker(fake.queue, { concurrency: 4, cohorts: 4, registryIntervalMs: 0 }).cohorts,
    ).toBe(4);
    for (const count of [0, 1.5, 9]) {
      expect(
        () => new Worker(fake.queue, { concurrency: 8, cohorts: count, registryIntervalMs: 0 }),
      ).toThrow("cohorts must be a safe integer between 1 and concurrency");
    }
  });

  it("claims one cohort at a time on a fast-tier queue and refills each cohort on its own", async () => {
    const fake = fastQueue({ refill: (limit) => tasks(`refill-${limit}`, 0) });
    const { handler, finish, finishAll } = gatedHandlers();
    const worker = new Worker(fake.queue, { concurrency: 8, registryIntervalMs: 0 }).handle(
      "dispatch",
      handler,
    );
    const running = worker.run();

    // The first claim still has to learn the tier, so it asks a fast-tier queue for one cohort.
    await fake.claimsReceived(1);
    expect(fake.limits).toEqual([4]);
    await settle();
    expect(fake.limits).toEqual([4]);

    // The second cohort's claim leaves only once the first returns, which offsets the cohorts.
    fake.held[0]!.answer.resolve(tasks("first", 4));
    await fake.claimsReceived(2);
    expect(fake.limits).toEqual([4, 4]);

    // A claim for the other cohort does not hold back a completion's claim for its own slot.
    finish("first-0");
    await settle();
    expect(fake.completions).toEqual([{ queue: "dispatch", limit: 1, leaseMs: 30_000, cohort: 0 }]);

    fake.held[1]!.answer.resolve(tasks("second", 4));
    await settle();
    finish("second-0");
    await settle();
    expect(fake.completions.at(-1)).toEqual({
      queue: "dispatch",
      limit: 1,
      leaseMs: 30_000,
      cohort: 1,
    });

    worker.stop();
    for (const claim of fake.held.slice(2)) claim.answer.resolve([]);
    finishAll();
    await running;
  });

  it("keeps whole-worker claims on a fast-tier queue with one cohort", async () => {
    const fake = fastQueue();
    const { handler, finish, finishAll } = gatedHandlers();
    const worker = new Worker(fake.queue, {
      concurrency: 8,
      cohorts: 1,
      registryIntervalMs: 0,
    }).handle("dispatch", handler);
    const running = worker.run();

    await fake.claimsReceived(1);
    expect(fake.limits).toEqual([8]);
    fake.held[0]!.answer.resolve(tasks("first", 8));
    await settle();

    finish("first-0");
    await settle();
    expect(fake.completions).toEqual([{ queue: "dispatch", limit: 1, leaseMs: 30_000, cohort: 0 }]);

    worker.stop();
    finishAll();
    await running;
  });

  it("keeps every cohort within its share of the slots under load", async () => {
    const total = 400;
    let supplied = 0;
    let running = 0;
    let peak = 0;
    const supply = (limit: number): ClaimedTask[] => {
      const batch = tasks(`batch-${supplied}`, Math.min(limit, total - supplied));
      supplied += batch.length;
      return batch;
    };
    const fake = fastQueue({ answer: supply, refill: supply });
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
    while (fake.completed.length < total) await sleep(5);
    worker.stop();
    await done;

    expect(peak).toBeLessThanOrEqual(16);
    expect(new Set(fake.completed).size).toBe(total);
    // Each completion refills at most its own cohort's eight slots, and both cohorts take part.
    expect(Math.max(...fake.completions.map((claim) => claim.limit))).toBeLessThanOrEqual(8);
    expect(new Set(fake.completions.map((claim) => claim.cohort))).toEqual(new Set([0, 1]));
  });

  // SM-1676: a fused completion claim asks only the completing task's queue. While that queue had
  // a backlog, each completion refilled the slot, and no plain claim reached the other queues.
  it("gives another queue a claim while a fast queue keeps a backlog", async () => {
    const backlog = 200;
    const waiting = new Map<string, ClaimedTask[]>([
      ["a", tasks("a", backlog).map((task) => Object.assign(task, { queue: "a" }))],
      ["b", [{ ...claimedTask("b-0"), queue: "b" }]],
    ]);
    const take = (queue: string, limit: number): ClaimedTask[] =>
      waiting.get(queue)!.splice(0, limit);
    const fake = fakeQueue();
    // The fused claim limit of each completion of queue a, in completion order.
    const fused: Array<{ id: string; limit: number }> = [];
    const queue = {
      ...fake.queue,
      claimMany: unsupportedWorkerQueueOperation,
      claimFast: async (_workerId: string, limit: number, options: { queue: string }) =>
        take(options.queue, limit),
      completeAndClaim: async (
        task: ClaimedTask,
        _workerId: string,
        _result: Json,
        claim: CompletionClaim,
      ) => {
        if (claim.queue === "a") fused.push({ id: task.id, limit: claim.limit });
        return { accepted: true, claimed: take(claim.queue, claim.limit) };
      },
    } as unknown as WorkerQueueApi;
    const ran: string[] = [];
    const worker = new Worker(queue, {
      queues: ["a", "b"],
      concurrency: 1,
      registryIntervalMs: 0,
      pollMs: 100,
    }).handle("dispatch", async (_payload, context) => {
      ran.push(context.task.id);
      await sleep(2);
      return null;
    });
    const done = worker.run();
    while (!ran.includes("b-0")) await sleep(5);
    worker.stop();
    await done;

    // Once queue b has waited a poll interval, one a completion claims nothing. Its slot goes to a
    // plain claim, which asks b next. Every other a completion still refills its slot.
    const coldAt = ran.indexOf("b-0");
    expect(coldAt).toBeLessThan(backlog / 2);
    // Under host load the first completion can already come a fairness interval after the start,
    // so it may be the one that skips.
    const skip = fused.findIndex((completion) => completion.limit === 0);
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(fused.slice(0, skip).every((completion) => completion.limit === 1)).toBe(true);
    expect(fused[skip]!.id).toBe(ran[coldAt - 1]);
  });

  // SM-1676: while a plain claim of another cohort was in flight, the next completion could claim
  // the slot that a fairness skip gave back. Every slot was then full again, and no plain claim
  // could ask the waiting queue.
  it("keeps the slot of a fairness skip free for a plain claim", async () => {
    const backlog = tasks("a", 100).map((task) => Object.assign(task, { queue: "a" }));
    let hold = false;
    const held: Array<() => void> = [];
    const fused: CompletionClaim[] = [];
    const queue = {
      ...fakeQueue().queue,
      claimMany: unsupportedWorkerQueueOperation,
      claimFast: async (_workerId: string, limit: number, options: { queue: string }) => {
        if (hold) {
          await new Promise<void>((resolve) => {
            held.push(resolve);
          });
        }
        return options.queue === "a" ? backlog.splice(0, limit) : [];
      },
      completeAndClaim: async (
        _task: ClaimedTask,
        _workerId: string,
        _result: Json,
        claim: CompletionClaim,
      ) => {
        fused.push(claim);
        return { accepted: true, claimed: backlog.splice(0, claim.limit) };
      },
    } as unknown as WorkerQueueApi;
    const { handler, finish, finishAll } = gatedHandlers();
    const worker = new Worker(queue, {
      queues: ["a", "b"],
      concurrency: 4,
      cohorts: 2,
      registryIntervalMs: 0,
      pollMs: 40,
    }).handle("dispatch", handler);
    const running = worker.run();

    // Cohort 0 runs a-0 and a-1. Cohort 1 runs a-2 and a-3.
    await vi.waitFor(() => expect(backlog[0]!.id).toBe("a-4"));
    hold = true;
    // A cohort 1 completion skips its refill, and the plain claim that takes its slot is held.
    await sleep(60);
    finish("a-2");
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    // Queue b waits a fairness interval again while that claim is in flight.
    await sleep(60);
    finish("a-0");
    await settle();
    finish("a-1");
    await settle();

    const cohortZero = fused.filter((claim) => claim.cohort === 0).map((claim) => claim.limit);
    expect(cohortZero).toEqual([0, 1]);

    worker.stop();
    hold = false;
    for (const release of held.splice(0)) release();
    // Tasks that the held claim and the last completions return also start, so keep finishing.
    const state = { ended: false };
    void running.finally(() => {
      state.ended = true;
    });
    while (!state.ended) {
      finishAll();
      await sleep(5);
    }
    await running;
  });
});

// SM-1653: the loop raced every handler promise on each iteration, and each race added a reaction
// to every pending promise. One long handler then kept one reaction for each short task beside it.
describe("worker dispatch memory", () => {
  it("adds no reaction to a long handler for each short task beside it", async () => {
    // Promise.race calls the `then` of each input, so a patched `then` counts the reactions that
    // each promise collects. A WeakMap keeps the count from holding the promise.
    const reactions = new WeakMap<object, number>();
    let mostReactions = 0;
    const then = Promise.prototype.then;

    let supplied = 0;
    const fake = fakeQueue({
      answer: (limit) => {
        if (supplied === 0) {
          supplied = 1;
          return [claimedTask("long", "long")];
        }
        const batch = tasks(`short-${supplied}`, Math.min(limit, 201 - supplied));
        supplied += batch.length;
        return batch;
      },
    });
    const long = deferred<void>();
    const worker = new Worker(fake.queue, { concurrency: 2, registryIntervalMs: 0, pollMs: 10 })
      .handle("long", async () => {
        await long.promise;
        return null;
      })
      .handle("dispatch", async () => null);

    const counted = function (
      this: Promise<unknown>,
      ...callbacks: Parameters<Promise<unknown>["then"]>
    ) {
      const count = (reactions.get(this) ?? 0) + 1;
      reactions.set(this, count);
      mostReactions = Math.max(mostReactions, count);
      return Reflect.apply(then, this, callbacks) as Promise<never>;
    };
    // A vitest spy calls `then` itself, so the test patches and restores the method by hand.
    // oxlint-disable-next-line no-extend-native, unicorn/no-thenable -- the test restores it below.
    Promise.prototype.then = counted as typeof then;
    let running: Promise<void> | undefined;
    try {
      try {
        running = worker.run();
        while (fake.completed.length < 200) await sleep(5);
      } finally {
        // oxlint-disable-next-line no-extend-native, unicorn/no-thenable -- restores the original.
        Promise.prototype.then = then;
      }
      // Before SM-1653, the long handler's promise collected one reaction for each short task.
      expect(mostReactions).toBeLessThan(10);
    } finally {
      worker.stop();
      long.resolve();
      await running;
    }
    expect(fake.completed).toContain("long");
  });
});

// Moves Date.now() by `offsetMs` from the real wall clock. The timers do not move.
function stepWallClock(offsetMs: number): void {
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

// SM-1656: maintenance, registration, and the empty-claim wait measured elapsed time on the wall
// clock. A clock step back stopped them, and a step forward ended a wait early.
describe("worker dispatch under a wall clock step", () => {
  it("keeps its tick, routine poll, registration and claim cadence after the clock steps back", async () => {
    const fake = fakeQueue({ answer: () => [] });
    let ticks = 0;
    let routinePolls = 0;
    let registrations = 0;
    const queue = {
      ...fake.queue,
      tick: async () => {
        ticks += 1;
        return [];
      },
      runMaintenance: async () => {
        routinePolls += 1;
        return [];
      },
      registerWorker: async () => {
        registrations += 1;
        return { paused: false };
      },
      deregisterWorker: async () => {},
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, {
      concurrency: 2,
      maintenanceIntervalMs: 100,
      maintenanceRoutinePollMs: 100,
      registryIntervalMs: 100,
      pollMs: 50,
    }).handle("dispatch", async () => null);
    const running = worker.run();
    try {
      await vi.waitFor(() => {
        expect(ticks).toBeGreaterThan(0);
        expect(routinePolls).toBeGreaterThan(0);
        expect(registrations).toBeGreaterThan(0);
      });
      await fake.claimsReceived(1);

      stepWallClock(-10 * 60_000);
      const before = { ticks, routinePolls, registrations, claims: fake.limits.length };
      await sleep(600);
      expect(ticks).toBeGreaterThan(before.ticks + 1);
      expect(routinePolls).toBeGreaterThan(before.routinePolls + 1);
      expect(registrations).toBeGreaterThan(before.registrations + 1);
      expect(fake.limits.length).toBeGreaterThan(before.claims + 1);
    } finally {
      vi.restoreAllMocks();
      worker.stop();
      await running;
    }
  });

  it("keeps a release wait through a notification after the clock steps forward", async () => {
    const fake = fakeQueue();
    let notify: (() => void) | undefined;
    const queue = {
      ...fake.queue,
      subscribeToTaskNotifications: async (_queue: string, onNotification: () => void) => {
        notify = onNotification;
        return { close: async () => {} };
      },
    } as unknown as WorkerQueueApi;
    const worker = new Worker(queue, {
      concurrency: 2,
      registryIntervalMs: 0,
      pollMs: 60_000,
    }).handle("dispatch", async () => null);
    const running = worker.run();
    try {
      await fake.claimsReceived(1);
      fake.held[0]!.answer.resolve([claimedTask("unknown-1", "no-handler")]);
      await settle();
      expect(fake.released).toEqual(["unknown-1"]);

      // The notification wakes the loop, which checks the wait again. The step must not end it.
      stepWallClock(10 * 60_000);
      notify?.();
      await sleep(100);
      expect(fake.limits).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      worker.stop();
      // An early claim must not keep the stop waiting.
      for (const claim of fake.held) claim.answer.resolve([]);
      await running;
    }
  });
});

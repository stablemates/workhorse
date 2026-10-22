import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedTask, HeartbeatBatchStatus } from "../src/index.js";
import { Worker } from "../src/index.js";
import { workerHeartbeatReservation } from "../src/worker-internal.js";
import { createIntegrationTestContext } from "./support/integration.js";

// A busy lease renews nothing and gets no ownership verdict. The worker retries only the busy
// leases after a short delay, before the next regular round, with one round in flight. A busy
// answer never moves the watchdog, so a lease that stays busy ends at the watchdog (SM-1443).

const { pool, queue } = createIntegrationTestContext(import.meta.url);

interface Round {
  startedAt: number;
  endedAt?: number;
  taskIds: string[];
  failed?: boolean;
}

type HeartbeatMany = (...args: never[]) => Promise<Map<string, HeartbeatBatchStatus>>;

/**
 * Record each heartbeat round on `target`. `answer` runs for each round, with its index, its
 * leases, and `send`, which sends a subset of the leases to the database with the round's other
 * arguments. It can return a status map, throw, or return undefined to send the whole round.
 */
function interceptRounds(
  target: { heartbeatMany: HeartbeatMany },
  answer: (
    round: number,
    tasks: readonly ClaimedTask[],
    send: (subset: readonly ClaimedTask[]) => Promise<Map<string, HeartbeatBatchStatus>>,
  ) => Promise<Map<string, HeartbeatBatchStatus> | undefined>,
): Round[] {
  const rounds: Round[] = [];
  const original = target.heartbeatMany.bind(target) as (
    ...args: unknown[]
  ) => Promise<Map<string, HeartbeatBatchStatus>>;
  vi.spyOn(target, "heartbeatMany").mockImplementation(async (...args: never[]) => {
    const [tasks, ...rest] = args as unknown as [readonly ClaimedTask[], ...unknown[]];
    const round: Round = { startedAt: performance.now(), taskIds: tasks.map((task) => task.id) };
    const index = rounds.push(round) - 1;
    try {
      const replaced = await answer(index, tasks, (subset) =>
        subset.length === 0 ? Promise.resolve(new Map()) : original(subset, ...rest),
      );
      if (replaced !== undefined) return replaced;
      return await original(tasks, ...rest);
    } catch (error) {
      round.failed = true;
      throw error;
    } finally {
      round.endedAt = performance.now();
    }
  });
  return rounds;
}

/** The reserved channel the worker takes, wrapped by `wrap` when the worker reserves it. */
function onReservedChannel(wrap: (channel: { heartbeatMany: HeartbeatMany }) => void): void {
  const reserve = queue[workerHeartbeatReservation].bind(queue);
  vi.spyOn(queue, workerHeartbeatReservation).mockImplementation((intervalMs) => {
    const channel = reserve(intervalMs);
    if (channel !== undefined) wrap(channel as unknown as { heartbeatMany: HeartbeatMany });
    return channel;
  });
}

async function outcomeState(taskId: string): Promise<string | undefined> {
  const result = await pool.query<{ state: string }>(
    "SELECT state FROM workhorse.task_outcome WHERE task_id = $1",
    [taskId],
  );
  return result.rows[0]?.state;
}

async function expiresAt(taskId: string): Promise<number> {
  const result = await pool.query<{ expires_at: Date }>(
    "SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1",
    [taskId],
  );
  return result.rows[0]!.expires_at.getTime();
}

function expectNoOverlap(rounds: readonly Round[]): void {
  for (let index = 1; index < rounds.length; index += 1) {
    expect(rounds[index - 1]!.endedAt).toBeDefined();
    expect(rounds[index]!.startedAt).toBeGreaterThanOrEqual(rounds[index - 1]!.endedAt!);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("busy heartbeat retry", () => {
  it.each([
    { shared: false, label: "reserved connection" },
    { shared: true, label: "shared heartbeats" },
  ])("retries only the busy lease before the next regular round ($label)", async ({ shared }) => {
    const heartbeatMs = 400;
    const retryBaseMs = Math.min(100, heartbeatMs / 8);
    const queueName = `busy-retry-${shared ? "shared" : "reserved"}`;
    const first = await queue.enqueue("retry", {}, { queue: queueName });
    const second = await queue.enqueue("retry", {}, { queue: queueName });
    // `first` is busy in each round until the worker has run 3 regular rounds and 2 retries. While
    // `first` is busy, both handlers wait, so a regular round has 2 leases and a retry has 1.
    let busy = true;
    let rounds: Round[] = [];
    const busyPhase: boolean[] = [];
    // The worker's next regular slot when each round starts. A regular round sets it before it
    // sends, and a retry must leave it as it is.
    const slots: (number | undefined)[] = [];
    const busyRounds = () => rounds.filter((_round, index) => busyPhase[index]);
    const regularRounds = () => busyRounds().filter((round) => round.taskIds.length === 2);
    const retryRounds = () => busyRounds().filter((round) => round.taskIds.length === 1);
    const intercept = (target: { heartbeatMany: HeartbeatMany }) => {
      rounds = interceptRounds(target, async (index, tasks, send) => {
        busyPhase[index] = busy;
        slots[index] = (worker as unknown as { nextHeartbeatAt?: number }).nextHeartbeatAt;
        if (!busy || !tasks.some((task) => task.id === first)) return undefined;
        // `first` gets busy and is not renewed. The other leases go to the database.
        const statuses = await send(tasks.filter((task) => task.id !== first));
        statuses.set(first, "busy");
        return statuses;
      });
    };
    if (shared) intercept(queue as unknown as { heartbeatMany: HeartbeatMany });
    else onReservedChannel(intercept);
    const started = new Set<string>();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aborted: string[] = [];
    const worker = new Worker(queue, {
      workerId: `busy-retry-${shared ? "shared" : "reserved"}-worker`,
      queue: queueName,
      concurrency: 2,
      leaseMs: 30_000,
      heartbeatMs,
      registryIntervalMs: 0,
      sharedHeartbeats: shared,
    }).handle("retry", async (_payload, context) => {
      started.add(context.task.id);
      await released;
      if (context.signal.aborted) aborted.push(context.task.id);
      return null;
    });
    const run = worker.runOnce();
    try {
      await vi.waitFor(() => expect(started.size).toBe(2), { timeout: 5_000, interval: 10 });
      // The wait counts rounds, not time. A retry needs one interval in which the busy round and
      // the retry delay end before the next slot, and the wait gives about 25 intervals.
      await vi.waitFor(
        () => {
          expect(regularRounds().length).toBeGreaterThanOrEqual(3);
          expect(retryRounds().length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10_000, interval: 10 },
      );
    } finally {
      busy = false;
      release();
    }
    expect(await run).toBe(true);

    const busyIndexes = busyRounds().map((round) => rounds.indexOf(round));
    const retries = retryRounds();
    // The first round is regular. Each retry sends only the busy lease, after the retry delay of at
    // least min(100 ms, heartbeatMs / 8) from the end of the busy round before it.
    expect(rounds[0]!.taskIds).toHaveLength(2);
    for (const index of busyIndexes) expect([1, 2]).toContain(rounds[index]!.taskIds.length);
    for (const retry of retries) expect(retry.taskIds).toEqual([first]);
    for (const retry of retries) {
      const before = rounds[rounds.indexOf(retry) - 1]!;
      expect(retry.startedAt - before.endedAt!).toBeGreaterThanOrEqual(0.9 * retryBaseMs);
    }
    // The retries do not move the regular slots: each retry starts with the slot that the regular
    // round before it sets. A regular round falls due one interval after the previous regular
    // round starts. A slow round can only make the gap longer, so the test checks no upper limit.
    // These checks compare the slots that the worker stores, not times that the test measures.
    const regularSlots: (number | undefined)[] = [];
    // For each retry: the slot that it starts with, and the slot of the regular round before it.
    const retrySlots: [number | undefined, number | undefined][] = [];
    for (const index of busyIndexes) {
      if (rounds[index]!.taskIds.length === 2) regularSlots.push(slots[index]);
      else retrySlots.push([slots[index], regularSlots.at(-1)]);
    }
    for (const regularSlot of regularSlots) expect(regularSlot).toBeDefined();
    for (const [retrySlot, regularSlot] of retrySlots) {
      expect(regularSlot).toBeDefined();
      expect(retrySlot).toBe(regularSlot);
    }
    for (let index = 1; index < regularSlots.length; index += 1) {
      const gap = regularSlots[index]! - regularSlots[index - 1]!;
      expect(gap).toBeGreaterThanOrEqual(0.9 * heartbeatMs);
    }
    expectNoOverlap(rounds);
    expect(aborted).toEqual([]);
    expect(await outcomeState(first)).toBe("succeeded");
    expect(await outcomeState(second)).toBe("succeeded");
  });

  it("ends a lease that stays busy at the watchdog, not earlier", async () => {
    const leaseMs = 1_200;
    const heartbeatMs = 300;
    const queueName = "busy-retry-watchdog";
    await queue.enqueue("watchdog", {}, { queue: queueName });
    let rounds: Round[] = [];
    onReservedChannel((channel) => {
      rounds = interceptRounds(
        channel,
        async (_round, tasks) => new Map(tasks.map((task) => [task.id, "busy" as const])),
      );
    });
    let startedAt = 0;
    let abortedAt = 0;
    let reason: unknown;
    const worker = new Worker(queue, {
      workerId: "busy-retry-watchdog-worker",
      queue: queueName,
      leaseMs,
      heartbeatMs,
      registryIntervalMs: 0,
    }).handle("watchdog", async (_payload, context) => {
      startedAt = performance.now();
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      abortedAt = performance.now();
      reason = context.signal.reason;
      return null;
    });
    expect(await worker.runOnce()).toBe(true);
    // The watchdog counts from the claim request, which left before the handler started.
    expect(abortedAt - startedAt).toBeLessThan(leaseMs + 500);
    expect(abortedAt - startedAt).toBeGreaterThan(leaseMs - 300);
    expect(String(reason)).toMatch(/No heartbeat was accepted within the task lease/);
    // Busy retries ran between the regular rounds, and none ran after the watchdog.
    expect(rounds.length).toBeGreaterThan(Math.floor(leaseMs / heartbeatMs));
    for (const round of rounds) expect(round.startedAt).toBeLessThan(abortedAt);
    expectNoOverlap(rounds);
    await sleep(2 * heartbeatMs);
    expect(rounds.every((round) => round.startedAt < abortedAt)).toBe(true);
  });

  it("waits for the next regular round after a failed retry", async () => {
    const heartbeatMs = 400;
    const queueName = "busy-retry-failed";
    const id = await queue.enqueue("failed", {}, { queue: queueName });
    let rounds: Round[] = [];
    onReservedChannel((channel) => {
      rounds = interceptRounds(channel, async (round, tasks) => {
        if (round === 0) return new Map(tasks.map((task) => [task.id, "busy" as const]));
        if (round === 1) throw new Error("injected retry failure");
        return undefined;
      });
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "busy-retry-failed-worker",
      queue: queueName,
      leaseMs: 30_000,
      heartbeatMs,
      registryIntervalMs: 0,
    }).handle("failed", async () => {
      await released;
      return null;
    });
    const run = worker.runOnce();
    try {
      await vi.waitFor(() => expect(rounds[2]?.endedAt).toBeDefined(), {
        timeout: 5_000,
        interval: 10,
      });
    } finally {
      release();
    }
    expect(await run).toBe(true);
    expect(rounds[1]!.failed).toBe(true);
    expect(rounds[1]!.startedAt - rounds[0]!.endedAt!).toBeLessThan(heartbeatMs / 2);
    // The failed retry scheduled no retry. The next round is the regular one.
    expect(rounds[2]!.startedAt - rounds[0]!.startedAt).toBeGreaterThanOrEqual(0.9 * heartbeatMs);
    expect(await outcomeState(id)).toBe("succeeded");
  });

  it("skips a retry with too little time before the next regular round, which renews the lease", async () => {
    // With no jitter, a retry falls due min(100 ms, heartbeatMs / 8) after the busy round ends.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const heartbeatMs = 400;
    const retryDelayMs = heartbeatMs / 8;
    const queueName = "busy-retry-short";
    const id = await queue.enqueue("short", {}, { queue: queueName });
    let rounds: Round[] = [];
    onReservedChannel((channel) => {
      rounds = interceptRounds(channel, async (round, tasks) => {
        if (round > 0) return undefined;
        // The busy answer arrives so late that the retry falls due 10 ms before the next slot.
        await sleep(heartbeatMs - retryDelayMs - 10);
        return new Map(tasks.map((task) => [task.id, "busy" as const]));
      });
    });
    let claimedUntil: number | undefined;
    let renewedUntil: number | undefined;
    const worker = new Worker(queue, {
      workerId: "busy-retry-short-worker",
      queue: queueName,
      leaseMs: 30_000,
      heartbeatMs,
      registryIntervalMs: 0,
    }).handle("short", async () => {
      claimedUntil = await expiresAt(id);
      await vi.waitFor(() => expect(rounds[1]?.endedAt).toBeDefined(), {
        timeout: 5_000,
        interval: 10,
      });
      renewedUntil = await expiresAt(id);
      return null;
    });
    expect(await worker.runOnce()).toBe(true);
    // The second round is the regular one, one interval after the first. It did not fail, and it
    // renewed the lease that the first round reported busy.
    expect(rounds[1]!.startedAt - rounds[0]!.startedAt).toBeGreaterThanOrEqual(0.9 * heartbeatMs);
    expect(rounds[1]!.failed).toBeUndefined();
    expect(renewedUntil).toBeGreaterThan(claimedUntil!);
    expect(await outcomeState(id)).toBe("succeeded");
  });

  it("sends no retry for a busy lease that left while its round ran", async () => {
    const heartbeatMs = 300;
    const queueName = "busy-retry-left";
    const id = await queue.enqueue("left", {}, { queue: queueName });
    let rounds: Round[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let roundSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      roundSent = resolve;
    });
    onReservedChannel((channel) => {
      rounds = interceptRounds(channel, async (_round, tasks) => {
        roundSent();
        // The task finishes while this round is in flight. Its late busy answer counts for nothing.
        await finished;
        await sleep(100);
        return new Map(tasks.map((task) => [task.id, "busy" as const]));
      });
    });
    const worker = new Worker(queue, {
      workerId: "busy-retry-left-worker",
      queue: queueName,
      leaseMs: 30_000,
      heartbeatMs,
      registryIntervalMs: 0,
      sharedHeartbeats: false,
    }).handle("left", async () => {
      await sent;
      return null;
    });
    const run = worker.runOnce();
    await sent;
    finish();
    expect(await run).toBe(true);
    await vi.waitFor(() => expect(rounds[0]?.endedAt).toBeDefined(), {
      timeout: 5_000,
      interval: 10,
    });
    await sleep(heartbeatMs);
    expect(rounds).toHaveLength(1);
    expect(await outcomeState(id)).toBe("succeeded");
  });

  it.each([false, true])(
    "never renews through heartbeatStatus with the built-in queue (shared heartbeats: %s)",
    async (sharedHeartbeats) => {
      const queueName = `busy-retry-no-scalar-${String(sharedHeartbeats)}`;
      await queue.enqueue("scalar", {}, { queue: queueName });
      const scalar = vi.spyOn(queue, "heartbeatStatus");
      const worker = new Worker(queue, {
        workerId: `busy-retry-no-scalar-${String(sharedHeartbeats)}`,
        queue: queueName,
        leaseMs: 1_000,
        heartbeatMs: 50,
        registryIntervalMs: 0,
        sharedHeartbeats,
      }).handle("scalar", async () => {
        await sleep(300);
        return null;
      });
      expect(await worker.runOnce()).toBe(true);
      expect(scalar).not.toHaveBeenCalled();
    },
  );
});

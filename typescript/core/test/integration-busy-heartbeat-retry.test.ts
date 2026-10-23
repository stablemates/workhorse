import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedTask, HeartbeatBatchStatus } from "../src/index.js";
import { Worker } from "../src/index.js";
import { workerHeartbeatReservation } from "../src/worker-internal.js";
import { type HeartbeatSchedule, recordHeartbeatTimers } from "./support/heartbeat-timers.js";
import { createIntegrationTestContext } from "./support/integration.js";

// Each deadline that the worker gives setUnrefTimeoutAt, and whether its callback ran. The lease
// watchdog arms its timer through this function.
const armedDeadlines = vi.hoisted(() => [] as { atMs: number; fired: boolean }[]);
vi.mock("../src/timers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/timers.js")>();
  return {
    ...actual,
    setUnrefTimeoutAt: (atMs: number, callback: () => void) => {
      const record = { atMs, fired: false };
      armedDeadlines.push(record);
      return actual.setUnrefTimeoutAt(atMs, () => {
        record.fired = true;
        callback();
      });
    },
  };
});

// A busy lease renews nothing and gets no ownership verdict. The worker retries only the busy
// leases after a short delay, before the next regular round, with one round in flight. A busy
// answer never moves the watchdog, so a lease that stays busy ends at the watchdog (SM-1443).
//
// PostgreSQL can also report busy a lease that a test does not make busy. Under host load, a round
// on the reserved connection can reach its bound. The worker then discards that connection. Its
// transaction can keep the row lock for a moment, so the next round finds the row locked. Thus a
// test finds a retry by the worker's timer, not by the leases that the round sends. It checks each
// retry against the statuses of the round before it (SM-1733).

const { pool, queue } = createIntegrationTestContext(import.meta.url);

interface Round {
  startedAt: number;
  endedAt?: number;
  taskIds: string[];
  failed?: boolean;
  /** The worker's next regular slot when the round starts. A busy retry does not change it. */
  slot?: number;
  /** True if a busy retry timer started the round, false if the regular timer started it. */
  retry?: boolean;
  /** The sorted IDs of the leases that the round's answer reports busy. */
  busy?: string[];
}

type HeartbeatMany = (...args: never[]) => Promise<Map<string, HeartbeatBatchStatus>>;

/**
 * Record each heartbeat round on `target`. `answer` runs for each round, with its index, its
 * leases, and `send`, which sends a subset of the leases to the database with the round's other
 * arguments. It can return a status map, throw, or return undefined to send the whole round.
 *
 * With `schedule`, each round also records the worker's slot and the kind of timer that started
 * it, before `answer` runs. The worker starts a round synchronously in its timer callback, so the
 * flag of the timer is still set.
 */
function interceptRounds(
  target: { heartbeatMany: HeartbeatMany },
  answer: (
    round: number,
    tasks: readonly ClaimedTask[],
    send: (subset: readonly ClaimedTask[]) => Promise<Map<string, HeartbeatBatchStatus>>,
  ) => Promise<Map<string, HeartbeatBatchStatus> | undefined>,
  schedule?: () => HeartbeatSchedule,
): Round[] {
  const rounds: Round[] = [];
  const original = target.heartbeatMany.bind(target) as (
    ...args: unknown[]
  ) => Promise<Map<string, HeartbeatBatchStatus>>;
  vi.spyOn(target, "heartbeatMany").mockImplementation(async (...args: never[]) => {
    const [tasks, ...rest] = args as unknown as [readonly ClaimedTask[], ...unknown[]];
    const round: Round = { startedAt: performance.now(), taskIds: tasks.map((task) => task.id) };
    if (schedule !== undefined) {
      round.slot = schedule().nextHeartbeatAt;
      round.retry = schedule().heartbeatTimerIsRetry;
    }
    const index = rounds.push(round) - 1;
    try {
      const statuses =
        (await answer(index, tasks, (subset) =>
          subset.length === 0 ? Promise.resolve(new Map()) : original(subset, ...rest),
        )) ?? (await original(tasks, ...rest));
      round.busy = [...statuses]
        .filter(([, status]) => status === "busy")
        .map(([taskId]) => taskId)
        .toSorted();
      return statuses;
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

/**
 * Require that each round from index `from` on is a regular round with a new slot, or a busy retry.
 * A busy retry keeps the slot of the round before it. It sends only leases that the round before it
 * reports busy. No round sends a lease in `gone`. Under host load, PostgreSQL can report a lease
 * busy, so a retry can follow a round that the test sends to the database.
 */
function expectRegularOrBusyRetry(
  rounds: readonly Round[],
  from: number,
  gone: readonly string[] = [],
): void {
  for (let index = Math.max(1, from); index < rounds.length; index += 1) {
    const round = rounds[index]!;
    const before = rounds[index - 1]!;
    const retry = round.retry === true;
    const busyBefore = before.busy ?? [];
    expect(
      {
        timerKnown: round.retry !== undefined,
        slot: retry ? round.slot === before.slot : round.slot! > before.slot!,
        leases:
          !retry ||
          (round.taskIds.length > 0 &&
            round.taskIds.every((taskId) => busyBefore.includes(taskId))),
        gone: round.taskIds.filter((taskId) => gone.includes(taskId)),
      },
      `round ${index} (${retry ? "retry" : "regular"})`,
    ).toEqual({ timerKnown: true, slot: true, leases: true, gone: [] });
  }
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
    // `first` is busy, both handlers wait, so a regular round has 2 leases. A retry has `first`, and
    // also `second` if PostgreSQL reported it busy in the round before.
    let busy = true;
    let rounds: Round[] = [];
    const busyPhase: boolean[] = [];
    const busyRounds = () => rounds.filter((_round, index) => busyPhase[index]);
    const regularRounds = () => busyRounds().filter((round) => round.retry === false);
    const retryRounds = () => busyRounds().filter((round) => round.retry === true);
    const intercept = (target: { heartbeatMany: HeartbeatMany }) => {
      rounds = interceptRounds(
        target,
        async (index, tasks, send) => {
          busyPhase[index] = busy;
          if (!busy || !tasks.some((task) => task.id === first)) return undefined;
          // `first` gets busy and is not renewed. The other leases go to the database.
          const statuses = await send(tasks.filter((task) => task.id !== first));
          statuses.set(first, "busy");
          return statuses;
        },
        () => worker as unknown as HeartbeatSchedule,
      );
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
      await vi.waitFor(() => expect(started.size).toBe(2), { timeout: 15_000, interval: 10 });
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
    // The first round is regular, and each regular round sends both leases.
    expect(rounds[0]!.retry).toBe(false);
    for (const regular of regularRounds()) expect(regular.taskIds).toHaveLength(2);
    // Each retry sends only the leases that the round before it reports busy, `first` among them.
    // It starts after the retry delay of at least min(100 ms, heartbeatMs / 8) from the end of
    // that round.
    for (const retry of retries) {
      const before = rounds[rounds.indexOf(retry) - 1]!;
      expect(retry.taskIds).toContain(first);
      expect(retry.taskIds.toSorted()).toEqual(before.busy);
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
      const round = rounds[index]!;
      if (round.retry === true) retrySlots.push([round.slot, regularSlots.at(-1)]);
      else regularSlots.push(round.slot);
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
    // A claim answer that arrives a full lease after its request left opens no window, so the
    // lease is long enough for a slow database.
    const leaseMs = 3_000;
    const heartbeatMs = 300;
    const queueName = "busy-retry-watchdog";
    const id = await queue.enqueue("watchdog", {}, { queue: queueName });
    let rounds: Round[] = [];
    // The end of the task's local lease window: the claim request's send time plus the lease. The
    // watchdog fires at this time unless a heartbeat is accepted.
    const leaseEndsAt = () =>
      (
        schedule().heartbeatLeases.get(id) as { leaseEndsAt(): number | undefined } | undefined
      )?.leaseEndsAt();
    // The end of the lease window when each round starts.
    const windows: (number | undefined)[] = [];
    onReservedChannel((channel) => {
      rounds = interceptRounds(
        channel,
        async (_round, tasks) => {
          windows.push(leaseEndsAt());
          return new Map(tasks.map((task) => [task.id, "busy" as const]));
        },
        schedule,
      );
    });
    let windowAtStart: number | undefined;
    let abortedAt = 0;
    let reason: unknown;
    const worker = new Worker(queue, {
      workerId: "busy-retry-watchdog-worker",
      queue: queueName,
      leaseMs,
      heartbeatMs,
      registryIntervalMs: 0,
    }).handle("watchdog", async (_payload, context) => {
      windowAtStart = leaseEndsAt();
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      abortedAt = performance.now();
      reason = context.signal.reason;
      return null;
    });
    const schedule = () => worker as unknown as HeartbeatSchedule;
    armedDeadlines.length = 0;
    expect(await worker.runOnce()).toBe(true);
    // The watchdog ends the attempt at the end of the window that the claim opened. It arms its
    // timer at that end, not earlier or later, and the timer fires. A busy answer never moves the
    // window, so each round starts with the same end. These checks compare deadlines that the
    // worker stores, so a slow host cannot change the result.
    expect(windowAtStart).toBeDefined();
    expect(
      armedDeadlines.filter((deadline) => deadline.atMs === windowAtStart && deadline.fired),
    ).toHaveLength(1);
    expect(abortedAt).toBeGreaterThanOrEqual(windowAtStart!);
    expect(windows).toEqual(rounds.map(() => windowAtStart));
    expect(String(reason)).toMatch(/No heartbeat was accepted within the task lease/);
    // Busy retries ran between the regular rounds, and none ran after the watchdog.
    expect(rounds.some((round) => round.retry === true)).toBe(true);
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
    // The worker's next regular slot when each round starts. A regular round sets it to its send
    // time plus one interval before it sends. A retry leaves it as it is, so the test finds the
    // retry by its slot, not by measured gaps (SM-1670).
    const slots: (number | undefined)[] = [];
    let failedRetry: number | undefined;
    onReservedChannel((channel) => {
      rounds = interceptRounds(channel, async (round, tasks) => {
        slots[round] = (worker as unknown as { nextHeartbeatAt?: number }).nextHeartbeatAt;
        if (failedRetry !== undefined) return undefined;
        if (round > 0 && slots[round] === slots[round - 1]) {
          failedRetry = round;
          throw new Error("injected retry failure");
        }
        // A regular round reports the lease busy. If a slow host reaches the regular slot before
        // the retry falls due, the worker drops the retry, and the next regular round tries again.
        return new Map(tasks.map((task) => [task.id, "busy" as const]));
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
      await vi.waitFor(
        () => {
          expect(failedRetry).toBeDefined();
          expect(rounds[failedRetry! + 1]?.endedAt).toBeDefined();
        },
        { timeout: 15_000, interval: 10 },
      );
    } finally {
      release();
    }
    expect(await run).toBe(true);
    const retry = failedRetry!;
    const busy = retry - 1;
    const next = retry + 1;
    // The worker sent a retry of the busy lease before the regular slot, and the retry failed.
    expect(rounds[retry]!.failed).toBe(true);
    expect(slots[busy]).toBeDefined();
    // The failed retry scheduled no retry. The next round is the regular one: it sets a new slot,
    // and it falls due one interval after the busy round started.
    expect(slots[next]).toBeGreaterThan(slots[retry]!);
    expect(rounds[next]!.startedAt - rounds[busy]!.startedAt).toBeGreaterThanOrEqual(
      0.9 * heartbeatMs,
    );
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
    // The time left before the next regular slot when a busy retry falls due, until the renewal
    // rounds start. Each value is less than the shortest bound of a retry, so the worker must send
    // nothing.
    const shortRetries: number[] = [];
    // The first round that starts after a short retry falls due. This round and the rounds after
    // it go to the database.
    let renewalFrom: number | undefined;
    onReservedChannel((channel) => {
      rounds = interceptRounds(
        channel,
        async (round, tasks) => {
          if (shortRetries.length > 0) {
            renewalFrom ??= round;
            return undefined;
          }
          // The busy answer arrives so late that the retry falls due at most 10 ms before the
          // slot. A slow host can only make the retry later. If it falls due at or after the slot,
          // the worker drops it, and the next regular round tries again.
          const slot = rounds[round]!.slot!;
          await sleep(Math.max(0, slot - retryDelayMs - 10 - performance.now()));
          return new Map(tasks.map((task) => [task.id, "busy" as const]));
        },
        schedule,
      );
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
      // A slow host can make a regular round reach its bound, or make PostgreSQL report the lease
      // busy. The test waits for a round that ends with no busy lease, and counts rounds, not time.
      await vi.waitFor(
        () => {
          expect(renewalFrom).toBeDefined();
          const renewed = rounds
            .slice(renewalFrom)
            .some((round) => round.busy !== undefined && round.busy.length === 0);
          expect(renewed).toBe(true);
        },
        { timeout: 15_000, interval: 10 },
      );
      renewedUntil = await expiresAt(id);
      return null;
    });
    const schedule = () => worker as unknown as HeartbeatSchedule;
    recordHeartbeatTimers(worker, () => {
      const { heartbeatTimerIsRetry, nextHeartbeatAt } = schedule();
      const leftMs = nextHeartbeatAt! - performance.now();
      if (renewalFrom === undefined && heartbeatTimerIsRetry && leftMs > 0) {
        shortRetries.push(leftMs);
      }
      return false;
    });
    expect(await worker.runOnce()).toBe(true);
    // A busy retry falls due before the slot, with less time left than a retry needs.
    expect(shortRetries.length).toBeGreaterThan(0);
    for (const leftMs of shortRetries) expect(leftMs).toBeLessThan(20);
    // The worker sends no retry: each round up to the first renewal round is a regular round with
    // a new slot. After it, a retry can follow only a busy answer from PostgreSQL.
    for (let index = 1; index <= renewalFrom!; index += 1) {
      expect(rounds[index]!.retry).toBe(false);
      expect(rounds[index]!.slot).toBeGreaterThan(rounds[index - 1]!.slot!);
    }
    expectRegularOrBusyRetry(rounds, renewalFrom! + 1);
    // A regular round after the short retry renews the lease that the earlier rounds report busy.
    expect(renewedUntil).toBeGreaterThan(claimedUntil!);
    expect(await outcomeState(id)).toBe("succeeded");
  });

  it("sends no retry for a busy lease that left while its round ran", async () => {
    const heartbeatMs = 300;
    const queueName = "busy-retry-left";
    // `kept` runs until the test ends, so the worker keeps its schedule after `left` finishes.
    const left = await queue.enqueue("left", { leaves: true }, { queue: queueName });
    const kept = await queue.enqueue("left", { leaves: false }, { queue: queueName });
    let rounds: Round[] = [];
    // The first round that sends `left`.
    let leftRound: number | undefined;
    let roundSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      roundSent = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    onReservedChannel((channel) => {
      rounds = interceptRounds(
        channel,
        async (round, tasks, send) => {
          if (leftRound !== undefined || !tasks.some((task) => task.id === left)) return undefined;
          leftRound = round;
          roundSent();
          // `left` finishes while this round is in flight. Its late busy answer has no effect. The
          // other lease goes to the database.
          await vi.waitFor(() => expect(schedule().heartbeatLeases.has(left)).toBe(false), {
            timeout: 10_000,
            interval: 5,
          });
          const statuses = await send(tasks.filter((task) => task.id !== left));
          statuses.set(left, "busy");
          return statuses;
        },
        schedule,
      );
    });
    const worker = new Worker(queue, {
      workerId: "busy-retry-left-worker",
      queue: queueName,
      concurrency: 2,
      leaseMs: 30_000,
      heartbeatMs,
      registryIntervalMs: 0,
      sharedHeartbeats: false,
    }).handle("left", async (payload: { leaves: boolean }) => {
      await (payload.leaves ? sent : released);
      return null;
    });
    const schedule = () => worker as unknown as HeartbeatSchedule;
    const timers = recordHeartbeatTimers(worker);
    // The task IDs of each busy set that a round gives to a retry, until the test releases `kept`.
    // The worker stores the set before it arms a timer, so this record does not depend on when the
    // busy answer arrives.
    const busySets: string[][] = [];
    let releasedAt: number | undefined;
    let busyRetryLeases: { task: ClaimedTask }[] | undefined;
    Object.defineProperty(worker, "busyRetryLeases", {
      configurable: true,
      get: () => busyRetryLeases,
      set: (leases: { task: ClaimedTask }[] | undefined) => {
        if (leases !== undefined && releasedAt === undefined) {
          busySets.push(leases.map((lease) => lease.task.id));
        }
        busyRetryLeases = leases;
      },
    });
    const run = worker.runOnce();
    try {
      // A retry falls due before the next regular round. The wait counts rounds, not time.
      await vi.waitFor(
        () => {
          expect(leftRound).toBeDefined();
          expect(rounds[leftRound! + 1]?.endedAt).toBeDefined();
        },
        { timeout: 15_000, interval: 10 },
      );
    } finally {
      releasedAt = performance.now();
      release();
    }
    expect(await run).toBe(true);
    // The late busy answer gives no lease to a retry. Each busy set that the worker stores is the
    // set of leases that PostgreSQL reported busy in one round, without `left`. The comparison
    // stops at the release, because `kept` can leave after it. The worker reads each answer in the
    // microtasks after its round ends, before the release can run. Usually the database renews
    // `kept`, so the worker stores no busy set and arms no retry timer.
    const busyFromDatabase = rounds
      .filter((round) => round.endedAt !== undefined && round.endedAt < releasedAt!)
      .map((round) => (round.busy ?? []).filter((taskId) => taskId !== left))
      .filter((taskIds) => taskIds.length > 0);
    expect(busySets.map((taskIds) => taskIds.toSorted())).toEqual(busyFromDatabase);
    const retryTimers = timers.filter((timer) => timer.retry && timer.at < releasedAt!);
    expect(retryTimers.length).toBeLessThanOrEqual(busySets.length);
    // The worker sends no retry for `left`: each later round is a regular round with a new slot,
    // or a retry of a lease that PostgreSQL reported busy. No round sends `left` again.
    expectRegularOrBusyRetry(rounds, leftRound! + 1, [left]);
    expect(await outcomeState(left)).toBe("succeeded");
    expect(await outcomeState(kept)).toBe("succeeded");
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

import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { HeartbeatBatchStatus } from "../src/index.js";
import { Worker } from "../src/index.js";
import { workerHeartbeatReservation } from "../src/worker-internal.js";
import { type HeartbeatSchedule, recordHeartbeatTimers } from "./support/heartbeat-timers.js";
import { createIntegrationTestContext } from "./support/integration.js";
import { unreservedQueue } from "../src/worker-internal.js";

// Heartbeat rounds start on a fixed schedule: each round falls due one heartbeatMs after the
// previous round started, not after it ended. So one round that times out does not move the next
// round toward the end of the lease (SM-1444).

const { pool, queue } = createIntegrationTestContext(import.meta.url);

interface Round {
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
  // The worker's next regular slot when the round starts. A regular round sets it to its send
  // time plus one interval before it sends.
  slot?: number;
}

/**
 * Make every heartbeat statement wait, and return the function that commits. heartbeat_many_v2
 * skips a locked row and reports it busy, so a row lock no longer slows it. It always locks its
 * fast-tier rows first, so an EXCLUSIVE lock on fast_task_runtime makes it wait on that table.
 * Enqueue and claim of full-tier tasks do not need that lock.
 */
async function blockHeartbeats(): Promise<() => Promise<void>> {
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE");
  } catch (error) {
    blocker.release(true);
    throw error;
  }
  return async () => {
    try {
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
  };
}

/**
 * Record each call of `heartbeatMany` on `target`, with its start, end, and result. The first call
 * waits `firstDelayMs` before it sends its statement, and every call waits `everyDelayMs`.
 */
function recordRounds(
  target: {
    heartbeatMany: (...args: never[]) => Promise<Map<string, HeartbeatBatchStatus>>;
  },
  firstDelayMs = 0,
  everyDelayMs = 0,
  slot?: () => number | undefined,
): Round[] {
  const rounds: Round[] = [];
  const original = target.heartbeatMany.bind(target) as (
    ...args: unknown[]
  ) => Promise<Map<string, HeartbeatBatchStatus>>;
  vi.spyOn(target, "heartbeatMany").mockImplementation(async (...args: never[]) => {
    const round: Round = { startedAt: performance.now(), slot: slot?.() };
    rounds.push(round);
    try {
      if (rounds.length === 1 && firstDelayMs > 0) await sleep(firstDelayMs);
      if (everyDelayMs > 0) await sleep(everyDelayMs);
      return await original(...args);
    } catch (error) {
      round.failed = true;
      throw error;
    } finally {
      round.endedAt = performance.now();
    }
  });
  return rounds;
}

async function outcomeState(taskId: string): Promise<string | undefined> {
  const result = await pool.query<{ state: string }>(
    "SELECT state FROM workhorse.task_outcome WHERE task_id = $1",
    [taskId],
  );
  return result.rows[0]?.state;
}

describe("heartbeat schedule", () => {
  it("keeps a renewal margin after one timed-out round", { timeout: 30_000 }, async () => {
    // The lease is 2.3 heartbeat intervals, shorter than the default of 3. The table lock makes the
    // first round time out on the server at about 1.4 intervals. The fixed schedule sends the next
    // round at 2 intervals, inside the lease. A schedule that waits one interval after the failed
    // round ends sends it at about 2.4 intervals, after the lease.
    //
    // The lease starts when the claim leaves, so the claim, the start of the handler, and the
    // second round must end in 0.3 intervals. The delays of a loaded host are absolute, so the
    // interval is 4 s, which gives them 1.2 s. A trace ran at a 1-minute load of 46 on 32 cores.
    // The delay from the claim to the handler was up to 654 ms, and the second round took up to
    // 221 ms (SM-1479).
    const heartbeatMs = 4_000;
    const leaseMs = 9_200;
    const id = await queue.enqueue("margin", {}, { queue: "heartbeat-schedule-margin" });
    const reserve = queue[workerHeartbeatReservation].bind(queue);
    let rounds: Round[] = [];
    vi.spyOn(queue, workerHeartbeatReservation).mockImplementation((intervalMs) => {
      const channel = reserve(intervalMs);
      if (channel !== undefined) rounds = recordRounds(channel);
      return channel;
    });
    let precondition: string | undefined;
    let aborted = false;
    let handlerStartedAt = 0;
    let abortedAt: number | undefined;
    const worker = new Worker(queue, {
      workerId: "schedule-margin-worker",
      queue: "heartbeat-schedule-margin",
      leaseMs,
      heartbeatMs,
      registryIntervalMs: 0,
    }).handle("margin", async (_payload, context) => {
      const started = performance.now();
      handlerStartedAt = started;
      context.signal.addEventListener("abort", () => {
        abortedAt = performance.now();
      });
      const commit = await blockHeartbeats();
      try {
        // The test must hold the lock before the first round starts, and release it when that round
        // ends, before the second round falls due.
        if (rounds.length > 0) {
          precondition = "precondition not met: the first round started before the table lock";
          return null;
        }
        const until = started + 1.9 * heartbeatMs;
        while (rounds[0]?.endedAt === undefined && performance.now() < until) await sleep(10);
      } finally {
        await commit();
      }
      const released = performance.now() - started;
      if (released > 1.9 * heartbeatMs) {
        precondition = `precondition not met: the table lock ended ${Math.round(released)} ms after the handler started`;
        return null;
      }
      if (rounds[0]?.failed !== true) {
        precondition = "precondition not met: the first round did not time out";
        return null;
      }
      // Run past the end of the lease from the claim, so only a renewal keeps the task.
      await sleep(Math.max(0, started + 2.6 * heartbeatMs - performance.now()));
      aborted = context.signal.aborted;
      return null;
    });
    try {
      expect(await worker.runOnce()).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(precondition).toBeUndefined();
    // If the lease ends, the message gives the round times from the start of the handler. They show
    // if the host was slow or if a round was late.
    const since = (time: number | undefined) =>
      time === undefined ? "none" : `${Math.round(time - handlerStartedAt)} ms`;
    expect(
      aborted,
      `the lease ended at ${since(abortedAt)}; rounds: ${rounds
        .map((round) => `${since(round.startedAt)} to ${since(round.endedAt)}`)
        .join(", ")}`,
    ).toBe(false);
    expect(await outcomeState(id)).toBe("succeeded");
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    expect(rounds[1]!.failed).toBeUndefined();
    // The second round falls due one interval after the first round started.
    expect(rounds[1]!.startedAt - rounds[0]!.startedAt).toBeLessThan(1.25 * heartbeatMs);
  });

  it("sends one round at a time and starts one overdue round without replaying missed slots", async () => {
    // Shared rounds have no deadline, so a round on a locked row lasts until the lock ends. The
    // checks read the slots that the worker stores and the timers that it arms. They do not
    // measure gaps, so a slow host cannot fail them (SM-1670). Each wait for a round allows 15 s,
    // because a COMMIT on a host with a slow disk can take some seconds.
    const heartbeatMs = 200;
    const rounds = recordRounds(
      queue as unknown as Parameters<typeof recordRounds>[0],
      0,
      0,
      () => (worker as unknown as HeartbeatSchedule).nextHeartbeatAt,
    );
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const worker = new Worker(unreservedQueue(queue), {
      workerId: "schedule-flight-worker",
      queue: "heartbeat-schedule-flight",
      concurrency: 2,
      leaseMs: 30_000,
      heartbeatMs,
      pollMs: 20,
      registryIntervalMs: 0,
    }).handle("flight", async (_payload, context) => {
      started.push(context.task.id);
      await released;
      return null;
    });
    const schedule = worker as unknown as HeartbeatSchedule;
    const timers = recordHeartbeatTimers(worker);
    const controller = new AbortController();
    const run = worker.run(controller.signal);
    try {
      const first = await queue.enqueue("flight", {}, { queue: "heartbeat-schedule-flight" });
      await vi.waitFor(() => expect(started).toEqual([first]), { timeout: 15_000, interval: 10 });
      const commit = await blockHeartbeats();
      try {
        await vi.waitFor(() => expect(rounds.length).toBe(1), { timeout: 15_000, interval: 5 });
        // A lease that registers during the round must not start a second round.
        const second = await queue.enqueue("flight", {}, { queue: "heartbeat-schedule-flight" });
        await vi.waitFor(() => expect(started).toEqual([first, second]), {
          timeout: 15_000,
          interval: 10,
        });
        // Hold the round until it has missed three slots. While it is in flight, the worker arms
        // no timer, so no second round can start.
        await vi.waitFor(
          () => expect(performance.now()).toBeGreaterThan(rounds[0]!.slot! + 2 * heartbeatMs),
          { timeout: 15_000, interval: 10 },
        );
        expect(schedule.heartbeatInFlight).toBe(true);
        expect(schedule.heartbeatTimer).toBeUndefined();
        expect(rounds.length).toBe(1);
      } finally {
        await commit();
      }
      await vi.waitFor(() => expect(rounds[2]?.endedAt).toBeDefined(), {
        timeout: 15_000,
        interval: 10,
      });
      // No round started before the round before it ended.
      for (let index = 1; index < rounds.length; index += 1) {
        expect(rounds[index - 1]!.endedAt).toBeDefined();
        expect(rounds[index]!.startedAt).toBeGreaterThanOrEqual(rounds[index - 1]!.endedAt!);
      }
      // When the first round ends, the worker arms one timer for the slot that the round missed.
      // That slot is already past, so the timer has no delay and the overdue round starts at once.
      const afterFirst = timers.find((timer) => timer.at >= rounds[0]!.endedAt!);
      expect(afterFirst).toMatchObject({ dueAt: rounds[0]!.slot, delayMs: 0, retry: false });
      // The overdue round counts the next slot from its own send, which follows the end of the
      // first round. A schedule that replays the missed slots would keep a slot before that end.
      const overdueSentAt = rounds[1]!.slot! - heartbeatMs;
      expect(overdueSentAt).toBeGreaterThanOrEqual(rounds[0]!.endedAt!);
      const afterOverdue = timers.find((timer) => timer.at >= rounds[1]!.endedAt!);
      expect(afterOverdue).toMatchObject({ dueAt: rounds[1]!.slot, retry: false });
      expect(rounds[2]!.startedAt - overdueSentAt).toBeGreaterThanOrEqual(0.9 * heartbeatMs);
    } finally {
      release();
      controller.abort();
      try {
        await run;
      } finally {
        // Also removes the timer recording, which replaces the global clearTimeout.
        vi.restoreAllMocks();
      }
    }
  }, 60_000);

  it("keeps the slot of a lease that registers while the round of an earlier lease is in flight", async () => {
    // The first task finishes during a slow round, so no lease remains. The second task registers
    // during that round. Its slot is one interval after it registered, which is before the slow
    // round ends, so its round starts when the slow round ends.
    //
    // The first task must finish, and the second task must register, by 0.5 intervals before the
    // slow round ends. The slow round waits 5 intervals, so that window is 900 ms, not 300 ms. At a
    // 1-minute load of 35 on 32 cores, the second task registered up to 100 ms after the slow round
    // started (SM-1479).
    const heartbeatMs = 200;
    const rounds = recordRounds(
      queue as unknown as Parameters<typeof recordRounds>[0],
      5 * heartbeatMs,
    );
    let finishFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registered: number[] = [];
    const worker = new Worker(unreservedQueue(queue), {
      workerId: "schedule-replacement-worker",
      queue: "heartbeat-schedule-replacement",
      concurrency: 2,
      leaseMs: 30_000,
      heartbeatMs,
      pollMs: 20,
      registryIntervalMs: 0,
    })
      .handle("first", async () => {
        await firstFinished;
        return null;
      })
      .handle("second", async () => {
        registered.push(performance.now());
        await released;
        return null;
      });
    const controller = new AbortController();
    const run = worker.run(controller.signal);
    try {
      const first = await queue.enqueue("first", {}, { queue: "heartbeat-schedule-replacement" });
      await vi.waitFor(() => expect(rounds.length).toBe(1), { timeout: 5_000, interval: 5 });
      finishFirst();
      await vi.waitFor(async () => expect(await outcomeState(first)).toBe("succeeded"), {
        timeout: 5_000,
        interval: 10,
      });
      await queue.enqueue("second", {}, { queue: "heartbeat-schedule-replacement" });
      await vi.waitFor(() => expect(registered.length).toBe(1), { timeout: 5_000, interval: 5 });
      expect(rounds[0]!.endedAt).toBeUndefined();
      await vi.waitFor(() => expect(rounds.length).toBe(2), { timeout: 5_000, interval: 5 });
      expect(rounds[1]!.startedAt - rounds[0]!.endedAt!).toBeLessThan(heartbeatMs / 2);
    } finally {
      release();
      controller.abort();
      await run;
      vi.restoreAllMocks();
    }
  });

  it("starts one round at a time when each round uses a whole interval", async () => {
    // Up to an interval of 50 ms, the round bound equals the interval. A round that uses all of it
    // ends at the next slot, so the next round starts at once. No second round starts during it,
    // and no burst of rounds follows.
    const heartbeatMs = 50;
    const rounds = recordRounds(
      queue as unknown as Parameters<typeof recordRounds>[0],
      0,
      heartbeatMs,
    );
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new Worker(unreservedQueue(queue), {
      workerId: "schedule-whole-bound-worker",
      queue: "heartbeat-schedule-whole-bound",
      leaseMs: 30_000,
      heartbeatMs,
      pollMs: 20,
      registryIntervalMs: 0,
    }).handle("whole", async () => {
      await released;
      return null;
    });
    const controller = new AbortController();
    const run = worker.run(controller.signal);
    try {
      await queue.enqueue("whole", {}, { queue: "heartbeat-schedule-whole-bound" });
      await vi.waitFor(() => expect(rounds[6]?.endedAt).toBeDefined(), {
        timeout: 10_000,
        interval: 10,
      });
      const ended = rounds.filter((round) => round.endedAt !== undefined);
      for (let index = 1; index < ended.length; index += 1) {
        expect(ended[index]!.startedAt).toBeGreaterThanOrEqual(ended[index - 1]!.endedAt!);
        // Each round starts one interval or more after the previous round started.
        expect(ended[index]!.startedAt - ended[index - 1]!.startedAt).toBeGreaterThanOrEqual(
          0.9 * heartbeatMs,
        );
      }
    } finally {
      release();
      controller.abort();
      await run;
      vi.restoreAllMocks();
    }
  });
});

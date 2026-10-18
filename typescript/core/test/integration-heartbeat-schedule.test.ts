import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { HeartbeatStatus } from "../src/index.js";
import { Worker } from "../src/index.js";
import { workerHeartbeatReservation } from "../src/worker-internal.js";
import { createIntegrationTestContext } from "./support/integration.js";

// Heartbeat rounds start on a fixed schedule: each round falls due one heartbeatMs after the
// previous round started, not after it ended. So one round that times out does not move the next
// round toward the end of the lease (SM-1444).

const { pool, queue } = createIntegrationTestContext(import.meta.url);

interface Round {
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
}

/** Hold the row lock of `taskId` in an open transaction, and return the function that commits. */
async function lockRow(taskId: string): Promise<() => Promise<void>> {
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", [
      taskId,
    ]);
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
    heartbeatMany: (...args: never[]) => Promise<Map<string, HeartbeatStatus>>;
  },
  firstDelayMs = 0,
  everyDelayMs = 0,
): Round[] {
  const rounds: Round[] = [];
  const original = target.heartbeatMany.bind(target) as (
    ...args: unknown[]
  ) => Promise<Map<string, HeartbeatStatus>>;
  vi.spyOn(target, "heartbeatMany").mockImplementation(async (...args: never[]) => {
    const round: Round = { startedAt: performance.now() };
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
  it("keeps a renewal margin after one timed-out round", async () => {
    // The lease is 2.3 heartbeat intervals, shorter than the default of 3. The row lock makes the
    // first round time out on the server at about 1.4 intervals. The fixed schedule sends the next
    // round at 2 intervals, inside the lease. A schedule that waits one interval after the failed
    // round ends sends it at about 2.4 intervals, after the lease.
    const heartbeatMs = 1_000;
    const leaseMs = 2_300;
    const id = await queue.enqueue("margin", {}, { queue: "heartbeat-schedule-margin" });
    const reserve = queue[workerHeartbeatReservation].bind(queue);
    let rounds: Round[] = [];
    vi.spyOn(queue, workerHeartbeatReservation).mockImplementation(() => {
      const channel = reserve();
      if (channel !== undefined) rounds = recordRounds(channel);
      return channel;
    });
    let aborted = false;
    const worker = new Worker(queue, {
      workerId: "schedule-margin-worker",
      queue: "heartbeat-schedule-margin",
      leaseMs,
      heartbeatMs,
      registryIntervalMs: 0,
    }).handle("margin", async (_payload, context) => {
      const started = performance.now();
      const commit = await lockRow(context.task.id);
      try {
        await sleep(1.6 * heartbeatMs);
      } finally {
        await commit();
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
    expect(aborted).toBe(false);
    expect(await outcomeState(id)).toBe("succeeded");
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    expect(rounds[0]!.failed).toBe(true);
    expect(rounds[1]!.failed).toBeUndefined();
    // The second round falls due one interval after the first round started.
    expect(rounds[1]!.startedAt - rounds[0]!.startedAt).toBeLessThan(1.25 * heartbeatMs);
  });

  it("sends one round at a time and starts one overdue round without replaying missed slots", async () => {
    // Shared rounds have no deadline, so a round on a locked row lasts until the lock ends.
    const heartbeatMs = 200;
    const rounds = recordRounds(queue as unknown as Parameters<typeof recordRounds>[0]);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const worker = new Worker(queue, {
      workerId: "schedule-flight-worker",
      queue: "heartbeat-schedule-flight",
      concurrency: 2,
      leaseMs: 30_000,
      heartbeatMs,
      pollMs: 20,
      registryIntervalMs: 0,
      sharedHeartbeats: true,
    }).handle("flight", async (_payload, context) => {
      started.push(context.task.id);
      await released;
      return null;
    });
    const controller = new AbortController();
    const run = worker.run(controller.signal);
    try {
      const first = await queue.enqueue("flight", {}, { queue: "heartbeat-schedule-flight" });
      await vi.waitFor(() => expect(started).toEqual([first]), { timeout: 5_000, interval: 10 });
      const commit = await lockRow(first);
      try {
        await vi.waitFor(() => expect(rounds.length).toBe(1), { timeout: 5_000, interval: 5 });
        // A lease that registers during the round must not start a second round.
        const second = await queue.enqueue("flight", {}, { queue: "heartbeat-schedule-flight" });
        await vi.waitFor(() => expect(started).toEqual([first, second]), {
          timeout: 5_000,
          interval: 10,
        });
        await sleep(3.5 * heartbeatMs);
        expect(rounds.length).toBe(1);
      } finally {
        await commit();
      }
      await vi.waitFor(() => expect(rounds[2]?.endedAt).toBeDefined(), {
        timeout: 5_000,
        interval: 10,
      });
      // No round started before the round before it ended.
      for (let index = 1; index < rounds.length; index += 1) {
        expect(rounds[index - 1]!.endedAt).toBeDefined();
        expect(rounds[index]!.startedAt).toBeGreaterThanOrEqual(rounds[index - 1]!.endedAt!);
      }
      // The first round missed three slots. One overdue round starts when it ends, and the next
      // round falls due one interval after that start.
      expect(rounds[1]!.startedAt - rounds[0]!.endedAt!).toBeLessThan(heartbeatMs / 2);
      expect(rounds[2]!.startedAt - rounds[1]!.startedAt).toBeGreaterThanOrEqual(0.9 * heartbeatMs);
    } finally {
      release();
      controller.abort();
      await run;
      vi.restoreAllMocks();
    }
  });

  it("keeps the slot of a lease that registers while the round of an earlier lease is in flight", async () => {
    // The first task finishes during a slow round, so no lease remains. The second task registers
    // during that round. Its slot is one interval after it registered, which is before the slow
    // round ends, so its round starts when the slow round ends.
    const heartbeatMs = 200;
    const rounds = recordRounds(
      queue as unknown as Parameters<typeof recordRounds>[0],
      2 * heartbeatMs,
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
    const worker = new Worker(queue, {
      workerId: "schedule-replacement-worker",
      queue: "heartbeat-schedule-replacement",
      concurrency: 2,
      leaseMs: 30_000,
      heartbeatMs,
      pollMs: 20,
      registryIntervalMs: 0,
      sharedHeartbeats: true,
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
    const worker = new Worker(queue, {
      workerId: "schedule-whole-bound-worker",
      queue: "heartbeat-schedule-whole-bound",
      leaseMs: 30_000,
      heartbeatMs,
      pollMs: 20,
      registryIntervalMs: 0,
      sharedHeartbeats: true,
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

import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedTask, HeartbeatBatchStatus, HeartbeatStatus } from "../src/types.js";
import { Worker, type WorkerQueueApi } from "../src/worker.js";
import { workerHeartbeatReservation, type WorkerHeartbeatChannel } from "../src/worker-internal.js";

function claimedTask(id: string): ClaimedTask {
  return {
    id,
    queue: "default",
    type: "heartbeat-failure",
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

function fakeQueue(task: ClaimedTask, heartbeatStatus: WorkerQueueApi["heartbeatStatus"]) {
  const completed: string[] = [];
  const fail = vi.fn<WorkerQueueApi["fail"]>(async () => "failed");
  const queue = {
    defaultQueue: "default",
    claim: async () => task,
    heartbeatStatus,
    complete: async (claimed: ClaimedTask) => {
      completed.push(claimed.id);
      return true;
    },
    fail,
    tick: async () => [],
    runMaintenance: async () => [],
  } as unknown as WorkerQueueApi;
  return { queue, completed, fail };
}

describe("worker heartbeat failures", () => {
  it("keeps a task running through one failed heartbeat and renews it on the next round", async () => {
    let calls = 0;
    const { queue, completed, fail } = fakeQueue(
      claimedTask("survives-one-heartbeat-error"),
      async (): Promise<HeartbeatStatus> => {
        calls += 1;
        if (calls === 1) throw new Error("heartbeat connection reset");
        return "accepted";
      },
    );
    let abortedBy: unknown;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      leaseMs: 1_000,
      heartbeatMs: 10,
    }).handle("heartbeat-failure", async (_payload, context) => {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
      abortedBy = context.signal.reason;
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(abortedBy).toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
    expect(completed).toEqual(["survives-one-heartbeat-error"]);
  });

  it("aborts a handler locally once no heartbeat has been accepted for one lease", async () => {
    let calls = 0;
    const { queue, completed, fail } = fakeQueue(
      claimedTask("hung-heartbeat"),
      (): Promise<HeartbeatStatus> => {
        calls += 1;
        // A heartbeat that never answers, like a call stuck behind an exhausted pool.
        return new Promise<never>(() => {
          // Never settles.
        });
      },
    );
    const leaseMs = 200;
    let abortedAfterMs: number | undefined;
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      leaseMs,
      heartbeatMs: 20,
    }).handle("heartbeat-failure", async (_payload, context) => {
      const startedAt = Date.now();
      const aborted = new Promise<boolean>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(true), { once: true });
      });
      if (await Promise.race([aborted, sleep(leaseMs * 10).then(() => false)])) {
        abortedAfterMs = Date.now() - startedAt;
        throw context.signal.reason;
      }
      return null;
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(calls).toBe(1);
    expect(abortedAfterMs).toBeDefined();
    expect(abortedAfterMs!).toBeLessThan(leaseMs * 3);
    expect(completed).toEqual([]);
    expect(fail).not.toHaveBeenCalled();
  });
});

interface ChannelRound {
  startedAt: number;
  timeoutMs: number;
}

/**
 * A queue that lends a reserved heartbeat channel. `answer` runs for each round on the channel,
 * with its index, and returns the statuses.
 */
function reservingQueue(
  task: ClaimedTask,
  answer: (round: number) => Promise<HeartbeatBatchStatus>,
) {
  const { queue, completed } = fakeQueue(task, async () => "accepted");
  const rounds: ChannelRound[] = [];
  const channel = {
    reserve: vi.fn<() => void>(),
    heartbeatMany: vi.fn<WorkerHeartbeatChannel["heartbeatMany"]>(
      async (tasks, _workerId, _leaseMs, timeoutMs) => {
        const index = rounds.push({ startedAt: performance.now(), timeoutMs }) - 1;
        const status = await answer(index);
        return new Map(tasks.map((claimed) => [claimed.id, status]));
      },
    ),
    close: vi.fn<() => Promise<void>>(async () => undefined),
  };
  Object.assign(queue, { [workerHeartbeatReservation]: () => channel });
  return { queue, completed, channel, rounds };
}

describe("worker busy retry deadline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // With heartbeatMs 400, a round has a bound of 300 ms, and a busy retry falls due 50 ms after
  // the busy round ends, because the jitter is 0. The busy round ends `gapMs` + 50 ms before the
  // next regular slot, so the retry falls due about `gapMs` before that slot.
  const heartbeatMs = 400;
  const retryDelayMs = 50;

  async function runBusyRound(gapMs: number) {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { queue, completed, channel, rounds } = reservingQueue(
      claimedTask(`busy-retry-gap-${gapMs}`),
      async (round) => {
        if (round > 0) return "accepted";
        await sleep(heartbeatMs - retryDelayMs - gapMs);
        return "busy";
      },
    );
    const worker = new Worker(queue, {
      registryIntervalMs: 0,
      leaseMs: 30_000,
      heartbeatMs,
    }).handle("heartbeat-failure", async () => {
      await vi.waitFor(() => expect(rounds.length).toBeGreaterThanOrEqual(2), {
        timeout: 5 * heartbeatMs,
        interval: 5,
      });
      return null;
    });
    await expect(worker.runOnce()).resolves.toBe(true);
    return { completed, channel, rounds };
  }

  it("skips a busy retry with less than the minimum left and renews at the next regular slot", async () => {
    const { completed, channel, rounds } = await runBusyRound(10);

    // The second round is the regular one: it has the full bound and starts one interval after
    // the first. The retry sent nothing in between.
    expect(rounds).toHaveLength(2);
    expect(rounds[1]!.timeoutMs).toBe(300);
    expect(rounds[1]!.startedAt - rounds[0]!.startedAt).toBeGreaterThanOrEqual(0.9 * heartbeatMs);
    // The worker used one reserved channel for both rounds.
    expect(channel.reserve).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(completed).toEqual(["busy-retry-gap-10"]);
  });

  it("runs a busy retry with at least the minimum left, bounded by the next regular slot", async () => {
    const { completed, rounds } = await runBusyRound(80);

    expect(rounds[1]!.timeoutMs).toBeGreaterThanOrEqual(20);
    // Timers can fire a little early or late, so the bound gets a few milliseconds of slack.
    expect(rounds[1]!.timeoutMs).toBeLessThanOrEqual(90);
    expect(rounds[1]!.startedAt - rounds[0]!.startedAt).toBeLessThan(heartbeatMs);
    expect(completed).toEqual(["busy-retry-gap-80"]);
  });
});

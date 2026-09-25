import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FastTierUnsupportedError, Worker } from "../src/index.js";
import { InjectedCrashError } from "../src/worker.js";
import { createIntegrationTestContext } from "./support/integration.js";

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

async function makeFast(queueName: string): Promise<void> {
  await expect(
    admin.setQueueTier(queueName, "fast", adminAudit("move to the fast tier")),
  ).resolves.toBe("fast");
}

async function outcomeCounts(ids: readonly string[]) {
  const result = await pool.query<{ task_id: string; state: string; attempt: number }>(
    `SELECT task_id::text, state, attempt FROM workhorse.fast_task_outcome
      WHERE task_id = ANY($1::uuid[])`,
    [ids],
  );
  return result.rows;
}

async function runUntil(worker: Worker, done: () => Promise<boolean>): Promise<void> {
  const controller = new AbortController();
  const run = worker.run(controller.signal);
  try {
    await vi.waitFor(
      async () => {
        expect(await done()).toBe(true);
      },
      { timeout: 20_000, interval: 20 },
    );
  } finally {
    controller.abort();
    worker.stop();
    await run;
  }
}

describe("fast task tier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects full-tier enqueue features with the queue, feature, and ordinal", async () => {
    await makeFast("fast-enqueue");

    await expect(
      queue.enqueue("keyed", {}, { queue: "fast-enqueue", concurrencyKey: "tenant-a" }),
    ).rejects.toMatchObject({
      name: "FastTierUnsupportedError",
      queue: "fast-enqueue",
      feature: "concurrency keys",
    });
    const rejected = await queue
      .enqueueMany([
        { type: "plain", payload: {}, options: { queue: "fast-enqueue" } },
        {
          type: "debounced",
          payload: {},
          options: {
            queue: "fast-enqueue",
            debounce: { key: "k", windowMs: 1_000, schedule: "reset" },
          },
        },
      ])
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(FastTierUnsupportedError);
    expect(rejected).toMatchObject({ feature: "debounce", ordinal: 2 });

    const id = await queue.enqueue("plain", { n: 1 }, { queue: "fast-enqueue" });
    await expect(admin.getTask(id)).resolves.toMatchObject({ id, state: "ready" });
    const stored = await pool.query(
      "SELECT count(*)::integer AS count FROM workhorse.fast_task_runtime WHERE task_id = $1",
      [id],
    );
    expect(stored.rows[0]).toEqual({ count: 1 });
  });

  it("refuses a tier change while the queue holds live tasks", async () => {
    await queue.enqueue("live", {}, { queue: "tier-change" });
    await expect(
      admin.setQueueTier("tier-change", "fast", adminAudit("too early")),
    ).rejects.toMatchObject({ name: "FastTierUnsupportedError", feature: "tier change" });

    await admin.purgeQueue("tier-change", adminAudit("empty the queue"));
    await makeFast("tier-change");
    await expect(admin.setQueueTier("tier-change", "full", adminAudit("move back"))).resolves.toBe(
      "full",
    );
  });

  it("runs fast tasks through batched completion without exceeding the concurrency", async () => {
    await makeFast("fast-run");
    const taskIds = await queue.enqueueMany(
      Array.from({ length: 120 }, (_, sequence) => ({
        type: "square",
        payload: { sequence },
        options: { queue: "fast-run" },
      })),
    );
    const claimFast = vi.spyOn(queue, "claimFast");
    let running = 0;
    let maxRunning = 0;
    let maxSlots = 0;
    const concurrency = 6;
    const worker = new Worker(queue, {
      workerId: "fast-runner",
      queue: "fast-run",
      concurrency,
      pollMs: 5,
    }).handle<{ sequence: number }>("square", async ({ sequence }) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      maxSlots = Math.max(maxSlots, worker.runtimeState().activeSlots);
      await sleep(sequence % 3);
      running -= 1;
      return { square: sequence * sequence };
    });

    await runUntil(worker, async () => (await outcomeCounts(taskIds)).length === taskIds.length);

    expect(maxRunning).toBeLessThanOrEqual(concurrency);
    expect(maxSlots).toBeLessThanOrEqual(concurrency);
    expect(worker.runtimeState().activeSlots).toBe(0);
    const outcomes = await outcomeCounts(taskIds);
    expect(outcomes.every((row) => row.state === "succeeded" && row.attempt === 1)).toBe(true);
    // Completions claimed most tasks in the same round trip, so plain claims leased fewer.
    const plainClaims = await Promise.all(
      claimFast.mock.results.map((result) => result.value as Promise<unknown[]>),
    );
    expect(plainClaims.reduce((sum, claimed) => sum + claimed.length, 0)).toBeLessThan(
      taskIds.length / 2,
    );
    await expect(admin.getTask<{ square: number }>(taskIds[7]!)).resolves.toMatchObject({
      state: "succeeded",
      result: { square: 49 },
    });
    const runtime = await pool.query(
      "SELECT count(*)::integer AS count FROM workhorse.fast_task_runtime WHERE queue_name = $1",
      ["fast-run"],
    );
    expect(runtime.rows[0]).toEqual({ count: 0 });
  });

  it.each([
    ["checkpoints", (context: CheckpointContext) => context.checkpoint("step", () => 1)],
    ["progress", (context: CheckpointContext) => context.setProgress({ done: 1 })],
    ["durable waits", (context: CheckpointContext) => context.sleep("pause", 10)],
    [
      "child tasks",
      (context: CheckpointContext) =>
        context.runChild("child", "leaf", {}, { queue: "fast-guard" }),
    ],
  ] as const)("fails an attempt that uses %s before any round trip", async (feature, operation) => {
    await makeFast("fast-guard");
    const id = await queue.enqueue("guarded", {}, { queue: "fast-guard", maxAttempts: 1 });
    const query = vi.spyOn(pool, "query");
    let rejection: unknown;
    const worker = new Worker(queue, { workerId: "guard", queue: "fast-guard" }).handle(
      "guarded",
      async (_payload, context) => {
        const before = query.mock.calls.length;
        rejection = await Promise.resolve(operation(context)).catch((error: unknown) => error);
        expect(query.mock.calls.length).toBe(before);
        throw rejection;
      },
    );
    expect(await worker.runOnce()).toBe(true);
    query.mockRestore();

    expect(rejection).toBeInstanceOf(FastTierUnsupportedError);
    expect(rejection).toMatchObject({ queue: "fast-guard", feature });
    await expect(admin.getTask(id)).resolves.toMatchObject({
      state: "failed",
      error: expect.objectContaining({ name: "FastTierUnsupportedError" }),
    });
  });

  it("claims a full-tier queue after its fast claim is rejected", async () => {
    const id = await queue.enqueue("full-work", {}, { queue: "full-queue" });
    const claimFast = vi.spyOn(queue, "claimFast");
    const worker = new Worker(queue, { workerId: "prober", queue: "full-queue" }).handle(
      "full-work",
      () => ({ ok: true }),
    );
    expect(await worker.runOnce()).toBe(true);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "succeeded" });
    await expect(claimFast.mock.results[0]!.value).rejects.toMatchObject({
      name: "FastTierUnsupportedError",
      feature: "batched completion",
    });

    // The worker remembers the full tier and claims the next task without probing again.
    await queue.enqueue("full-work", {}, { queue: "full-queue" });
    expect(await worker.runOnce()).toBe(true);
    expect(claimFast).toHaveBeenCalledTimes(1);
  });

  it("completes a fast task whose queue left the fast tier through complete_v1", async () => {
    await makeFast("fast-fallback");
    const id = await queue.enqueue("late", {}, { queue: "fast-fallback" });
    const [task] = await queue.claimFast("fallback-worker", 1, { queue: "fast-fallback" });
    expect(task?.id).toBe(id);
    await expect(
      queue.completeAndClaim(
        task!,
        "fallback-worker",
        { ok: true },
        {
          queue: "not-fast",
          limit: 1,
        },
      ),
    ).rejects.toMatchObject({ name: "FastTierUnsupportedError", feature: "batched completion" });
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "active" });
    await expect(queue.complete(task!, "fallback-worker", { ok: true })).resolves.toBe(true);
    await expect(admin.getTask(id)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("records attempts and claims only when the queue opts in", async () => {
    await makeFast("fast-history");
    await expect(admin.setQueueHistory("fast-history", { recordAttempts: true })).resolves.toEqual({
      recordAttempts: true,
      recordClaims: false,
    });
    const id = await queue.enqueue("recorded", {}, { queue: "fast-history" });
    const worker = new Worker(queue, { workerId: "historian", queue: "fast-history" }).handle(
      "recorded",
      () => ({ ok: true }),
    );
    expect(await worker.runOnce()).toBe(true);
    const attempts = await pool.query(
      `SELECT attempt, outcome FROM workhorse.dashboard_attempt_history_v1 WHERE task_id = $1`,
      [id],
    );
    expect(attempts.rows).toEqual([{ attempt: 1, outcome: "succeeded" }]);
  });

  it("counts a fast-tier outcome in the retention preview", async () => {
    await makeFast("fast-retention");
    const id = await queue.enqueue("expired", {}, { queue: "fast-retention" });
    const worker = new Worker(queue, { workerId: "retainer", queue: "fast-retention" }).handle(
      "expired",
      () => ({ ok: true }),
    );
    expect(await worker.runOnce()).toBe(true);
    await pool.query("UPDATE workhorse.task SET created_at = '2020-01-01' WHERE id = $1", [id]);
    await pool.query(
      "UPDATE workhorse.fast_task_outcome SET finished_at = '2020-01-02' WHERE task_id = $1",
      [id],
    );

    await expect(
      queue.previewRetentionPolicy({
        taskIdentityRetentionDays: 1,
        terminalOutcomeRetentionDays: 1,
      }),
    ).resolves.toMatchObject({ eligible: { terminalTasks: 1 } });
  });

  it("loses no task and records one outcome each after a worker crash", async () => {
    await makeFast("fast-crash");
    const total = 60;
    const concurrency = 4;
    const ids = await queue.enqueueMany(
      Array.from({ length: total }, (_, sequence) => ({
        type: "effect",
        payload: { sequence },
        options: { queue: "fast-crash", maxAttempts: 3 },
      })),
    );
    const effects = new Map<string, number>();
    const handler = (_payload: unknown, context: { task: { id: string } }) => {
      effects.set(context.task.id, (effects.get(context.task.id) ?? 0) + 1);
      return { ok: true };
    };

    // After twenty completions, every execution that reaches its completion write crashes, which
    // models the process vanishing with its handlers done and their outcomes unwritten.
    let completions = 0;
    const crashing = new Worker(queue, {
      workerId: "crashing",
      queue: "fast-crash",
      concurrency,
      leaseMs: 500,
      heartbeatMs: 100,
      pollMs: 5,
      failpoint: (point) => {
        if (point !== "beforeComplete") return false;
        completions += 1;
        return completions > 20;
      },
    }).handle("effect", handler);
    await expect(crashing.run()).rejects.toBeInstanceOf(InjectedCrashError);

    await sleep(600);
    await queue.recoverExpired();
    const survivor = new Worker(queue, {
      workerId: "survivor",
      queue: "fast-crash",
      concurrency,
      pollMs: 5,
    }).handle("effect", handler);
    await runUntil(survivor, async () => (await outcomeCounts(ids)).length === total);

    const outcomes = await outcomeCounts(ids);
    expect(new Set(outcomes.map((row) => row.task_id)).size).toBe(total);
    expect(outcomes.every((row) => row.state === "succeeded")).toBe(true);
    expect(ids.every((id) => (effects.get(id) ?? 0) >= 1)).toBe(true);
    const rerun = ids.filter((id) => (effects.get(id) ?? 0) > 1);
    expect(rerun.length).toBeGreaterThan(0);
    expect(rerun.length).toBeLessThanOrEqual(concurrency);
    expect(Math.max(...effects.values())).toBe(2);
  });
});

type CheckpointContext = Parameters<Parameters<Worker["handle"]>[1]>[1];

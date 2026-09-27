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

    await makeFast("fast-no-history");
    const unrecorded = await queue.enqueue("recorded", {}, { queue: "fast-no-history" });
    const quiet = new Worker(queue, { workerId: "quiet", queue: "fast-no-history" }).handle(
      "recorded",
      () => ({ ok: true }),
    );
    expect(await quiet.runOnce()).toBe(true);
    await expect(admin.getTask(unrecorded)).resolves.toMatchObject({ state: "succeeded" });
    const none = await pool.query(
      `SELECT attempt FROM workhorse.attempt_history WHERE task_id = $1`,
      [unrecorded],
    );
    expect(none.rows).toEqual([]);
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

  // Concurrency 4 has one cohort; 16 has two and 64 has eight, so a crash drops every cohort's
  // unwritten outcomes at once.
  // A worker's batched completion and its heartbeat round name the same rows. Both must lock them
  // in task ID order, or each can hold a row the other waits for. While another transaction holds
  // the lowest ID, each call must wait for it before it locks any higher ID.
  it.each([
    [
      "fast_heartbeat_many_v1",
      "SELECT count(*)::integer AS count FROM workhorse.fast_heartbeat_many_v1($1, $2::uuid[], $3::bigint[], $4::integer[])",
      60_000,
    ],
    [
      "fast_complete_many_v1",
      "SELECT cardinality(workhorse.fast_complete_many_v1($1, $2::uuid[], $3::bigint[], $4::jsonb[]))::integer AS count",
      { ok: true },
    ],
  ] as const)("%s locks the worker's rows in task ID order", async (name, statement, value) => {
    const queueName = `fast-lock-order-${name}`;
    const workerId = `lock-order-${name}`;
    await makeFast(queueName);
    const ids = await queue.enqueueMany(
      Array.from({ length: 3 }, () => ({
        type: "held",
        payload: {},
        options: { queue: queueName },
      })),
    );
    await pool.query(
      `UPDATE workhorse.fast_task_runtime
          SET state = 'active', worker_id = $2, claimed_at = clock_timestamp(),
              expires_at = clock_timestamp() + interval '1 hour', fence_token = 1
        WHERE task_id = ANY($1::uuid[])`,
      [ids, workerId],
    );
    const [lowest, ...higher] = ids.toSorted();
    const blocker = await pool.connect();
    const caller = await pool.connect();
    let call: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT FROM workhorse.fast_task_runtime WHERE task_id = $1 FOR UPDATE", [
        lowest,
      ]);
      const callerPid = (await caller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const descending = ids.toSorted().toReversed();
      call = caller.query<{ count: number }>(statement, [
        workerId,
        descending,
        descending.map(() => 1),
        descending.map(() => value),
      ]);
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
            [callerPid],
          );
          expect(waiting.rows[0]!.blocked).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
      const free = await pool.query<{ task_id: string }>(
        `SELECT task_id::text FROM workhorse.fast_task_runtime
          WHERE task_id = ANY($1::uuid[]) FOR UPDATE SKIP LOCKED`,
        [higher],
      );
      expect(free.rows.map((row) => row.task_id).toSorted()).toEqual(higher);
      await blocker.query("ROLLBACK");
      await expect(call).resolves.toMatchObject({ rows: [{ count: 3 }] });
    } finally {
      await blocker.query("ROLLBACK");
      await call?.catch(() => undefined);
      blocker.release();
      caller.release();
    }
  });

  // A heartbeat can name a task that the worker's own completion has just removed. That task must
  // not send the batch one lease at a time in input order, where it could deadlock the completion.
  it("heartbeat_many_v1 keeps task ID order when a named task has just completed", async () => {
    const queueName = "fast-lock-order-heartbeat-many";
    const workerId = "lock-order-heartbeat-many";
    await makeFast(queueName);
    const ids = await queue.enqueueMany(
      Array.from({ length: 4 }, () => ({
        type: "held",
        payload: {},
        options: { queue: queueName },
      })),
    );
    await pool.query(
      `UPDATE workhorse.fast_task_runtime
          SET state = 'active', worker_id = $2, claimed_at = clock_timestamp(),
              expires_at = clock_timestamp() + interval '1 hour', fence_token = 1
        WHERE task_id = ANY($1::uuid[])`,
      [ids, workerId],
    );
    const [completed, ...held] = ids;
    await pool.query("DELETE FROM workhorse.fast_task_runtime WHERE task_id = $1", [completed]);
    const [lowest, ...higher] = held.toSorted();
    const blocker = await pool.connect();
    const caller = await pool.connect();
    let call: Promise<{ rows: { task_id: string; status: string }[] }> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT FROM workhorse.fast_task_runtime WHERE task_id = $1 FOR UPDATE", [
        lowest,
      ]);
      const callerPid = (await caller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const leases = [...ids]
        .toSorted()
        .toReversed()
        .map((taskId) => ({ taskId, fenceToken: 1, leaseMs: 60_000 }));
      call = caller.query<{ task_id: string; status: string }>(
        `SELECT task_id::text AS task_id, status
           FROM workhorse.heartbeat_many_v1($1, $2::jsonb) ORDER BY ordinal`,
        [workerId, JSON.stringify(leases)],
      );
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
            [callerPid],
          );
          expect(waiting.rows[0]!.blocked).toBe(true);
        },
        { timeout: 10_000, interval: 20 },
      );
      const free = await pool.query<{ task_id: string }>(
        `SELECT task_id::text FROM workhorse.fast_task_runtime
          WHERE task_id = ANY($1::uuid[]) FOR UPDATE SKIP LOCKED`,
        [higher],
      );
      expect(free.rows.map((row) => row.task_id).toSorted()).toEqual(higher);
      await blocker.query("ROLLBACK");
      const { rows } = await call;
      expect(rows).toEqual(
        leases.map(({ taskId }) => ({
          task_id: taskId,
          status: taskId === completed ? "stale" : "accepted",
        })),
      );
    } finally {
      await blocker.query("ROLLBACK");
      await call?.catch(() => undefined);
      blocker.release();
      caller.release();
    }
  });

  // PostgreSQL measures a result as jsonb text, which spaces its separators. A result whose compact
  // JSON fits can still be over the limit, and an SDK that does not measure can send one. Only that
  // attempt fails: the rest of the batch completes and the fused claim still runs.
  it("fails only the oversized attempt of a fused completion batch", async () => {
    const queueName = "fast-oversized-result";
    const workerId = "oversized-result";
    await makeFast(queueName);
    const ids = await queue.enqueueMany(
      Array.from({ length: 3 }, () => ({
        type: "sized",
        payload: {},
        options: { queue: queueName },
      })),
    );
    await pool.query(
      `UPDATE workhorse.fast_task_runtime
          SET state = 'active', worker_id = $2, claimed_at = clock_timestamp(),
              expires_at = clock_timestamp() + interval '1 hour', fence_token = 1,
              result_max_bytes = 18
        WHERE task_id = ANY($1::uuid[])`,
      [ids, workerId],
    );
    const refill = await queue.enqueue("refill", {}, { queue: queueName });
    const [first, oversized, last] = ids;
    // {"items":[1,2,3]} is 17 bytes; its jsonb text {"items": [1, 2, 3]} is 20.
    const results = [{ ok: true }, { items: [1, 2, 3] }, { ok: false }];

    const { rows } = await pool.query<{ accepted: string[]; task_id: string | null }>(
      `SELECT accepted::text[] AS accepted, task_id::text AS task_id
         FROM workhorse.complete_many_and_claim_v1($1, $2::uuid[], $3::bigint[], $4::jsonb[], $5, 1)`,
      [workerId, ids, [1, 1, 1], results.map((result) => JSON.stringify(result)), queueName],
    );
    expect(rows.map((row) => row.task_id)).toEqual([refill]);
    expect(rows[0]!.accepted.toSorted()).toEqual([first, last].toSorted());
    expect(
      (await outcomeCounts(ids)).toSorted((a, b) => a.task_id.localeCompare(b.task_id)),
    ).toEqual(
      [first!, last!].toSorted().map((task_id) => ({ task_id, state: "succeeded", attempt: 1 })),
    );
    const retried = await pool.query(
      `SELECT state, attempt, worker_id, errors->0->'error' AS error
         FROM workhorse.fast_task_runtime WHERE task_id = $1`,
      [oversized],
    );
    expect(retried.rows).toEqual([
      {
        state: "ready",
        attempt: 2,
        worker_id: null,
        error: {
          name: "TaskValueSizeLimitError",
          message: "sized result exceeds its configured size limit",
          stack: null,
        },
      },
    ]);
  });

  it("raises for an oversized result of a single fast completion", async () => {
    const queueName = "fast-oversized-single";
    const workerId = "oversized-single";
    await makeFast(queueName);
    const id = await queue.enqueue("sized", {}, { queue: queueName });
    await pool.query(
      `UPDATE workhorse.fast_task_runtime
          SET state = 'active', worker_id = $2, claimed_at = clock_timestamp(),
              expires_at = clock_timestamp() + interval '1 hour', fence_token = 1,
              result_max_bytes = 18
        WHERE task_id = $1`,
      [id, workerId],
    );
    await expect(
      pool.query("SELECT workhorse.complete_v1($1, $2, 1, $3::jsonb)", [
        id,
        workerId,
        JSON.stringify({ items: [1, 2, 3] }),
      ]),
    ).rejects.toThrow(/result exceeds its configured size limit/);
    await expect(
      pool.query("SELECT state, attempt FROM workhorse.fast_task_runtime WHERE task_id = $1", [id]),
    ).resolves.toMatchObject({ rows: [{ state: "active", attempt: 1 }] });
  });

  it.each([4, 16, 64])(
    "loses no task and records one outcome each after a worker crash at concurrency %i",
    async (concurrency) => {
      const queueName = `fast-crash-${concurrency}`;
      await makeFast(queueName);
      const total = concurrency * 15;
      const ids = await queue.enqueueMany(
        Array.from({ length: total }, (_, sequence) => ({
          type: "effect",
          payload: { sequence },
          options: { queue: queueName, maxAttempts: 3 },
        })),
      );
      const effects = new Map<string, number>();
      const handler = (_payload: unknown, context: { task: { id: string } }) => {
        effects.set(context.task.id, (effects.get(context.task.id) ?? 0) + 1);
        return { ok: true };
      };

      // After a third of the tasks complete, every execution that reaches its completion write crashes, which
      // models the process vanishing with its handlers done and their outcomes unwritten.
      let completions = 0;
      const crashing = new Worker(queue, {
        workerId: `crashing-${concurrency}`,
        queue: queueName,
        concurrency,
        leaseMs: 500,
        heartbeatMs: 100,
        pollMs: 5,
        failpoint: (point) => {
          if (point !== "beforeComplete") return false;
          completions += 1;
          return completions > total / 3;
        },
      }).handle("effect", handler);
      await expect(crashing.run()).rejects.toBeInstanceOf(InjectedCrashError);

      await sleep(600);
      await queue.recoverExpired();
      const survivor = new Worker(queue, {
        workerId: `survivor-${concurrency}`,
        queue: queueName,
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
    },
  );
});

type CheckpointContext = Parameters<Parameters<Worker["handle"]>[1]>[1];

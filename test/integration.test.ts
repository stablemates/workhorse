import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InjectedCrashError,
  installSchema,
  MAX_ENQUEUE_BATCH_SIZE,
  Queue,
  Worker,
} from "../src/index.js";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../src/local-database.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const queue = new Queue(pool);

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS ironshift CASCADE");
  await installSchema(pool);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE ironshift.job_event, ironshift.attempt_history,
    ironshift.job_outcome, ironshift.job_runtime, ironshift.job RESTART IDENTITY CASCADE`);
  await pool.query("ALTER SEQUENCE ironshift.fence_token_seq RESTART WITH 1");
});

afterAll(async () => {
  await pool.end();
});

describe("live-runtime queue protocol", () => {
  it("installs schema v2 without compatibility write tables", async () => {
    const version = await pool.query<{ version: number }>(
      "SELECT max(version)::integer AS version FROM ironshift.schema_version",
    );
    expect(version.rows[0]?.version).toBe(2);

    const relations = await pool.query<{ relname: string }>(
      `
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ironshift'
         AND c.relname = ANY($1::text[])
         AND c.relkind IN ('r', 'p', 'v', 'm')`,
      [["job_current", "ready_job", "scheduled_job", "lease"]],
    );
    expect(relations.rows).toEqual([]);

    const indexes = await pool.query<{ indexname: string }>(
      `
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'ironshift'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [["job_runtime_expired_active_idx", "job_runtime_ready_idx", "job_runtime_scheduled_idx"]],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "job_runtime_expired_active_idx",
      "job_runtime_ready_idx",
      "job_runtime_scheduled_idx",
    ]);
  });

  it("enqueues a mixed batch atomically while preserving result and ready FIFO order", async () => {
    const runAt = new Date(Date.now() + 60_000);
    const ids = await queue.enqueueMany([
      { type: "first", payload: { order: 1 } },
      { type: "later", payload: { order: 2 }, options: { runAt } },
      { type: "third", payload: { order: 3 }, options: { maxAttempts: 5 } },
    ]);

    expect(ids).toHaveLength(3);
    expect((await queue.getJob(ids[0]!))?.type).toBe("first");
    expect((await queue.getJob(ids[1]!))?.state).toBe("scheduled");
    expect((await queue.getJob(ids[2]!))?.maxAttempts).toBe(5);
    expect((await queue.claim("worker-a"))?.id).toBe(ids[0]);
    expect((await queue.claim("worker-b"))?.id).toBe(ids[2]);

    const events = await pool.query<{ job_id: string; event_type: string }>(
      "SELECT job_id, event_type FROM ironshift.job_event WHERE event_type = 'enqueued' ORDER BY event_id",
    );
    expect(events.rows).toEqual(ids.map((jobId) => ({ job_id: jobId, event_type: "enqueued" })));
  });

  it("treats an empty enqueue batch as a query-free no-op", async () => {
    const transaction = { query: async () => Promise.reject(new Error("query must not run")) };
    await expect(queue.enqueueMany([], transaction)).resolves.toEqual([]);
  });

  it("bounds batch size client-side and classifies a batch against one timestamp", async () => {
    const transaction = { query: async () => Promise.reject(new Error("query must not run")) };
    const tooMany = Array.from({ length: MAX_ENQUEUE_BATCH_SIZE + 1 }, () => ({
      type: "bounded",
      payload: {},
    }));
    await expect(queue.enqueueMany(tooMany, transaction)).rejects.toThrow(
      `at most ${MAX_ENQUEUE_BATCH_SIZE}`,
    );

    const runAt = new Date(Date.now() + 20);
    const ids = await queue.enqueueMany(
      Array.from({ length: MAX_ENQUEUE_BATCH_SIZE }, (_, order) => ({
        type: "same-boundary",
        payload: { order },
        options: { runAt },
      })),
    );
    const states = await pool.query<{ state: string }>(
      "SELECT DISTINCT state FROM ironshift.job_runtime WHERE job_id = ANY($1::uuid[])",
      [ids],
    );
    expect(states.rows).toHaveLength(1);
  });

  it("rolls back the entire batch for invalid input and participates in caller transactions", async () => {
    await expect(
      queue.enqueueMany([
        { type: "valid", payload: {} },
        { type: "", payload: {} },
      ]),
    ).rejects.toThrow("each request requires");
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM ironshift.job")).rows[0].count,
    ).toBe(0);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueueMany([{ type: "rolled-back", payload: {} }], client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM ironshift.job")).rows[0].count,
    ).toBe(0);
  });

  it("notifies once per distinct queue containing ready jobs", async () => {
    const alpha = "enqueue-many-integration-alpha";
    const beta = "enqueue-many-integration-beta";
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query("LISTEN ironshift_jobs");
      await queue.enqueueMany([
        { type: "a", payload: {}, options: { queue: alpha } },
        { type: "b", payload: {}, options: { queue: alpha } },
        { type: "c", payload: {}, options: { queue: beta } },
        {
          type: "later",
          payload: {},
          options: { queue: "scheduled-only", runAt: new Date(Date.now() + 60_000) },
        },
      ]);
      await sleep(50);
      const relevant = notifications.filter((payload) => payload === alpha || payload === beta);
      expect(relevant).toHaveLength(2);
      expect(new Set(relevant)).toEqual(new Set([alpha, beta]));
    } finally {
      await listener.query("UNLISTEN ironshift_jobs");
      listener.release();
    }
  });

  it("participates in a caller transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await queue.enqueue("email", { to: "a@example.com" }, {}, client);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM ironshift.job")).rows[0].count,
    ).toBe(0);
  });

  it("separates scheduled work and promotes only when due", async () => {
    const id = await queue.enqueue(
      "email",
      { to: "a@example.com" },
      { runAt: new Date(Date.now() + 120) },
    );
    expect((await queue.getJob(id))?.state).toBe("scheduled");
    expect(await queue.claim("worker-a")).toBeNull();
    await sleep(150);
    expect(await queue.promote()).toBe(1);
    expect((await queue.getJob(id))?.state).toBe("ready");
    expect((await queue.claim("worker-a"))?.id).toBe(id);
  });

  it("claims exclusively and rejects stale completion after recovery", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a", { leaseMs: 100 });
    expect(first?.id).toBe(id);
    expect(await queue.claim("worker-b", { leaseMs: 100 })).toBeNull();
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    const second = await queue.claim("worker-b", { leaseMs: 1_000 });
    expect(second?.attempt).toBe(2);
    expect(second!.fenceToken).toBeGreaterThan(first!.fenceToken);
    expect(await queue.complete(first!, "worker-a", { stale: true })).toBe(false);
    expect(await queue.complete(second!, "worker-b", { delivered: true })).toBe(true);
    expect((await queue.getJob<{ delivered: boolean }>(id))?.result).toEqual({ delivered: true });
  });

  it("terminally fails an exhausted expired attempt without retaining runtime", async () => {
    const id = await queue.enqueue("email", {}, { maxAttempts: 1 });
    await queue.claim("worker-a", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    expect((await queue.getJob(id))?.state).toBe("failed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ironshift.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state FROM ironshift.job_outcome WHERE job_id = $1", [id])).rows[0]
        .state,
    ).toBe("failed");
  });

  it("heartbeats only the current fenced lease", async () => {
    await queue.enqueue("email", { to: "a@example.com" });
    const job = await queue.claim("worker-a", { leaseMs: 1_000 });
    expect(await queue.heartbeat(job!, "worker-a", 1_000)).toBe(true);
    expect(
      await queue.heartbeat({ ...job!, fenceToken: job!.fenceToken + 1n }, "worker-a", 1_000),
    ).toBe(false);
    expect(await queue.heartbeat(job!, "worker-b", 1_000)).toBe(false);
  });

  it("records immutable retry and success attempts", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("temporary"))).toBe("ready");
    const second = await queue.claim("worker-a");
    expect(second?.attempt).toBe(2);
    expect(await queue.complete(second!, "worker-a", { ok: true })).toBe(true);

    const attempts = await pool.query(
      "SELECT attempt, outcome FROM ironshift.attempt_history WHERE job_id = $1 ORDER BY attempt",
      [id],
    );
    expect(attempts.rows).toEqual([
      { attempt: 1, outcome: "retry" },
      { attempt: 2, outcome: "succeeded" },
    ]);
    const events = await pool.query(
      "SELECT event_type FROM ironshift.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "retry_scheduled",
      "claimed",
      "succeeded",
    ]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ironshift.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state, result FROM ironshift.job_outcome WHERE job_id = $1", [id]))
        .rows[0],
    ).toEqual({ state: "succeeded", result: { ok: true } });
  });

  it("moves a terminal handler failure to failed", async () => {
    const id = await queue.enqueue("email", {}, { maxAttempts: 1 });
    const job = await queue.claim("worker-a");
    expect(await queue.fail(job!, "worker-a", new Error("permanent"))).toBe("failed");
    expect((await queue.getJob(id))?.state).toBe("failed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ironshift.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state FROM ironshift.job_outcome WHERE job_id = $1", [id])).rows[0]
        .state,
    ).toBe("failed");
  });

  it("rejects retry when the live runtime fence is inconsistent", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a");
    await pool.query(
      "UPDATE ironshift.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await expect(queue.fail(job!, "worker-a", new Error("retry"))).resolves.toBe("stale");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ironshift.job_runtime WHERE state = 'active'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ironshift.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("recovery CAS skips a runtime whose active fence changed", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a", { leaseMs: 100 });
    await pool.query(
      "UPDATE ironshift.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await sleep(130);
    await expect(queue.recoverExpired()).resolves.toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM ironshift.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT current_attempt FROM ironshift.job_runtime WHERE job_id = $1", [
          job!.id,
        ])
      ).rows[0].current_attempt,
    ).toBe(2);
  });

  it("runs a registered handler end to end", async () => {
    const id = await queue.enqueue("sum", { a: 2, b: 3 });
    const worker = new Worker(queue, { workerId: "worker-a" }).handle<
      { a: number; b: number },
      { total: number }
    >("sum", ({ a, b }) => ({ total: a + b }));
    expect(await worker.runOnce()).toBe(true);
    expect((await queue.getJob<{ total: number }>(id))?.result).toEqual({ total: 5 });
  });

  it.each([
    ["afterClaim", 0, "active"],
    ["beforeHandler", 0, "active"],
    ["afterHandler", 1, "active"],
    ["beforeComplete", 1, "active"],
    ["afterComplete", 1, "succeeded"],
  ] as const)("models a crash at %s", async (failpoint, expectedEffects, expectedState) => {
    const id = await queue.enqueue("work", {}, { maxAttempts: 2 });
    let effects = 0;
    const worker = new Worker(queue, {
      workerId: "crashing-worker",
      leaseMs: 100,
      heartbeatMs: 50,
      failpoint,
    }).handle("work", () => {
      effects += 1;
      return { ok: true };
    });

    await expect(worker.runOnce()).rejects.toBeInstanceOf(InjectedCrashError);
    expect(effects).toBe(expectedEffects);
    expect((await queue.getJob(id))?.state).toBe(expectedState);

    if (expectedState === "active") await sleep(130);
    const recovered = await queue.recoverExpired();
    const stateAfterRecovery = (await queue.getJob(id))?.state;
    expect(recovered).toBe(expectedState === "active" ? 1 : 0);
    expect(stateAfterRecovery).toBe(expectedState === "active" ? "ready" : "succeeded");
  });

  it("reports queue and PostgreSQL health", async () => {
    await queue.enqueue("ready", {});
    await queue.enqueue("later", {}, { runAt: new Date(Date.now() + 60_000) });
    const health = await queue.health();
    expect(health.schemaVersion).toBe(2);
    expect(health.readyDepth).toBe(1);
    expect(health.scheduledDepth).toBe(1);
    expect(health.relations.some((relation) => relation.relation === "job_runtime")).toBe(true);
    expect(health.lockWaitCount).toBeGreaterThanOrEqual(0);
    expect(health.notificationQueueUsage).toBeGreaterThanOrEqual(0);
  });

  it("retires completed history partitions in bulk", async () => {
    const oldMonth = "2020-01-01";
    await pool.query("SELECT ironshift.create_history_partitions_v1($1)", [oldMonth]);
    expect(
      (await pool.query("SELECT to_regclass('ironshift.job_event_202001') AS relation")).rows[0]
        .relation,
    ).not.toBeNull();
    await pool.query("SELECT ironshift.retire_history_month_v1($1)", [oldMonth]);
    expect(
      (await pool.query("SELECT to_regclass('ironshift.job_event_202001') AS relation")).rows[0]
        .relation,
    ).toBeNull();
  });
});

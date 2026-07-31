import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InjectedCrashError,
  installSchema,
  type MaintenancePhaseResult,
  MAX_CHECKPOINT_VALUE_BYTES,
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
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE workhorse.job_event, workhorse.attempt_history,
    workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.queue_control, workhorse.job_checkpoint, workhorse.job_outcome, workhorse.job_runtime,
    workhorse.job RESTART IDENTITY CASCADE`);
  await pool.query("ALTER SEQUENCE workhorse.fence_token_seq RESTART WITH 1");
});

afterAll(async () => {
  await pool.end();
});

describe("live-runtime queue protocol", () => {
  it("installs schema v6 without compatibility write tables", async () => {
    const version = await pool.query<{ version: number }>(
      "SELECT max(version)::integer AS version FROM workhorse.schema_version",
    );
    expect(version.rows[0]?.version).toBe(6);

    const maintenanceFunctions = await pool.query<{
      maintain: string | null;
      tick: string | null;
      housekeep: string | null;
    }>(`SELECT
      to_regprocedure('workhorse.maintain_v1(integer,integer,integer,integer)')::text AS maintain,
      to_regprocedure('workhorse.tick_v1(integer,integer)')::text AS tick,
      to_regprocedure('workhorse.housekeep_v1(integer,integer)')::text AS housekeep`);
    expect(maintenanceFunctions.rows[0]).toEqual({
      maintain: null,
      tick: "tick_v1(integer,integer)",
      housekeep: "housekeep_v1(integer,integer)",
    });

    const historyPartitions = await pool.query<{ parent: string; partitions: number }>(`
      SELECT parent.relname AS parent, count(*)::integer AS partitions
        FROM pg_inherits inheritance
        JOIN pg_class parent ON parent.oid = inheritance.inhparent
        JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
       WHERE namespace.nspname = 'workhorse'
         AND parent.relname IN ('job_event', 'attempt_history')
       GROUP BY parent.relname
       ORDER BY parent.relname`);
    expect(historyPartitions.rows).toEqual([
      { parent: "attempt_history", partitions: 6 },
      { parent: "job_event", partitions: 6 },
    ]);

    const relations = await pool.query<{ relname: string }>(
      `
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'workhorse'
         AND c.relname = ANY($1::text[])
         AND c.relkind IN ('r', 'p', 'v', 'm')`,
      [["job_current", "ready_job", "scheduled_job", "lease"]],
    );
    expect(relations.rows).toEqual([]);

    const indexes = await pool.query<{ indexname: string }>(
      `
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'workhorse'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [
        [
          "job_runtime_expired_active_idx",
          "job_runtime_ready_idx",
          "job_runtime_scheduled_idx",
          "job_tags_gin_idx",
        ],
      ],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "job_runtime_expired_active_idx",
      "job_runtime_ready_idx",
      "job_runtime_scheduled_idx",
      "job_tags_gin_idx",
    ]);
  });

  it("synchronizes namespaced worker schedules and safely prunes removed definitions", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "0 6 * * *",
        job: {
          type: "generate-report",
          payload: { scope: "daily" },
          queue: "reports",
          maxAttempts: 5,
        },
      },
      {
        name: "disabled-cleanup",
        schedule: "0 2 * * 0",
        enabled: false,
        job: { type: "cleanup", payload: null },
      },
    ]);

    expect(
      (
        await pool.query(
          `SELECT schedule_name, cron_expression, queue_name, job_type, payload, max_attempts,
                  enabled, revision::text
             FROM workhorse.schedule_definition
            WHERE namespace = 'integration'
            ORDER BY schedule_name`,
        )
      ).rows,
    ).toEqual([
      {
        schedule_name: "daily-report",
        cron_expression: "0 6 * * *",
        queue_name: "reports",
        job_type: "generate-report",
        payload: { scope: "daily" },
        max_attempts: 5,
        enabled: true,
        revision: "1",
      },
      {
        schedule_name: "disabled-cleanup",
        cron_expression: "0 2 * * 0",
        queue_name: "default",
        job_type: "cleanup",
        payload: null,
        max_attempts: 25,
        enabled: false,
        revision: "1",
      },
    ]);

    await queue.syncSchedules("integration-other", [
      {
        name: "other-report",
        schedule: "0 8 * * *",
        job: { type: "other-report", payload: {} },
      },
    ]);
    await queue.syncSchedules("integration", [
      {
        name: "daily-report",
        schedule: "30 6 * * *",
        job: { type: "generate-report", payload: { scope: "changed" }, queue: "reports" },
      },
    ]);

    expect(
      (
        await pool.query(
          "SELECT namespace, schedule_name, enabled, revision::text FROM workhorse.schedule_definition ORDER BY namespace, schedule_name",
        )
      ).rows,
    ).toEqual([
      {
        namespace: "integration",
        schedule_name: "daily-report",
        enabled: true,
        revision: "2",
      },
      {
        namespace: "integration",
        schedule_name: "disabled-cleanup",
        enabled: false,
        revision: "1",
      },
      {
        namespace: "integration-other",
        schedule_name: "other-report",
        enabled: true,
        revision: "1",
      },
    ]);
  });

  it("rejects invalid cron expressions before persisting a schedule", async () => {
    await expect(
      queue.syncSchedules("integration", [
        {
          name: "invalid",
          schedule: "every sometime",
          job: { type: "invalid", payload: {} },
        },
      ]),
    ).rejects.toThrow(/Invalid cron expression for schedule invalid/);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.schedule_definition"))
        .rows[0]?.count,
    ).toBe(0);
  });

  it("lets workers coordinate recurring occurrences without duplicate jobs", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "heartbeat",
        schedule: "* * * * * *",
        job: { type: "cron-tick", payload: { source: "worker" } },
      },
    ]);
    const first = new Worker(queue, {
      workerId: "scheduler-a",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => ({ worker: "a" }));
    const second = new Worker(queue, {
      workerId: "scheduler-b",
      scheduleNamespaces: ["integration"],
    }).handle("cron-tick", () => ({ worker: "b" }));

    expect((await Promise.all([first.runOnce(), second.runOnce()])).filter(Boolean)).toHaveLength(
      1,
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'heartbeat'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
  });

  it("rejects stale schedule revisions after a definition changes", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "0 * * * *",
        job: { type: "old", payload: { revision: 1 } },
      },
    ]);
    const [oldDefinition] = await queue.schedules(["integration"]);
    await queue.syncSchedules("integration", [
      {
        name: "revision-fence",
        schedule: "30 * * * *",
        job: { type: "new", payload: { revision: 2 } },
      },
    ]);

    expect(
      await queue.fireSchedule(
        oldDefinition!.namespace,
        oldDefinition!.name,
        oldDefinition!.revision,
        new Date("2026-07-22T13:30:00.000Z"),
      ),
    ).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(0);
  });

  it("deduplicates concurrent calls at the schedule occurrence boundary", async () => {
    await queue.syncSchedules("integration", [
      {
        name: "hourly-rollup",
        schedule: "0 * * * *",
        job: { type: "rollup", payload: { scope: "hourly" } },
      },
    ]);
    const [definition] = await queue.schedules(["integration"]);
    const occurrence = new Date("2026-07-22T13:00:00.000Z");
    const results = await Promise.all([
      queue.fireSchedule("integration", "hourly-rollup", definition!.revision, occurrence),
      queue.fireSchedule("integration", "hourly-rollup", definition!.revision, occurrence),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'hourly-rollup'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("returns per-phase tick and housekeeping telemetry", async () => {
    const scheduledId = await queue.enqueue(
      "scheduled-maintenance",
      {},
      { runAt: new Date(Date.now() + 80) },
    );
    await sleep(100);
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, job_type, payload, max_attempts
       ) VALUES ('integration', 'retention', '0 * * * *', 'default', 'retention', '{}'::jsonb, 3)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('integration', 'retention', clock_timestamp() - interval '40 days'),
              ('integration', 'retention', clock_timestamp() - interval '39 days')`,
    );

    expect(await queue.tick()).toEqual([
      {
        phase: "promote",
        rowsAffected: 1,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "recover",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
    ]);
    expect((await queue.getJob(scheduledId))?.state).toBe("ready");

    expect(await queue.housekeep({ occurrenceRetentionDays: 30, occurrencePruneLimit: 1 })).toEqual(
      [
        {
          phase: "history_partitions",
          rowsAffected: 0,
          durationMs: expect.any(Number),
          skippedLock: false,
          error: null,
        },
        {
          phase: "schedule_occurrences",
          rowsAffected: 1,
          durationMs: expect.any(Number),
          skippedLock: false,
          error: null,
        },
      ],
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.schedule_occurrence WHERE namespace = 'integration' AND schedule_name = 'retention'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("returns skipped phase rows when another session owns a maintenance loop lock", async () => {
    const blocker = await pool.connect();
    try {
      await blocker.query("SELECT pg_advisory_lock(hashtextextended('workhorse:tick', 0))");
      expect(await queue.tick()).toEqual([
        { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
        { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
      ]);
      await blocker.query("SELECT pg_advisory_unlock(hashtextextended('workhorse:tick', 0))");

      await blocker.query("SELECT pg_advisory_lock(hashtextextended('workhorse:housekeeping', 0))");
      expect(await queue.housekeep()).toEqual([
        {
          phase: "history_partitions",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "schedule_occurrences",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
      ]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      blocker.release();
    }
  });

  it("isolates housekeeping phases when partition replenishment fails", async () => {
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, job_type, payload, max_attempts
       ) VALUES ('integration', 'isolation', '0 * * * *', 'default', 'isolation', '{}'::jsonb, 3)`,
    );
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
       VALUES ('integration', 'isolation', clock_timestamp() - interval '40 days')`,
    );
    await pool.query(`
      DO $$
      DECLARE suffix text := to_char(date_trunc('week', current_date + interval '4 weeks'), 'IYYY"w"IW');
      BEGIN
        EXECUTE format('DROP TABLE workhorse.%I', 'job_event_' || suffix);
        EXECUTE format('DROP TABLE workhorse.%I', 'attempt_history_' || suffix);
      END
      $$`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION workhorse.create_history_week_v1(p_week date)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced partition replenishment failure';
      END
      $$`);

    try {
      const results = await queue.housekeep({
        occurrenceRetentionDays: 30,
        occurrencePruneLimit: 10,
      });
      expect(results[0]).toMatchObject({
        phase: "history_partitions",
        rowsAffected: 0,
        skippedLock: false,
        error: { message: "forced partition replenishment failure" },
      });
      expect(results[1]).toMatchObject({
        phase: "schedule_occurrences",
        rowsAffected: 1,
        skippedLock: false,
        error: null,
      });
    } finally {
      await installSchema(pool);
    }
  });
  it("refuses to turn an existing v1 schema into a mixed installation", async () => {
    await pool.query("DROP SCHEMA workhorse CASCADE");
    try {
      await pool.query(`
        CREATE SCHEMA workhorse;
        CREATE TABLE workhorse.schema_version (version integer PRIMARY KEY);
        INSERT INTO workhorse.schema_version(version) VALUES (1);
        CREATE TABLE workhorse.job_current (id uuid PRIMARY KEY)`);
      await expect(installSchema(pool)).rejects.toThrow(/non-v6 or mixed workhorse schema/);
      const version = await pool.query<{ version: number }>(
        "SELECT version FROM workhorse.schema_version",
      );
      expect(version.rows).toEqual([{ version: 1 }]);
      expect(
        (await pool.query("SELECT to_regclass('workhorse.job_runtime') AS relation")).rows[0],
      ).toEqual({ relation: null });
    } finally {
      await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
      await installSchema(pool);
    }
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
      "SELECT job_id, event_type FROM workhorse.job_event WHERE event_type = 'enqueued' ORDER BY event_id",
    );
    expect(events.rows).toEqual(ids.map((jobId) => ({ job_id: jobId, event_type: "enqueued" })));
  });

  it("round-trips tags and supports indexed overlap filtering", async () => {
    const billingId = await queue.enqueue(
      "invoice.capture",
      { invoiceId: "inv-1" },
      { tags: ["billing", "priority"] },
    );
    const reportId = (
      await queue.enqueueMany([
        { type: "report.weekly", payload: {}, tags: ["reports", "weekly"] },
        { type: "email.send", payload: {}, tags: ["email", "transactional"] },
      ])
    )[0]!;

    await expect(queue.getJob(billingId)).resolves.toMatchObject({
      id: billingId,
      tags: ["billing", "priority"],
    });
    await expect(queue.getJob(reportId)).resolves.toMatchObject({
      id: reportId,
      tags: ["reports", "weekly"],
    });
    const tagged = await pool.query<{ id: string }>(
      "SELECT id FROM workhorse.job WHERE tags && $1::text[] ORDER BY id",
      [["billing", "weekly"]],
    );
    expect(new Set(tagged.rows.map((row) => row.id))).toEqual(new Set([billingId, reportId]));

    await expect(queue.enqueue("invalid", {}, { tags: [""] })).rejects.toThrow(/non-empty tags/);
    await expect(
      queue.enqueue(
        "too-many",
        {},
        { tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
      ),
    ).rejects.toThrow(/at most 20/);
  });

  it("pauses claims, resumes dispatch, and purges only non-active jobs from one queue", async () => {
    const queueName = "managed";
    const activeId = await queue.enqueue("active", {}, { queue: queueName });
    const active = await queue.claim("worker-active", { queue: queueName });
    expect(active?.id).toBe(activeId);

    const readyId = await queue.enqueue("ready", {}, { queue: queueName });
    const scheduledId = await queue.enqueue(
      "scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
      },
    );
    const otherId = await queue.enqueue("other", {}, { queue: "other" });

    await queue.pauseQueue(queueName);
    expect(await queue.claim("worker-paused", { queue: queueName })).toBeNull();
    expect(
      await pool.query("SELECT paused FROM workhorse.queue_control WHERE queue_name = $1", [
        queueName,
      ]),
    ).toMatchObject({ rows: [{ paused: true }] });

    await queue.resumeQueue(queueName);
    expect((await queue.claim("worker-resumed", { queue: queueName }))?.id).toBe(readyId);

    await queue.enqueue("ready-after-resume", {}, { queue: queueName });
    expect(await queue.purgeQueue(queueName)).toBe(2);
    expect(await queue.getJob(activeId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(readyId)).toMatchObject({ state: "active" });
    expect(await queue.getJob(scheduledId)).toBeNull();
    expect(await queue.getJob(otherId)).toMatchObject({ state: "ready" });
    expect(await queue.purgeQueue(queueName)).toBe(0);
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
      "SELECT DISTINCT state FROM workhorse.job_runtime WHERE job_id = ANY($1::uuid[])",
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);
  });

  it("notifies once per distinct queue containing ready jobs", async () => {
    const alpha = "enqueue-many-integration-alpha";
    const beta = "enqueue-many-integration-beta";
    const listener = await pool.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => notifications.push(message.payload ?? ""));
    try {
      await listener.query("LISTEN workhorse_jobs");
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
      await listener.query("UNLISTEN workhorse_jobs");
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
      (await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).rows[0].count,
    ).toBe(0);
  });

  it("defaults enqueued jobs to 25 attempts in both client and SQL entry points", async () => {
    const clientId = await queue.enqueue("client-default", {});
    const sqlResult = await pool.query<{ job_id: string }>(
      "SELECT workhorse.enqueue_v1('default', 'sql-default', '{}'::jsonb) AS job_id",
    );
    const batchResult = await pool.query<{ job_id: string }>(
      "SELECT job_id FROM workhorse.enqueue_many_v1($1::jsonb)",
      [
        JSON.stringify([
          {
            queue: "default",
            type: "batch-default",
            payload: {},
            runAt: new Date().toISOString(),
          },
        ]),
      ],
    );

    const attempts = await pool.query<{ job_type: string; max_attempts: number }>(
      "SELECT job_type, max_attempts FROM workhorse.job WHERE id = ANY($1::uuid[]) ORDER BY job_type",
      [[clientId, sqlResult.rows[0]!.job_id, batchResult.rows[0]!.job_id]],
    );
    expect(attempts.rows).toEqual([
      { job_type: "batch-default", max_attempts: 25 },
      { job_type: "client-default", max_attempts: 25 },
      { job_type: "sql-default", max_attempts: 25 },
    ]);
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

  it("lets running workers drain work while a paused worker stops claiming until resumed", async () => {
    const handledBy: string[] = [];
    const pausedWorker = new Worker(queue, {
      workerId: "paused-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`paused:${sequence}`);
      return { sequence };
    });
    const runningWorker = new Worker(queue, {
      workerId: "running-worker",
      pollMs: 1,
    }).handle<{ sequence: number }>("pause-control", ({ sequence }) => {
      handledBy.push(`running:${sequence}`);
      return { sequence };
    });
    const initialIds: string[] = [];
    for (const sequence of [1, 2, 3]) {
      initialIds.push(await queue.enqueue("pause-control", { sequence }));
    }

    pausedWorker.pause();
    expect(pausedWorker.isPaused()).toBe(true);
    expect(await pausedWorker.runOnce()).toBe(false);
    while (await runningWorker.runOnce()) {
      // Drain all ready work without allowing the paused worker to compete for claims.
    }

    expect(handledBy).toEqual(["running:1", "running:2", "running:3"]);
    await expect(Promise.all(initialIds.map((id) => queue.getJob(id)))).resolves.toEqual(
      initialIds.map((id) => expect.objectContaining({ id, state: "succeeded" })),
    );

    const resumedId = await queue.enqueue("pause-control", { sequence: 4 });
    pausedWorker.resume();
    expect(pausedWorker.isPaused()).toBe(false);
    expect(await pausedWorker.runOnce()).toBe(true);
    expect(handledBy.at(-1)).toBe("paused:4");
    await expect(queue.getJob(resumedId)).resolves.toMatchObject({ state: "succeeded" });
  });

  it("allows an active job to finish after its worker is paused", async () => {
    let releaseHandler!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = new Worker(queue, {
      workerId: "pause-in-flight",
      heartbeatMs: 50,
      leaseMs: 500,
    }).handle("pause-in-flight", async () => {
      markStarted();
      await released;
      return { completedWhilePaused: true };
    });
    const jobId = await queue.enqueue("pause-in-flight", {});

    const run = worker.runOnce();
    await started;
    worker.pause();
    releaseHandler();

    await expect(run).resolves.toBe(true);
    expect(worker.isPaused()).toBe(true);
    await expect(queue.getJob(jobId)).resolves.toMatchObject({
      state: "succeeded",
      result: { completedWhilePaused: true },
    });
    expect(await worker.runOnce()).toBe(false);
  });

  it("runs tick and housekeeping on independent worker cadences with phase telemetry", async () => {
    const jobId = await queue.enqueue(
      "scheduled-worker",
      { ok: true },
      { runAt: new Date(Date.now() + 80) },
    );
    await sleep(100);

    const telemetry: ReturnType<Worker["maintenanceTelemetry"]> = [];
    const worker = new Worker(queue, {
      workerId: "worker-maintenance",
      maintenanceIntervalMs: 100,
      housekeepingIntervalMs: 1_000,
      onMaintenance: (event) => telemetry.push(event),
    }).handle("scheduled-worker", () => ({ ok: true }));
    expect(await worker.runOnce()).toBe(true);
    expect((await queue.getJob(jobId))?.state).toBe("succeeded");
    expect(telemetry.map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
      "housekeeping:history_partitions",
      "housekeeping:schedule_occurrences",
    ]);
    expect(worker.maintenanceTelemetry()).toEqual(telemetry);

    await sleep(110);
    expect(await worker.runOnce()).toBe(false);
    expect(telemetry.slice(4).map(({ loop, phase }) => `${loop}:${phase}`)).toEqual([
      "tick:promote",
      "tick:recover",
    ]);
  });

  it("keeps idle claim polling on pollMs despite more frequent maintenance wakeups", async () => {
    const tickResults: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: false, error: null },
    ];
    const housekeepingResults: MaintenancePhaseResult[] = [
      {
        phase: "history_partitions",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
      {
        phase: "schedule_occurrences",
        rowsAffected: 0,
        durationMs: 0,
        skippedLock: false,
        error: null,
      },
    ];
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValue(tickResults);
    const housekeep = vi.spyOn(queue, "housekeep").mockResolvedValue(housekeepingResults);
    const claim = vi.spyOn(queue, "claim").mockResolvedValue(null);

    try {
      const worker = new Worker(queue, {
        workerId: "idle-cadence",
        pollMs: 15_000,
        maintenanceIntervalMs: 1_000,
        housekeepingIntervalMs: 60_000,
      });

      await worker.runOnce();
      now.mockReturnValue(1_000);
      await worker.runOnce();
      now.mockReturnValue(2_000);
      await worker.runOnce();
      now.mockReturnValue(14_999);
      await worker.runOnce();

      expect(tick).toHaveBeenCalledTimes(4);
      expect(claim).toHaveBeenCalledTimes(1);

      now.mockReturnValue(15_000);
      await worker.runOnce();
      expect(claim).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      housekeep.mockRestore();
      claim.mockRestore();
    }
  });

  it("does not scan recurring schedules when the tick advisory lock is skipped", async () => {
    const skippedTick: MaintenancePhaseResult[] = [
      { phase: "promote", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
      { phase: "recover", rowsAffected: 0, durationMs: 0, skippedLock: true, error: null },
    ];
    const ownedTick: MaintenancePhaseResult[] = skippedTick.map((result) => ({
      ...result,
      skippedLock: false,
    }));
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const tick = vi.spyOn(queue, "tick").mockResolvedValueOnce(skippedTick);
    const housekeep = vi.spyOn(queue, "housekeep").mockResolvedValue([]);
    const schedules = vi.spyOn(queue, "schedules").mockResolvedValue([]);
    const claim = vi.spyOn(queue, "claim").mockResolvedValue(null);

    try {
      const worker = new Worker(queue, {
        workerId: "schedule-lock-gate",
        pollMs: 15_000,
        maintenanceIntervalMs: 100,
        scheduleNamespaces: ["integration"],
      });

      await worker.runOnce();
      expect(schedules).not.toHaveBeenCalled();

      tick.mockResolvedValueOnce(ownedTick);
      now.mockReturnValue(100);
      await worker.runOnce();
      expect(schedules).toHaveBeenCalledOnce();
      expect(schedules).toHaveBeenCalledWith(["integration"]);
    } finally {
      now.mockRestore();
      tick.mockRestore();
      housekeep.mockRestore();
      schedules.mockRestore();
      claim.mockRestore();
    }
  });

  it("claims exclusively and rejects stale completion after recovery", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a", { leaseMs: 100 });
    expect(first?.id).toBe(id);
    expect(await queue.claim("worker-b", { leaseMs: 100 })).toBeNull();
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    expect((await queue.getJob(id))?.fenceToken).toBe(0n);
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
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state FROM workhorse.job_outcome WHERE job_id = $1", [id])).rows[0]
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

  it("persists immutable checkpoints with ownership provenance", async () => {
    const id = await queue.enqueue("checkpointed", { orderId: "order-1" });
    const job = await queue.claim("worker-a");

    const saved = await queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
      authorizationId: "auth-1",
    });
    expect(saved).toMatchObject({
      jobId: id,
      name: "payment-authorized",
      value: { authorizationId: "auth-1" },
      attempt: 1,
      fenceToken: job!.fenceToken,
      workerId: "worker-a",
    });
    await expect(queue.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
    await expect(
      queue.saveCheckpoint(job!, "worker-a", "nullable-result", null),
    ).resolves.toMatchObject({
      name: "nullable-result",
      value: null,
    });

    const repeated = await queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
      authorizationId: "auth-1",
    });
    expect(repeated).toEqual(saved);
    await expect(
      queue.saveCheckpoint(job!, "worker-a", "payment-authorized", {
        authorizationId: "auth-2",
      }),
    ).rejects.toThrow(/different value/);

    expect(await queue.complete(job!, "worker-a", { ok: true })).toBe(true);
    await expect(queue.getCheckpoint(id, "payment-authorized")).resolves.toEqual(saved);
    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
      [id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "enqueued",
      "claimed",
      "checkpoint_saved",
      "checkpoint_saved",
      "succeeded",
    ]);
  });

  it("bounds checkpoint values before durable writes", async () => {
    const id = await queue.enqueue("checkpoint-size", {});
    const job = await queue.claim("worker-a");

    await expect(
      queue.saveCheckpoint(job!, "worker-a", "oversized", {
        data: "x".repeat(MAX_CHECKPOINT_VALUE_BYTES + 1),
      }),
    ).rejects.toThrow(/at most 1048576 bytes/);
    await expect(
      pool.query(
        `SELECT * FROM workhorse.save_checkpoint_v1(
          $1, $2, $3, 'oversized-sql', to_jsonb(repeat('x', $4))
        )`,
        [id, "worker-a", job!.fenceToken.toString(), MAX_CHECKPOINT_VALUE_BYTES + 1],
      ),
    ).rejects.toThrow(/at most 1048576 bytes/);
    await expect(queue.getCheckpoint(id, "oversized")).resolves.toBeNull();
    await expect(queue.getCheckpoint(id, "oversized-sql")).resolves.toBeNull();
  });

  it("rejects checkpoint writes from a stale ownership generation", async () => {
    const id = await queue.enqueue("checkpointed", {}, { maxAttempts: 2 });
    const stale = await queue.claim("worker-a", { leaseMs: 100 });
    await sleep(130);
    expect(await queue.recoverExpired()).toBe(1);
    const current = await queue.claim("worker-b");

    await expect(
      queue.saveCheckpoint(stale!, "worker-a", "stale-step", { shouldNotPersist: true }),
    ).rejects.toThrow(/lease is stale or expired/);
    await expect(queue.getCheckpoint(id, "stale-step")).resolves.toBeNull();
    await expect(
      queue.saveCheckpoint(current!, "worker-b", "current-step", { persisted: true }),
    ).resolves.toMatchObject({ name: "current-step", attempt: 2, workerId: "worker-b" });
  });

  it("serializes checkpoint writes against a concurrent retry transition", async () => {
    const id = await queue.enqueue("checkpoint-race", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a");
    const transition = await pool.connect();

    try {
      await transition.query("BEGIN");
      await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
        id,
      ]);
      const saving = queue.saveCheckpoint(job!, "worker-a", "racing-step", { persisted: true });
      const rejection = saving.then(
        () => null,
        (error: unknown) => error,
      );
      await sleep(20);
      await transition.query("SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb, 0) AS state", [
        id,
        "worker-a",
        job!.fenceToken.toString(),
        JSON.stringify({ message: "retry" }),
      ]);
      await transition.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({
        name: "CheckpointLeaseLostError",
        message: expect.stringMatching(/lease is stale or expired/),
      });
      await expect(queue.getCheckpoint(id, "racing-step")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "ready", currentAttempt: 2 });
    } finally {
      await transition.query("ROLLBACK").catch(() => undefined);
      transition.release();
    }
  });

  it("serializes checkpoint writes against concurrent terminal completion", async () => {
    const id = await queue.enqueue("checkpoint-complete-race", {});
    const job = await queue.claim("worker-a");
    const transition = await pool.connect();

    try {
      await transition.query("BEGIN");
      await transition.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [
        id,
      ]);
      const rejection = queue
        .saveCheckpoint(job!, "worker-a", "too-late", { persisted: true })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await sleep(20);
      await transition.query("SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb) AS accepted", [
        id,
        "worker-a",
        job!.fenceToken.toString(),
        JSON.stringify({ completed: true }),
      ]);
      await transition.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({ name: "CheckpointLeaseLostError" });
      await expect(queue.getCheckpoint(id, "too-late")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({
        state: "succeeded",
        result: { completed: true },
      });
    } finally {
      await transition.query("ROLLBACK").catch(() => undefined);
      transition.release();
    }
  });

  it("retains checkpoints after terminal failure", async () => {
    const id = await queue.enqueue("checkpoint-failure", {}, { maxAttempts: 1 });
    const job = await queue.claim("worker-a");
    const checkpoint = await queue.saveCheckpoint(job!, "worker-a", "before-failure", {
      prepared: true,
    });

    expect(await queue.fail(job!, "worker-a", new Error("terminal"))).toBe("failed");
    await expect(queue.getCheckpoint(id, "before-failure")).resolves.toEqual(checkpoint);
    await expect(queue.getJob(id)).resolves.toMatchObject({ state: "failed" });
  });

  it("rechecks checkpoint lease expiry after waiting for the runtime lock", async () => {
    const id = await queue.enqueue("checkpoint-lock-expiry", {});
    const job = await queue.claim("worker-a", { leaseMs: 100 });
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM workhorse.job_runtime WHERE job_id = $1 FOR UPDATE", [id]);
      const saving = queue.saveCheckpoint(job!, "worker-a", "expired-while-waiting", {
        persisted: true,
      });
      const rejection = saving.then(
        () => null,
        (error: unknown) => error,
      );
      await sleep(130);
      await blocker.query("COMMIT");

      await expect(rejection).resolves.toMatchObject({
        name: "CheckpointLeaseLostError",
        message: expect.stringMatching(/lease is stale or expired/),
      });
      await expect(queue.getCheckpoint(id, "expired-while-waiting")).resolves.toBeNull();
      await expect(queue.getJob(id)).resolves.toMatchObject({ state: "active" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("records immutable retry and success attempts", async () => {
    const id = await queue.enqueue("email", { to: "a@example.com" }, { maxAttempts: 2 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("temporary"), 0)).toBe("ready");
    expect((await queue.getJob(id))?.fenceToken).toBe(0n);
    const second = await queue.claim("worker-a");
    expect(second?.attempt).toBe(2);
    expect(await queue.complete(second!, "worker-a", { ok: true })).toBe(true);

    const attempts = await pool.query(
      "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1 ORDER BY attempt",
      [id],
    );
    expect(attempts.rows).toEqual([
      { attempt: 1, outcome: "retry" },
      { attempt: 2, outcome: "succeeded" },
    ]);
    const events = await pool.query(
      "SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id",
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
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state, result FROM workhorse.job_outcome WHERE job_id = $1", [id]))
        .rows[0],
    ).toEqual({ state: "succeeded", result: { ok: true } });
  });

  it("uses Sidekiq-inspired SQL backoff with jitter when no retry delay is supplied", async () => {
    const id = await queue.enqueue("backoff", {}, { maxAttempts: 3 });
    const first = await queue.claim("worker-a");
    expect(await queue.fail(first!, "worker-a", new Error("immediate override"), 0)).toBe("ready");

    const second = await queue.claim("worker-a");
    const beforeFailure = new Date();

    expect(second?.attempt).toBe(2);
    expect(await queue.fail(second!, "worker-a", new Error("temporary"))).toBe("scheduled");

    const retry = await pool.query<{
      current_attempt: number;
      run_at: Date;
      delay_seconds: number;
    }>(
      `SELECT current_attempt, run_at,
              extract(epoch FROM (run_at - $2::timestamptz))::double precision AS delay_seconds
         FROM workhorse.job_runtime
        WHERE job_id = $1`,
      [id, beforeFailure],
    );
    expect(retry.rows[0]!.current_attempt).toBe(3);
    expect(retry.rows[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
    // retry count 1: 1^4 + 15 + rand(0..9) * 2 => [16, 34] seconds.
    expect(retry.rows[0]!.delay_seconds).toBeGreaterThanOrEqual(16);
    expect(retry.rows[0]!.delay_seconds).toBeLessThan(35);
  });

  it("moves a terminal handler failure to failed", async () => {
    const id = await queue.enqueue("email", {}, { maxAttempts: 1 });
    const job = await queue.claim("worker-a");
    expect(await queue.fail(job!, "worker-a", new Error("permanent"))).toBe("failed");
    expect((await queue.getJob(id))?.state).toBe("failed");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE job_id = $1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (await pool.query("SELECT state FROM workhorse.job_outcome WHERE job_id = $1", [id])).rows[0]
        .state,
    ).toBe("failed");
  });

  it("rejects retry when the live runtime fence is inconsistent", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a");
    await pool.query(
      "UPDATE workhorse.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await expect(queue.fail(job!, "worker-a", new Error("retry"))).resolves.toBe("stale");
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'active'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("recovery CAS skips a runtime whose active fence changed", async () => {
    await queue.enqueue("work", {}, { maxAttempts: 2 });
    const job = await queue.claim("worker-a", { leaseMs: 100 });
    await pool.query(
      "UPDATE workhorse.job_runtime SET fence_token = fence_token + 1 WHERE job_id = $1",
      [job!.id],
    );
    await sleep(130);
    await expect(queue.recoverExpired()).resolves.toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer AS count FROM workhorse.job_runtime WHERE state = 'ready'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query("SELECT current_attempt FROM workhorse.job_runtime WHERE job_id = $1", [
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

  it("reuses a completed checkpoint when a later attempt restarts the handler", async () => {
    const id = await queue.enqueue("checkpoint-retry", {}, { maxAttempts: 2 });
    let externalEffects = 0;
    const worker = new Worker(queue, {
      workerId: "checkpoint-worker",
      retryDelayMs: 0,
    }).handle("checkpoint-retry", async (_payload, context) => {
      const authorization = await context.checkpoint("authorize", () => {
        externalEffects += 1;
        return { authorizationId: `auth-${externalEffects}` };
      });
      if (context.job.attempt === 1) throw new Error("crash after durable checkpoint");
      return authorization;
    });

    expect(await worker.runOnce()).toBe(true);
    expect((await queue.getJob(id))?.state).toBe("ready");
    expect(await worker.runOnce()).toBe(true);

    expect(externalEffects).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      state: "succeeded",
      result: { authorizationId: "auth-1" },
    });
    await expect(queue.getCheckpoint(id, "authorize")).resolves.toMatchObject({
      value: { authorizationId: "auth-1" },
      attempt: 1,
      workerId: "checkpoint-worker",
    });
  });

  it("coalesces overlapping handler calls for the same checkpoint name", async () => {
    const id = await queue.enqueue("checkpoint-overlap", {});
    let operations = 0;
    const worker = new Worker(queue, { workerId: "checkpoint-worker" }).handle(
      "checkpoint-overlap",
      async (_payload, context) => {
        const operation = async () => {
          operations += 1;
          await sleep(10);
          return { operation: operations };
        };
        const [first, second] = await Promise.all([
          context.checkpoint("shared", operation),
          context.checkpoint("shared", operation),
        ]);
        return { first, second };
      },
    );

    expect(await worker.runOnce()).toBe(true);
    expect(operations).toBe(1);
    await expect(queue.getJob(id)).resolves.toMatchObject({
      result: {
        first: { operation: 1 },
        second: { operation: 1 },
      },
    });
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
    expect(health.schemaVersion).toBe(6);
    expect(health.readyDepth).toBe(1);
    expect(health.scheduledDepth).toBe(1);
    expect(health.relations.some((relation) => relation.relation === "job_runtime")).toBe(true);
    expect(health.lockWaitCount).toBeGreaterThanOrEqual(0);
    expect(health.notificationQueueUsage).toBeGreaterThanOrEqual(0);
  });

  it("creates and retires completed weekly history partitions", async () => {
    const oldWeek = "2020-01-06";
    const historicalTimestamp = "2020-01-08T12:00:00.000Z";
    const historicalJobId = "00000000-0000-4000-8000-000000000001";
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
       VALUES ($1, 'fallback', $2)`,
      [historicalJobId, historicalTimestamp],
    );
    await pool.query(
      `INSERT INTO workhorse.attempt_history(
         job_id, attempt, fence_token, worker_id, outcome, started_at, finished_at, occurred_at
       ) VALUES ($1, 1, 1, 'fallback-worker', 'succeeded', $2, $2, $2)`,
      [historicalJobId, historicalTimestamp],
    );
    const fallbackRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.job_event WHERE job_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE job_id = $1
      ORDER BY relation`,
      [historicalJobId],
    );
    expect(fallbackRelations.rows).toEqual([
      { relation: "attempt_history_default" },
      { relation: "job_event_default" },
    ]);

    await pool.query("SELECT workhorse.create_history_week_v1($1)", [oldWeek]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.job_event_2020w02') AS relation")).rows[0]
        .relation,
    ).not.toBeNull();
    expect(
      (await pool.query("SELECT to_regclass('workhorse.attempt_history_2020w02') AS relation"))
        .rows[0].relation,
    ).not.toBeNull();
    const migratedRelations = await pool.query<{ relation: string }>(
      `
      SELECT tableoid::regclass::text AS relation FROM workhorse.job_event WHERE job_id = $1
      UNION ALL
      SELECT tableoid::regclass::text FROM workhorse.attempt_history WHERE job_id = $1
      ORDER BY relation`,
      [historicalJobId],
    );
    expect(migratedRelations.rows).toEqual([
      { relation: "attempt_history_2020w02" },
      { relation: "job_event_2020w02" },
    ]);
    await pool.query("SELECT workhorse.retire_history_week_v1($1)", [oldWeek]);
    expect(
      (await pool.query("SELECT to_regclass('workhorse.job_event_2020w02') AS relation")).rows[0]
        .relation,
    ).toBeNull();
    await expect(
      pool.query("SELECT workhorse.retire_history_week_v1(current_date)"),
    ).rejects.toThrow(/only completed history weeks can be retired/);
  });

  it("replenishes the four-week history partition horizon during housekeeping", async () => {
    await pool.query(`
      DO $$
      DECLARE week_offset integer;
      DECLARE suffix text;
      BEGIN
        FOR week_offset IN 2..3 LOOP
          suffix := to_char(
            date_trunc('week', current_date + make_interval(weeks => week_offset)),
            'IYYY"w"IW'
          );
          EXECUTE format('DROP TABLE workhorse.%I', 'job_event_' || suffix);
          EXECUTE format('DROP TABLE workhorse.%I', 'attempt_history_' || suffix);
        END LOOP;
      END
      $$`);
    expect(await queue.housekeep()).toMatchObject([
      { phase: "history_partitions", rowsAffected: 2, skippedLock: false, error: null },
      { phase: "schedule_occurrences", skippedLock: false, error: null },
    ]);
    const horizon = await pool.query<{ missing: number }>(`
      SELECT count(*) FILTER (
               WHERE to_regclass(format('workhorse.%I', 'job_event_' || suffix)) IS NULL
                  OR to_regclass(format('workhorse.%I', 'attempt_history_' || suffix)) IS NULL
             )::integer AS missing
        FROM (
          SELECT to_char(
                   date_trunc('week', current_date + make_interval(weeks => week_offset)),
                   'IYYY"w"IW'
                 ) AS suffix
            FROM generate_series(0, 4) AS weeks(week_offset)
        ) expected`);
    expect(horizon.rows[0]?.missing).toBe(0);
  });
});

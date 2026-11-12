import { setTimeout as sleep } from "node:timers/promises";
import { metrics } from "@opentelemetry/api";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { WorkhorseMetricsObserver } from "../src/index.js";
import { EXTERNAL_WAIT_REJECTION_WINDOW_MS } from "../src/types.js";
import { createIntegrationTestContext } from "./support/integration.js";
import { WORKHORSE_SCHEMA_VERSION } from "../src/index.js";

registerOpenTelemetry();

const { defaultRetentionPolicy, pool, queue, admin, adminAudit } = createIntegrationTestContext(
  import.meta.url,
);

const retentionIndexes = [
  "task_created_retention_idx",
  "task_outcome_retention_idx",
  "fast_task_outcome_retention_idx",
];

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Filter?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}
const planNodes = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap((child) => planNodes(child)),
];

// Writes count terminal tasks of each shape that a retention walk must not read: rows inside
// their windows, rows past their windows whose history a held watermark keeps, and members of
// a finished task group inside their windows. With released, it also writes count eligible
// rows that one history pass releases together. The walk reads the first of them and stops,
// because no later row can be due earlier.
const seed = async (count: number, released = false) => {
  await pool.query(
    `WITH task AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'retention-plan', shape, '{}'::jsonb, 1,
              clock_timestamp() - CASE shape WHEN 'behind' THEN interval '20 days'
                                             WHEN 'released' THEN interval '40 days'
                                             ELSE interval '2 days' END
                - make_interval(secs => position)
         FROM generate_series(1, $1::integer) position
         CROSS JOIN unnest(
           CASE WHEN $2::boolean THEN ARRAY['released']
                ELSE ARRAY['young', 'behind', 'member'] END
         ) shape
       RETURNING id, task_type, created_at
     ), outcome AS (
       INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, result, finished_at,
         history_through_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at
         FROM task
     ), member_group AS (
       INSERT INTO workhorse.task_group(
         state, result, total_count, succeeded_count, sealed_at, finished_at, shard_count
       ) VALUES ('finished', 'succeeded', $1::integer, $1::integer,
                 clock_timestamp() - interval '1 day', clock_timestamp() - interval '1 day', 1)
       RETURNING id
     )
     INSERT INTO workhorse.task_group_member(task_id, group_id, position, outcome, counted_at)
     SELECT task.id, member_group.id, row_number() OVER (ORDER BY task.id), 'succeeded',
            clock_timestamp()
       FROM task CROSS JOIN member_group
      WHERE task.task_type = 'member'`,
    [count, released],
  );
  // The watermark stopped 30 days back, so the rows past their windows keep their history.
  await pool.query(
    `UPDATE workhorse.maintenance_state
        SET history_retained_before = clock_timestamp() - interval '30 days'
      WHERE routine_name = 'history_retention'`,
  );
  await pool.query("ANALYZE workhorse.task, workhorse.task_outcome, workhorse.task_group_member");
};

const boundaryBody = async () => {
  const source = await pool.query<{ prosrc: string }>(
    `SELECT routine.prosrc
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
      WHERE namespace.nspname = 'workhorse'
        AND routine.proname = 'terminal_retention_boundaries_internal_v2'`,
  );
  expect(source.rows).toHaveLength(1);
  return source.rows[0]!.prosrc.replaceAll(/\bp_now\b/g, "statement_timestamp()");
};

// Each read runs in its own transaction, whose counters show the index rows that it reads.
const inPlannedTransaction = async <T>(read: (client: PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    await client.query("SET LOCAL enable_bitmapscan = off");
    return await read(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
};

// The counters can also hold earlier reads of the same connection, so this reads their difference.
const snapshotReads = () =>
  inPlannedTransaction(async (client) => {
    const counters = async () =>
      (
        await client.query<{ tuples: string }>(
          `SELECT pg_stat_get_xact_tuples_returned(
                    format('workhorse.%I', index_name)::regclass) AS tuples
             FROM unnest($1::text[]) WITH ORDINALITY AS indexes(index_name, position)
            ORDER BY position`,
          [retentionIndexes],
        )
      ).rows.map(({ tuples }) => Number(tuples));
    const before = await counters();
    await client.query("SELECT workhorse.queue_health_v1()");
    return (await counters()).map((tuples, index) => tuples - before[index]!);
  });
const walkReads = () =>
  inPlannedTransaction(async (client) => {
    const plan = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${await boundaryBody()}`,
    );
    return planNodes(plan.rows[0]!["QUERY PLAN"][0]!.Plan)
      .filter((node) => retentionIndexes.includes(node["Index Name"] ?? ""))
      .reduce(
        (sum, node) =>
          sum +
          (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1) +
          (node["Rows Removed by Filter"] ?? 0),
        0,
      );
  });

// Writes count terminal tasks past their windows that an unexpired enqueue key keeps, older than
// three eligible tasks. The watermark is 15 days back, so the history of each row is released.
const seedHeldBeforeEligible = async (count: number) => {
  await pool.query(
    `WITH task AS (
       INSERT INTO workhorse.task(queue_name, task_type, payload, max_attempts, created_at)
       SELECT 'retention-cap', CASE WHEN position <= $1 THEN 'held' ELSE 'eligible' END,
              '{}'::jsonb, 1,
              clock_timestamp() - interval '30 days' + make_interval(secs => position)
         FROM generate_series(1, $1::integer + 3) position
       RETURNING id, task_type, created_at
     ), outcome AS (
       INSERT INTO workhorse.task_outcome(
         task_id, state, current_attempt, fence_token, run_at, result, finished_at,
         history_through_at
       )
       SELECT id, 'succeeded', 1, 1, created_at, '{}'::jsonb, created_at, created_at FROM task
     )
     INSERT INTO workhorse.enqueue_idempotency(
       idempotency_scope, idempotency_key_hash, request_fingerprint, task_id, expires_at
     )
     SELECT 'retention-cap', sha256(convert_to(id::text, 'UTF8')), '{}'::jsonb, id,
            clock_timestamp() + interval '30 days'
       FROM task WHERE task_type = 'held'`,
    [count],
  );
  await pool.query(
    `UPDATE workhorse.maintenance_state
        SET history_retained_before = clock_timestamp() - interval '15 days'
      WHERE routine_name = 'history_retention'`,
  );
  await pool.query("ANALYZE workhorse.task, workhorse.task_outcome, workhorse.enqueue_idempotency");
};

const reasonsOf = async (code: string) =>
  (await queue.health()).status.reasons.filter((reason) => reason.code === code);

// A failed tick that started and ended secondsAgo.
const failedTick = (secondsAgo: number) =>
  pool.query(
    `INSERT INTO workhorse.maintenance_run(
       routine_name, started_at, completed_at, outcome, rows_affected, phases
     ) VALUES ('tick', clock_timestamp() - make_interval(secs => $1),
               clock_timestamp() - make_interval(secs => $1), 'failed', 0, '[]'::jsonb)`,
    [secondsAgo],
  );
// The completion instant of an idle tick, which records no run.
const idleSuccess = (secondsAgo: number) =>
  pool.query(
    `UPDATE workhorse.maintenance_state
        SET last_completed_at = clock_timestamp() - make_interval(secs => $1)
      WHERE routine_name = 'tick'`,
    [secondsAgo],
  );

describe("health snapshots", () => {
  describe("maintenance and schedule failures", () => {
    it("reports a routine whose newest three runs failed until it completes again", async () => {
      // The released-dependency phase cannot find its function, so each terminal cleanup pass
      // records a failed run. Two failed runs in a row do not change the verdict.
      await pool.query(
        `ALTER FUNCTION workhorse.prune_released_dependencies_v1(integer)
           RENAME TO prune_released_dependencies_v1_hidden`,
      );
      try {
        for (let run = 1; run <= 2; run += 1) {
          const phases = await queue.pruneTerminalStorage({ force: true });
          expect(
            phases.find(({ phase }) => phase === "released_dependencies")?.error,
          ).not.toBeNull();
        }
        expect(await reasonsOf("maintenance-failing")).toEqual([]);

        await queue.pruneTerminalStorage({ force: true });
        expect(await reasonsOf("maintenance-failing")).toEqual([
          {
            code: "maintenance-failing",
            severity: "degraded",
            observed: 3,
            budget: 2,
            routine: "terminal_storage",
          },
        ]);
      } finally {
        await pool.query(
          `ALTER FUNCTION workhorse.prune_released_dependencies_v1_hidden(integer)
             RENAME TO prune_released_dependencies_v1`,
        );
      }

      // The next pass succeeds, so the routine completed after its failed runs.
      await queue.pruneTerminalStorage({ force: true });
      expect(await reasonsOf("maintenance-failing")).toEqual([]);
    });

    it("counts only the failed runs after the last completion of a routine", async () => {
      // The tick records no run when an idle tick succeeds, but it sets its completion instant.
      // Three failed ticks with an idle success after each of the first two are not three failures
      // in a row.
      await failedTick(50);
      await idleSuccess(40);
      await failedTick(30);
      await idleSuccess(20);
      await failedTick(10);
      expect(await reasonsOf("maintenance-failing")).toEqual([]);

      // Two more failed ticks make three after the last completion.
      await failedTick(5);
      await failedTick(1);
      expect(await reasonsOf("maintenance-failing")).toEqual([
        {
          code: "maintenance-failing",
          severity: "degraded",
          observed: 3,
          budget: 2,
          routine: "tick",
        },
      ]);
    });

    it("reports a schedule whose last schedule pass failed until a pass fires it", async () => {
      await queue.syncSchedules("health", [
        {
          name: "bad",
          schedule: "* * * * * *",
          task: { type: "t.bad", payload: {}, queue: "health-fast", concurrencyKey: "k" },
        },
      ]);
      // A fast-tier queue refuses a concurrency key, so each fire of the schedule fails.
      await pool.query(
        "SELECT workhorse.set_queue_tier_v1('health-fast', 'fast', 'operator', 'proof')",
      );
      const fire = async (seconds: number) =>
        pool.query(
          `SELECT 1 FROM workhorse.fire_due_schedules_v2(
             ARRAY['health'],
             (SELECT last_evaluated_at FROM workhorse.schedule_definition
               WHERE schedule_name = 'bad') + make_interval(secs => $1),
             100, 1000)`,
          [seconds],
        );
      await fire(3);
      expect(await reasonsOf("schedule-failing")).toEqual([
        { code: "schedule-failing", severity: "degraded", observed: 1, budget: 0 },
      ]);

      // The queue returns to the full tier, and the next pass fires the schedule.
      await pool.query(
        "SELECT workhorse.set_queue_tier_v1('health-fast', 'full', 'operator', 'proof')",
      );
      await fire(3);
      expect(await reasonsOf("schedule-failing")).toEqual([]);
    });
  });

  it("counts only recent external-wait rejections through the partial event index", async () => {
    const taskId = await queue.enqueue("rejection-health", {});
    const oldDay = "2016-01-04";
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
       VALUES ($1, 'signal_rejected', $2::date),
              ($1, 'human_wait_rejected', clock_timestamp())`,
      [taskId, oldDay],
    );

    await expect(queue.health()).resolves.toMatchObject({
      externalWaits: { rejectedDeliveries: 1, capped: false },
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const indexNames = (
        await client.query<{ index_name: string }>(
          `SELECT child.relname AS index_name
             FROM pg_class parent
             JOIN pg_inherits inheritance ON inheritance.inhparent = parent.oid
             JOIN pg_class child ON child.oid = inheritance.inhrelid
            WHERE parent.oid = 'workhorse.task_event_rejected_delivery_idx'::regclass`,
        )
      ).rows.map((row) => row.index_name);
      const plan = (
        await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
          SELECT 1
            FROM workhorse.task_event
           WHERE event_type IN ('signal_rejected', 'human_wait_rejected')
             AND occurred_at >= $1::timestamptz
           ORDER BY occurred_at DESC, event_id DESC
           LIMIT 10001`,
          [new Date(Date.now() - EXTERNAL_WAIT_REJECTION_WINDOW_MS)],
        )
      ).rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");

      expect(indexNames.length).toBeGreaterThan(0);
      expect(indexNames.some((indexName) => plan.includes(indexName))).toBe(true);
      expect(plan).not.toContain("task_event_20160104");
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    await pool.query("SELECT workhorse.retire_history_day_v1($1)", [oldDay]);
  });

  it("reports exact retry and expired-lease counts from the production tick recovery phase", async () => {
    const retryId = await queue.enqueue("telemetry-retry", null, { maxAttempts: 2 });
    const terminalId = await queue.enqueue("telemetry-terminal", null, { maxAttempts: 1 });
    expect((await queue.claim("telemetry-retry-worker", { leaseMs: 100 }))?.id).toBe(retryId);
    expect((await queue.claim("telemetry-terminal-worker", { leaseMs: 100 }))?.id).toBe(terminalId);
    await pool.query(
      `UPDATE workhorse.task_runtime
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE task_id = ANY($1::uuid[])`,
      [[retryId, terminalId]],
    );

    const tick = await pool.query<{
      phase: string;
      rows_affected: number;
      expired_leases: number;
      retried: number;
      retry_dimensions: Array<{ queue: string; type: string }>;
    }>("SELECT * FROM workhorse.tick_v1(100, 100)");
    const recovery = tick.rows.find((row) => row.phase === "recover");

    expect(recovery).toMatchObject({ rows_affected: 2, expired_leases: 2, retried: 1 });
    expect(recovery?.retry_dimensions).toEqual([{ queue: "default", type: "telemetry-retry" }]);
    expect((await admin.getTask(retryId))?.state).toBe("ready");
    expect((await admin.getTask(terminalId))?.state).toBe("failed");
  });

  it("returns per-phase tick and background maintenance telemetry", async () => {
    const scheduledId = await queue.enqueue(
      "scheduled-maintenance",
      {},
      { runAt: new Date(Date.now() + 80) },
    );
    await sleep(100);
    await pool.query(
      `INSERT INTO workhorse.schedule_definition(
         namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
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
    expect((await admin.getTask(scheduledId))?.state).toBe("ready");

    await queue.syncRetentionPolicy({ ...defaultRetentionPolicy, occurrenceRowsPerPass: 1 });
    expect([
      ...(await queue.prepareHistoryPartitions({ force: true })),
      ...(await queue.retainHistory({ force: true })),
      ...(await queue.pruneTerminalStorage({ force: true })),
    ]).toEqual([
      {
        phase: "history_partitions",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "event_retention",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "attempt_retention",
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
      {
        phase: "enqueue_idempotency",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "released_dependencies",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "terminal_tasks",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
      {
        phase: "task_groups",
        rowsAffected: 0,
        durationMs: expect.any(Number),
        skippedLock: false,
        error: null,
      },
    ]);
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

      await blocker.query(
        "SELECT pg_advisory_lock(hashtextextended('workhorse:maintenance:history-partitions', 0))",
      );
      expect(await queue.prepareHistoryPartitions({ force: true })).toEqual([
        {
          phase: "history_partitions",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
      ]);
      await blocker.query("SELECT pg_advisory_unlock_all()");
      await blocker.query(
        "SELECT pg_advisory_lock(hashtextextended('workhorse:maintenance:history-retention', 0))",
      );
      expect(await queue.retainHistory({ force: true })).toEqual([
        {
          phase: "event_retention",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "attempt_retention",
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
      await blocker.query("SELECT pg_advisory_unlock_all()");
      await blocker.query(
        "SELECT pg_advisory_lock(hashtextextended('workhorse:maintenance:terminal-storage', 0))",
      );
      expect(await queue.pruneTerminalStorage({ force: true })).toEqual([
        {
          phase: "enqueue_idempotency",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "released_dependencies",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "terminal_tasks",
          rowsAffected: 0,
          durationMs: 0,
          skippedLock: true,
          error: null,
        },
        {
          phase: "task_groups",
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

  it("reports queue and PostgreSQL health", async () => {
    const waitingId = await queue.enqueue("waiting", {});
    const waiting = await queue.claim("health-worker");
    expect(waiting?.id).toBe(waitingId);
    const scheduledWait = await queue.scheduleWait(waiting!, "health-worker", "health-window", {
      durationMs: 60_000,
    });
    await queue.enqueue("ready", {});
    await queue.enqueue("later", {}, { runAt: new Date(Date.now() + 60_000) });
    const health = await queue.health();
    expect(health.schemaVersion).toBe(WORKHORSE_SCHEMA_VERSION);
    expect(health.readyDepth).toBe(1);
    expect(health.scheduledDepth).toBe(2);
    expect(health.sleepingTasks).toBe(1);
    expect(health.overdueWaits).toBe(0);
    expect(health.nextWakeAt).toEqual(scheduledWait.wait.wakeAt);
    expect(health.capturedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(health.terminalCountsCapped).toBe(false);
    expect(health.statistics.bucketsCapped).toBe(false);
    expect(health.historyPartitionDays).toHaveLength(4);
    expect(
      health.observations.relations.some((relation) => relation.relation === "task_runtime"),
    ).toBe(true);
    expect(health.observations.lockWaitCount).toBeGreaterThanOrEqual(0);
    expect(health.observations.notificationQueueUsage).toBeGreaterThanOrEqual(0);
    expect(await queue.queueMetricSnapshot()).toEqual([
      {
        queue: "default",
        readyDepth: 1,
        scheduledDepth: 2,
        activeLeases: 0,
        dependencyBlockedDepth: 0,
        dependencyPendingEdges: 0,
        dependencyFailedResolutions: 0,
        dependencyCountsCapped: false,
        childWaitingParents: 0,
        childPendingChildren: 0,
        childUnjoinedResults: 0,
        childFailedParents: 0,
        childCanceledParents: 0,
        childCountsCapped: false,
        oldestReadyAgeMs: expect.any(Number),
        concurrencyLimit: null,
        concurrencyActive: 0,
        blockedReadyDepth: 0,
        rateLimitPerSecond: null,
        rateLimitAvailableTokens: 0,
        rateLimitThrottledReadyDepth: 0,
        rateLimitNextEligibleDelayMs: null,
      },
    ]);
  });

  it("observes the same live depth through the metrics observer", async () => {
    // health(), queueMetricSnapshot(), and the observer share one depth read, so this asserts the
    // observer's gauges against the health snapshot taken from the same rows. A paused queue with
    // no tasks is included because only the observer reports it, and it must report zeroes.
    await queue.enqueue("ready", {});
    await queue.enqueue("later", {}, { runAt: new Date(Date.now() + 60_000) });
    const claimed = await queue.claim("observer-worker");
    expect(claimed).not.toBeNull();
    await pool.query(
      `INSERT INTO workhorse.task_event(task_id, event_type, occurred_at)
       VALUES ($1, 'signal_rejected', clock_timestamp() - interval '25 hours'),
              ($1, 'signal_rejected', clock_timestamp() - interval '23 hours')`,
      [claimed!.id],
    );
    await admin.pauseQueue("idle-paused", adminAudit("observe paused queue"));

    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    const previousProvider = metrics.getMeterProvider();
    metrics.setGlobalMeterProvider(provider);
    try {
      await new WorkhorseMetricsObserver(pool).collect();
      await provider.forceFlush();
    } finally {
      metrics.setGlobalMeterProvider(previousProvider);
      await provider.shutdown();
    }

    const points = (exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "workhorse.tasks.count")?.dataPoints ??
      []) as DataPoint<number>[];
    const depth = (queueName: string, state: string) =>
      points.find(
        (point) =>
          point.attributes["workhorse.queue.name"] === queueName &&
          point.attributes["workhorse.task.state"] === state,
      )?.value;
    const health = await queue.health();
    expect(depth("default", "ready")).toBe(health.readyDepth);
    expect(depth("default", "scheduled")).toBe(health.scheduledDepth);
    expect(depth("default", "active")).toBe(health.activeLeases);
    expect(depth("idle-paused", "ready")).toBe(0);
    expect(depth("idle-paused", "scheduled")).toBe(0);
    expect(depth("idle-paused", "active")).toBe(0);
    const rejectedPoints = (exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === "workhorse.wait.delivery.rejected")
      ?.dataPoints ?? []) as DataPoint<number>[];
    expect(
      rejectedPoints.find(
        (point) =>
          point.attributes["workhorse.queue.name"] === "default" &&
          point.attributes["workhorse.wait.kind"] === "signal",
      )?.value,
    ).toBe(1);
  });

  it("syncs, overrides, and reverts the terminal cleanup backlog budget on its own", async () => {
    type PolicyRow = {
      row_retention_lag_ms: number;
      terminal_cleanup_backlog_ms: number;
      application_terminal_cleanup_backlog_ms: number;
      operator_overrides: string[];
    };
    const policy = async (statement: string) =>
      (await pool.query<{ policy: PolicyRow }>(`SELECT to_jsonb(${statement}) AS policy`)).rows[0]!
        .policy;
    const defaults = "10000, 1800000, 21600000, 172800000, 2";
    try {
      // v2 seeds the application value and, without an override, the effective one.
      expect(
        await policy(`workhorse.sync_queue_health_policy_v2(${defaults}, 3600000)`),
      ).toMatchObject({
        terminal_cleanup_backlog_ms: 3_600_000,
        application_terminal_cleanup_backlog_ms: 3_600_000,
      });
      expect((await queue.health()).budgets.terminalCleanupBacklogMs).toBe(3_600_000);

      // A v1 sync writes only its five budgets, row retention included.
      expect(
        await policy(
          `workhorse.sync_queue_health_policy_v1(10000, 1800000, 7200000, 172800000, 2)`,
        ),
      ).toMatchObject({
        row_retention_lag_ms: 7_200_000,
        terminal_cleanup_backlog_ms: 3_600_000,
        application_terminal_cleanup_backlog_ms: 3_600_000,
      });

      // An operator override survives a v2 sync until it is reverted.
      expect(
        await policy(
          `workhorse.override_queue_health_policy_v1('{"terminal_cleanup_backlog_ms": 60000}')`,
        ),
      ).toMatchObject({
        terminal_cleanup_backlog_ms: 60_000,
        operator_overrides: ["terminal_cleanup_backlog_ms"],
      });
      expect(
        await policy(`workhorse.sync_queue_health_policy_v2(${defaults}, 1800000)`),
      ).toMatchObject({
        terminal_cleanup_backlog_ms: 60_000,
        application_terminal_cleanup_backlog_ms: 1_800_000,
      });
      expect(
        await policy(
          "workhorse.revert_queue_health_policy_v1(ARRAY['terminal_cleanup_backlog_ms'])",
        ),
      ).toMatchObject({ terminal_cleanup_backlog_ms: 1_800_000, operator_overrides: [] });

      // A forced v1 sync clears every override, so it restores the backlog budget too.
      await policy(
        `workhorse.override_queue_health_policy_v1('{"terminal_cleanup_backlog_ms": 60000}')`,
      );
      expect(
        await policy(`workhorse.sync_queue_health_policy_v1(${defaults}, true)`),
      ).toMatchObject({
        terminal_cleanup_backlog_ms: 1_800_000,
        application_terminal_cleanup_backlog_ms: 1_800_000,
        operator_overrides: [],
      });
    } finally {
      await pool.query(`SELECT workhorse.sync_queue_health_policy_v2(${defaults}, 21600000, true)`);
    }
  });

  it("evaluates database-owned health budgets into machine-readable status reasons", async () => {
    await queue.prepareHistoryPartitions();
    const baseline = await queue.health();
    expect(
      baseline.historyPartitionDays.every((day) => day.hasTaskEvents && day.hasAttemptHistory),
    ).toBe(true);
    expect(baseline.status.reasons.map((reason) => reason.code)).not.toContain(
      "missing-history-partitions",
    );
    for (const reason of baseline.status.reasons) {
      expect(reason.observed).toBeGreaterThan(reason.budget);
    }

    await pool.query(
      `SELECT workhorse.override_queue_health_policy_v1(
         '{"rollup_stalled_lag_ms": 0}'::jsonb
       )`,
    );
    await pool.query(
      "SELECT workhorse.sync_queue_health_policy_v1(10000, 1800000, 21600000, 172800000, 2)",
    );

    // Application sync preserves the operator override, and every caller receives its verdict.
    const strict = await queue.health();
    expect(strict.budgets.rollupStalledLagMs).toBe(0);
    expect(strict.status.level).not.toBe("healthy");
    expect(strict.status.reasons).toContainEqual(
      expect.objectContaining({ code: "rollup-stalled", severity: "degraded", budget: 0 }),
    );
    await pool.query(
      "SELECT workhorse.revert_queue_health_policy_v1(ARRAY['rollup_stalled_lag_ms'])",
    );

    // An expired lease is critical, with the reason and the count read from one snapshot.
    await queue.enqueue("health-budget", {});
    const claimed = await queue.claim("health-budget-worker");
    expect(claimed).not.toBeNull();
    await pool.query(
      `UPDATE workhorse.task_runtime
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE task_id = $1 AND state = 'active'`,
      [claimed!.id],
    );
    const critical = await queue.health();
    expect(critical.status.level).toBe("critical");
    const expired = critical.status.reasons.find((reason) => reason.code === "expired-leases");
    expect(expired).toMatchObject({ severity: "critical", budget: 0 });
    expect(expired!.observed).toBe(critical.expiredLeases);
    expect(critical.expiredLeases).toBeGreaterThanOrEqual(1);
    await queue.recoverExpired();
  });

  describe("terminal retention boundaries", () => {
    it("plans each retention walk with its cutoff as an index condition", async () => {
      // A cutoff from clock_timestamp() is volatile, so PostgreSQL tested it as a filter on each
      // index row. With nothing eligible, each health poll then read every task and every terminal
      // outcome (SM-1936).
      await queue.syncRetentionPolicy(defaultRetentionPolicy);
      await seed(20);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // The tables are small, so a scan of the whole table is cheaper here. A long history makes
        // the planner walk the indexes in order, and this test checks their conditions.
        await client.query("SET LOCAL enable_seqscan = off");
        await client.query("SET LOCAL enable_bitmapscan = off");
        const plan = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
          `EXPLAIN (FORMAT JSON) ${await boundaryBody()}`,
        );
        const scans = planNodes(plan.rows[0]!["QUERY PLAN"][0]!.Plan).filter((node) =>
          retentionIndexes.includes(node["Index Name"] ?? ""),
        );
        expect(new Set(scans.map((node) => node["Index Name"]))).toEqual(new Set(retentionIndexes));
        for (const scan of scans) {
          const column =
            scan["Index Name"] === "task_created_retention_idx" ? "created_at" : "finished_at";
          expect(scan["Index Cond"]).toMatch(new RegExp(`\\b${column} < `));
          expect(scan.Filter ?? "").not.toMatch(new RegExp(`\\b${column}\\b`));
        }
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("stops each walk at its cap behind more held rows than the cap", async () => {
      // An enqueue key that lives longer than the task window keeps each of these tasks on purpose.
      // Each walk examines at most terminal_retention_walk_rows_internal_v1() rows, so a poll does
      // not read every kept row. Behind more kept rows than the cap, the walk finds no eligible row
      // and reports no boundary. The terminal cleanup backlog shows a late cleanup instead.
      await queue.syncRetentionPolicy(defaultRetentionPolicy);
      const cap = Number(
        (
          await pool.query<{ cap: number }>(
            "SELECT workhorse.terminal_retention_walk_rows_internal_v1() AS cap",
          )
        ).rows[0]!.cap,
      );
      // A poll stores where the held rows end, and the next poll starts there (SM-2021). This test
      // measures the walk of a first poll, so it clears the stored start before each read.
      const clearStart = () => pool.query("DELETE FROM workhorse.terminal_retention_walk_start");
      const walked: number[] = [];
      for (const held of [cap + 100, cap + 400]) {
        await pool.query("DELETE FROM workhorse.enqueue_idempotency");
        await pool.query("DELETE FROM workhorse.task");
        await seedHeldBeforeEligible(held);
        await clearStart();
        const health = await queue.health();
        expect(health.retentionLagMs.taskIdentity).toBeNull();
        expect(health.retentionLagMs.terminalOutcome).toBeNull();
        await clearStart();
        walked.push(await walkReads());
      }
      expect(walked[1]).toBe(walked[0]);
      expect(walked[0]).toBeLessThanOrEqual(4 * (cap + 2));
    });

    it("reads a bounded number of retention index rows at two data sizes", async () => {
      // A held watermark once made each walk read every aged row behind it, and the member read
      // joined every member of every finished group (SM-1990). Each walk now stops at its cutoff
      // and at the watermark, so the rows that one snapshot reads do not grow with these rows.
      await queue.syncRetentionPolicy(defaultRetentionPolicy);
      // The counters also count index entries that earlier tests left dead, so the test compares
      // each size with the reads before the seed. The snapshot also reads the oldest row of each
      // index once, so the difference stays at a few rows.
      const baseline = await snapshotReads();
      for (const count of [40, 120]) {
        await seed(count);
        const reads = await snapshotReads();
        reads.forEach((tuples, index) => expect(tuples - baseline[index]!).toBeLessThan(10));
        expect(await walkReads()).toBe(0);
      }
      const walked: number[] = [];
      for (const count of [40, 120]) {
        await seed(count, true);
        walked.push(await walkReads());
      }
      expect(walked[1]).toBe(walked[0]);
      expect(walked[0]).toBeLessThan(10);
    });
  });
});

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
import { describe, expect, it } from "vitest";
import { WorkhorseMetricsObserver } from "../src/index.js";
import { EXTERNAL_WAIT_REJECTION_WINDOW_MS } from "../src/types.js";
import { createIntegrationTestContext } from "./support/integration.js";
import { WORKHORSE_SCHEMA_VERSION } from "../src/index.js";

registerOpenTelemetry();

const { defaultRetentionPolicy, pool, queue, admin, adminAudit } = createIntegrationTestContext(
  import.meta.url,
);

describe("health snapshots", () => {
  it("counts only recent external-wait rejections through the partial event index", async () => {
    const jobId = await queue.enqueue("rejection-health", {});
    const oldDay = "2016-01-04";
    await pool.query("SELECT workhorse.create_history_day_v1($1)", [oldDay]);
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
       VALUES ($1, 'signal_rejected', $2::date),
              ($1, 'human_wait_rejected', clock_timestamp())`,
      [jobId, oldDay],
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
            WHERE parent.oid = 'workhorse.job_event_rejected_delivery_idx'::regclass`,
        )
      ).rows.map((row) => row.index_name);
      const plan = (
        await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
          SELECT 1
            FROM workhorse.job_event
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
      expect(plan).not.toContain("job_event_20160104");
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
      `UPDATE workhorse.job_runtime
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE job_id = ANY($1::uuid[])`,
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
    expect((await admin.getJob(retryId))?.state).toBe("ready");
    expect((await admin.getJob(terminalId))?.state).toBe("failed");
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
    expect((await admin.getJob(scheduledId))?.state).toBe("ready");

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
        phase: "terminal_jobs",
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
          phase: "terminal_jobs",
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
    expect(health.sleepingJobs).toBe(1);
    expect(health.overdueWaits).toBe(0);
    expect(health.nextWakeAt).toEqual(scheduledWait.wait.wakeAt);
    expect(health.capturedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(health.terminalCountsCapped).toBe(false);
    expect(health.statistics.bucketsCapped).toBe(false);
    expect(health.historyPartitionDays).toHaveLength(4);
    expect(
      health.observations.relations.some((relation) => relation.relation === "job_runtime"),
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
    // no jobs is included because only the observer reports it, and it must report zeroes.
    await queue.enqueue("ready", {});
    await queue.enqueue("later", {}, { runAt: new Date(Date.now() + 60_000) });
    const claimed = await queue.claim("observer-worker");
    expect(claimed).not.toBeNull();
    await pool.query(
      `INSERT INTO workhorse.job_event(job_id, event_type, occurred_at)
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
      .find((candidate) => candidate.descriptor.name === "workhorse.jobs.count")?.dataPoints ??
      []) as DataPoint<number>[];
    const depth = (queueName: string, state: string) =>
      points.find(
        (point) =>
          point.attributes["workhorse.queue.name"] === queueName &&
          point.attributes["workhorse.job.state"] === state,
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

  it("evaluates database-owned health budgets into machine-readable status reasons", async () => {
    await queue.prepareHistoryPartitions();
    const baseline = await queue.health();
    expect(
      baseline.historyPartitionDays.every((day) => day.hasJobEvents && day.hasAttemptHistory),
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
      `UPDATE workhorse.job_runtime
          SET expires_at = clock_timestamp() - interval '1 second'
        WHERE job_id = $1 AND state = 'active'`,
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
});

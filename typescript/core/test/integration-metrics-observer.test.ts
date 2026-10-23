import { randomUUID } from "node:crypto";
import { metrics } from "@opentelemetry/api";
import { registerOpenTelemetry } from "@stablemates/workhorse-otel";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { WorkhorseMetricsObserver } from "../src/index.js";
import { createIntegrationTestContext } from "./support/integration.js";

// Cumulative export keeps a synchronous gauge's last value, which is how a stale series would reach
// a monitoring backend.
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
});
metrics.setGlobalMeterProvider(provider);
registerOpenTelemetry();

const { pool, queue, admin, adminAudit } = createIntegrationTestContext(import.meta.url);

beforeEach(() => exporter.reset());
afterAll(() => provider.shutdown());

async function observe(observer: WorkhorseMetricsObserver) {
  exporter.reset();
  await observer.collect();
  await provider.forceFlush();
  const exported = exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics);
  return (name: string, attributes: Record<string, string>) =>
    (
      exported.find((candidate) => candidate.descriptor.name === name)?.dataPoints as
        | DataPoint<number>[]
        | undefined
    )?.find(
      (point) =>
        Object.keys(point.attributes).length === Object.keys(attributes).length &&
        Object.entries(attributes).every(([key, expected]) => point.attributes[key] === expected),
    )?.value;
}

function routine(name: string) {
  return { "workhorse.maintenance.routine": name };
}

function category(name: string) {
  return { "workhorse.retention.category": name };
}

describe("metrics observer", () => {
  it("counts fast-tier work in both queue metric statements", async () => {
    // A fast-tier queue keeps its live rows in fast_task_runtime. A ready row with a future run
    // time counts as scheduled, as queue_health_v1 counts it.
    await expect(
      admin.setQueueTier("fast-metrics", "fast", adminAudit("move to the fast tier")),
    ).resolves.toBe("fast");
    await queue.enqueue("claimed", {}, { queue: "fast-metrics" });
    await queue.enqueue("ready", {}, { queue: "fast-metrics" });
    await queue.enqueue(
      "later",
      {},
      { queue: "fast-metrics", runAt: new Date(Date.now() + 60_000) },
    );
    const [claimed] = await queue.claimFast("fast-observer", 1, { queue: "fast-metrics" });
    expect(claimed).toBeDefined();
    await pool.query(
      `UPDATE workhorse.fast_task_runtime
          SET expires_at = clock_timestamp() - interval '1 second',
              deadline_at = clock_timestamp() - interval '1 second'
        WHERE task_id = $1`,
      [claimed!.id],
    );

    await expect(queue.health()).resolves.toMatchObject({
      readyDepth: 1,
      scheduledDepth: 1,
      activeLeases: 1,
    });
    expect(await queue.queueMetricSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queue: "fast-metrics",
          readyDepth: 1,
          scheduledDepth: 1,
          activeLeases: 1,
          oldestReadyAgeMs: expect.any(Number),
        }),
      ]),
    );

    const value = await observe(new WorkhorseMetricsObserver(pool));
    const fast = { "workhorse.queue.name": "fast-metrics" };
    for (const state of ["ready", "scheduled", "active"]) {
      expect(value("workhorse.tasks.count", { ...fast, "workhorse.task.state": state })).toBe(1);
    }
    expect(value("workhorse.queue.oldest_ready.age", fast)).toBeGreaterThanOrEqual(0);
    expect(value("workhorse.lease.expired", fast)).toBe(1);
    expect(value("workhorse.deadline.overdue", fast)).toBe(1);
  });

  it("reports zero for a worker group that disappears and for an emptied queue", async () => {
    const observer = new WorkhorseMetricsObserver(pool);
    await queue.registerWorker({
      workerId: "observer-vanishing",
      instanceId: randomUUID(),
      hostname: "test-host",
      pid: 4321,
      queue: "observer-workers",
      concurrency: 4,
      activeSlots: 1,
      draining: false,
    });
    await queue.enqueue("drained", {}, { queue: "observer-emptied" });

    const running = {
      "workhorse.queue.name": "observer-workers",
      "workhorse.worker.state": "running",
    };
    const emptied = { "workhorse.queue.name": "observer-emptied" };
    const before = await observe(observer);
    expect(before("workhorse.worker.count", running)).toBe(1);
    expect(before("workhorse.worker.capacity", running)).toBe(4);
    expect(before("workhorse.worker.active", running)).toBe(1);
    expect(before("workhorse.tasks.count", { ...emptied, "workhorse.task.state": "ready" })).toBe(
      1,
    );
    expect(before("workhorse.queue.oldest_ready.age", emptied)).toBeGreaterThanOrEqual(0);

    await expect(queue.deregisterWorker("observer-vanishing")).resolves.toBe(true);
    const task = await queue.claim("observer-claimer", { queue: "observer-emptied" });
    expect(task).not.toBeNull();
    await expect(queue.complete(task!, "observer-claimer", {})).resolves.toBe(true);

    const after = await observe(observer);
    expect(after("workhorse.worker.count", running)).toBe(0);
    expect(after("workhorse.worker.capacity", running)).toBe(0);
    expect(after("workhorse.worker.active", running)).toBe(0);
    for (const state of ["ready", "scheduled", "active"]) {
      expect(after("workhorse.tasks.count", { ...emptied, "workhorse.task.state": state })).toBe(0);
    }
    expect(after("workhorse.queue.oldest_ready.age", emptied)).toBe(0);
  });

  it("reports a growing age for a routine whose completion stays fixed", async () => {
    // A routine that stops running records no phase error. Its stored completion stays fixed, so
    // the observer must still give a value that grows.
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET last_completed_at = clock_timestamp() - interval '1 hour'
        WHERE routine_name = 'terminal_storage'`,
    );
    await pool.query(
      `UPDATE workhorse.maintenance_policy
          SET terminal_cleanup_interval_ms = 300000, statistics_rollup_interval_ms = 0
        WHERE singleton`,
    );
    const observer = new WorkhorseMetricsObserver(pool);
    const terminal = { "workhorse.maintenance.routine": "terminal_storage" };

    const first = await observe(observer);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_100);
    });
    const second = await observe(observer);

    const firstAge = first("workhorse.maintenance.routine.age", terminal)!;
    const secondAge = second("workhorse.maintenance.routine.age", terminal)!;
    expect(firstAge).toBeGreaterThanOrEqual(3_600);
    expect(secondAge).toBeGreaterThanOrEqual(firstAge + 1);
    // The routine was due 5 minutes after it completed.
    expect(second("workhorse.maintenance.routine.overdue", terminal)).toBeCloseTo(
      secondAge - 300,
      0,
    );
    // A rollup that the policy turns off is never overdue.
    expect(second("workhorse.maintenance.routine.overdue", routine("statistics_rollup"))).toBe(0);
    for (const name of [
      "tick",
      "history_partitions",
      "history_retention",
      "terminal_storage",
      "statistics_rollup",
    ]) {
      expect(second("workhorse.maintenance.routine.age", routine(name))).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the due rule of each scheduler gate", async () => {
    // A pass that ended with a backlog is due again after the follow-up delay, not the interval.
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET last_completed_at = clock_timestamp() - interval '60 seconds',
              terminal_cleanup_backlog_since = clock_timestamp() - interval '5 minutes'
        WHERE routine_name = 'terminal_storage'`,
    );
    await pool.query(
      `UPDATE workhorse.maintenance_policy
          SET terminal_cleanup_interval_ms = 300000,
              timezone = 'America/New_York', history_retention_local_time = '02:30'
        WHERE singleton`,
    );
    // On 2026-03-08, New York skips from 02:00 to 03:00, so the 02:30 pass is due at 03:00 EDT.
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET last_completed_local_date = '2026-03-07',
              last_completed_at = '2026-03-07T08:00:00Z'
        WHERE routine_name = 'history_retention'`,
    );
    // A routine that never completed is due at once, so its overdue time is its age.
    await pool.query(
      `UPDATE workhorse.maintenance_state SET last_completed_at = NULL
        WHERE routine_name = 'history_partitions'`,
    );
    const observedAt = Date.now();
    const value = await observe(new WorkhorseMetricsObserver(pool));

    const terminal = value("workhorse.maintenance.routine.overdue", routine("terminal_storage"))!;
    expect(terminal).toBeGreaterThanOrEqual(54);
    expect(terminal).toBeLessThan(65);
    const retention = value("workhorse.maintenance.routine.overdue", routine("history_retention"))!;
    expect(
      Math.abs(retention - (observedAt - Date.parse("2026-03-08T07:00:00Z")) / 1_000),
    ).toBeLessThan(10);
    expect(
      value("workhorse.maintenance.routine.overdue", routine("history_partitions")),
    ).toBeCloseTo(value("workhorse.maintenance.routine.age", routine("history_partitions"))!, 2);

    // On 2025-11-02, New York repeats 01:00 to 02:00, so the 01:30 pass is due at 01:30 EDT.
    await pool.query(
      `UPDATE workhorse.maintenance_policy SET history_retention_local_time = '01:30'
        WHERE singleton`,
    );
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET last_completed_local_date = '2025-11-01',
              last_completed_at = '2025-11-01T06:00:00Z'
        WHERE routine_name = 'history_retention'`,
    );
    const repeated = await observe(new WorkhorseMetricsObserver(pool));
    expect(
      Math.abs(
        repeated("workhorse.maintenance.routine.overdue", routine("history_retention"))! -
          (Date.now() - Date.parse("2025-11-02T05:30:00Z")) / 1_000,
      ),
    ).toBeLessThan(10);

    // On 2025-11-02, Havana repeats the hour from midnight, so the 00:30 pass is due at the
    // first 00:30, which is 04:30 UTC.
    await pool.query(
      `UPDATE workhorse.maintenance_policy
          SET timezone = 'America/Havana', history_retention_local_time = '00:30'
        WHERE singleton`,
    );
    const midnight = await observe(new WorkhorseMetricsObserver(pool));
    expect(
      Math.abs(
        midnight("workhorse.maintenance.routine.overdue", routine("history_retention"))! -
          (Date.now() - Date.parse("2025-11-02T04:30:00Z")) / 1_000,
      ),
    ).toBeLessThan(10);

    // Antarctica/Casey repeats three hours on 2023-03-09, so the 01:30 pass is due at the
    // first 01:30, which is 14:30 UTC on 2023-03-08.
    await pool.query(
      `UPDATE workhorse.maintenance_policy
          SET timezone = 'Antarctica/Casey', history_retention_local_time = '01:30'
        WHERE singleton`,
    );
    await pool.query(
      `UPDATE workhorse.maintenance_state SET last_completed_local_date = '2023-03-08'
        WHERE routine_name = 'history_retention'`,
    );
    const casey = await observe(new WorkhorseMetricsObserver(pool));
    expect(
      Math.abs(
        casey("workhorse.maintenance.routine.overdue", routine("history_retention"))! -
          (Date.now() - Date.parse("2023-03-08T14:30:00Z")) / 1_000,
      ),
    ).toBeLessThan(10);

    // A policy change clears the completed date. The pass is then due from the change, and it
    // stays due on later days, even with a late retention time.
    await pool.query(
      `UPDATE workhorse.maintenance_policy
          SET timezone = 'UTC', history_retention_local_time = '23:59:59',
              updated_at = clock_timestamp() - interval '2 days'
        WHERE singleton`,
    );
    await pool.query(
      `UPDATE workhorse.retention_policy SET updated_at = clock_timestamp() - interval '2 days'
        WHERE singleton`,
    );
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET last_completed_local_date = NULL,
              last_completed_at = clock_timestamp() - interval '3 days'
        WHERE routine_name = 'history_retention'`,
    );
    const clearedAt = Date.now();
    const cleared = await observe(new WorkhorseMetricsObserver(pool));
    const due = new Date(clearedAt - 2 * 86_400_000);
    due.setUTCHours(23, 59, 59, 0);
    expect(
      Math.abs(
        cleared("workhorse.maintenance.routine.overdue", routine("history_retention"))! -
          (clearedAt - due.getTime()) / 1_000,
      ),
    ).toBeLessThan(10);
  });

  it("counts a worker as live for its own lease when it sets the tick cadence", async () => {
    // A worker with a long lease refreshes its registration seldom. Its last heartbeat is 12
    // minutes old, but it is still live, so its 30-minute tick is not due.
    await queue.registerWorker({
      workerId: "observer-slow-registry",
      instanceId: randomUUID(),
      hostname: "test-host",
      pid: 4322,
      queue: "observer-slow",
      concurrency: 1,
      activeSlots: 0,
      draining: false,
    });
    await pool.query(
      `UPDATE workhorse.worker_registry
          SET lease_ms = 3600000, heartbeat_ms = 60000, maintenance_interval_ms = 1800000,
              last_heartbeat_at = clock_timestamp() - interval '12 minutes'
        WHERE worker_id = 'observer-slow-registry'`,
    );
    await pool.query(
      `UPDATE workhorse.maintenance_state
          SET last_completed_at = clock_timestamp() - interval '12 minutes'
        WHERE routine_name = 'tick'`,
    );
    try {
      const value = await observe(new WorkhorseMetricsObserver(pool));
      expect(value("workhorse.maintenance.routine.overdue", routine("tick"))).toBe(0);
      expect(value("workhorse.maintenance.routine.age", routine("tick"))).toBeGreaterThanOrEqual(
        720,
      );
    } finally {
      await queue.deregisterWorker("observer-slow-registry");
    }
  });

  it("separates a disabled retention category from one that lags", async () => {
    // The identity chain lets an operator turn off task identity and terminal outcome retention
    // together, and keeps the history categories on.
    await pool.query(
      `UPDATE workhorse.retention_policy
          SET task_identity_retention_days = NULL, terminal_outcome_retention_days = NULL
        WHERE singleton`,
    );
    const value = await observe(new WorkhorseMetricsObserver(pool));

    for (const disabled of ["taskIdentity", "terminalOutcome"]) {
      expect(value("workhorse.retention.enabled", category(disabled))).toBe(0);
      expect(value("workhorse.retention.lag", category(disabled))).toBe(0);
    }
    expect(value("workhorse.retention.enabled", category("taskEvents"))).toBe(1);
    // The budgets are the queue health budgets: partition lag for history partitions and row lag
    // for the row categories.
    const health = await queue.health();
    expect(value("workhorse.retention.lag_budget", category("taskEvents"))).toBe(
      health.budgets.partitionRetentionLagMs / 1_000,
    );
    expect(value("workhorse.retention.lag_budget", category("taskIdentity"))).toBe(
      health.budgets.rowRetentionLagMs / 1_000,
    );

    // A statistics bucket 10 days old is 9 days past a one-day window.
    await pool.query(
      `UPDATE workhorse.retention_policy SET statistics_retention_days = 1 WHERE singleton`,
    );
    await pool.query(
      `INSERT INTO workhorse.task_stat_bucket(bucket_start, queue_name, task_type)
       VALUES (date_bin('1 minute', clock_timestamp() - interval '10 days',
                        timestamp '2000-01-01' AT TIME ZONE 'UTC'),
               'observer-retention', 'stale')`,
    );
    const lagging = await observe(new WorkhorseMetricsObserver(pool));
    const reason = (await queue.health()).status.reasons.find(
      (candidate) => candidate.code === "retention-lag" && candidate.category === "statistics",
    );
    expect(reason).toBeDefined();
    const lag = lagging("workhorse.retention.lag", category("statistics"))!;
    expect(lag).toBeGreaterThan(9 * 86_400 - 60);
    expect(Math.abs(lag - reason!.observed / 1_000)).toBeLessThan(5);
    expect(lag).toBeGreaterThan(lagging("workhorse.retention.lag_budget", category("statistics"))!);

    for (const name of [
      "taskIdentity",
      "terminalOutcome",
      "taskEvents",
      "attemptHistory",
      "scheduleOccurrences",
      "statistics",
    ]) {
      expect(value("workhorse.retention.lag", category(name))).toBeGreaterThanOrEqual(0);
    }
  });
});

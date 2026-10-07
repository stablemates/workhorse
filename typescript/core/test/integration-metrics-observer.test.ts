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
});

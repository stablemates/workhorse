import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerQueueApi } from "../src/worker.js";
import type { ClaimedJob, Queryable } from "../src/types.js";

const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const reader = new PeriodicExportingMetricReader({
  exporter,
  exportIntervalMillis: 60_000,
});
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);

function queryResult<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function metric(name: string) {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((candidate) => candidate.descriptor.name === name);
}

async function collect(): Promise<void> {
  await provider.forceFlush();
}

async function unsupportedWorkerQueueOperation(): Promise<never> {
  throw new Error("Worker queue operation was not configured for this test");
}

const workerQueueDefaults: WorkerQueueApi = {
  defaultQueue: "default",
  claim: async () => null,
  heartbeatStatus: unsupportedWorkerQueueOperation,
  expireOwned: unsupportedWorkerQueueOperation,
  acknowledgeCancel: unsupportedWorkerQueueOperation,
  listCheckpoints: unsupportedWorkerQueueOperation,
  saveCheckpoint: unsupportedWorkerQueueOperation,
  getProgress: unsupportedWorkerQueueOperation,
  updateProgress: unsupportedWorkerQueueOperation,
  listWaits: unsupportedWorkerQueueOperation,
  scheduleWait: unsupportedWorkerQueueOperation,
  waitForSignal: unsupportedWorkerQueueOperation,
  waitForHuman: unsupportedWorkerQueueOperation,
  createChild: unsupportedWorkerQueueOperation,
  createChildren: unsupportedWorkerQueueOperation,
  complete: unsupportedWorkerQueueOperation,
  fail: unsupportedWorkerQueueOperation,
  tick: async () => [],
  prepareHistoryPartitions: async () => [],
  rollupStatistics: async () => [],
  retainHistory: async () => [],
  pruneTerminalStorage: async () => [],
  schedules: unsupportedWorkerQueueOperation,
  fireSchedule: unsupportedWorkerQueueOperation,
  registerWorker: unsupportedWorkerQueueOperation,
  deregisterWorker: unsupportedWorkerQueueOperation,
  pruneWorkerRegistry: unsupportedWorkerQueueOperation,
};

function workerQueue(overrides: Partial<WorkerQueueApi>): WorkerQueueApi {
  return { ...workerQueueDefaults, ...overrides };
}

beforeEach(() => exporter.reset());
afterAll(() => provider.shutdown());

describe("Workhorse OpenTelemetry metrics", () => {
  it("counts accepted enqueue requests by queue and job type", async () => {
    const { Queue } = await import("../src/queue.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([
          { ordinal: 1, job_id: "job-1", outcome: "accepted" },
          { ordinal: 2, job_id: "job-2", outcome: "accepted" },
        ] as unknown as R[]),
    };
    const queue = new Queue(database);

    await queue.enqueueMany([
      { type: "email.send", payload: null, options: { queue: "mail" } },
      { type: "email.send", payload: null, options: { queue: "mail" } },
    ]);
    await collect();

    expect(metric("workhorse.jobs.enqueued")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 2,
      }),
    ]);
  });

  it("records worker executions by bounded outcome with their duration", async () => {
    const { Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: "job-1",
      queue: "mail",
      type: "email.send",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const queue = workerQueue({
      claim: async () => job,
      complete: async () => true,
    });
    const worker = new Worker(queue, {
      queue: "mail",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle("email.send", async () => null);

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "succeeded",
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 1,
      }),
    ]);
    expect(metric("workhorse.handler.duration")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "succeeded",
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
      }),
    ]);
  });

  it("records partial batch dispatch diagnostics", async () => {
    const { Worker } = await import("../src/worker.js");
    const jobs: ClaimedJob[] = [1, 2].map((value) => ({
      id: `batch-job-${value}`,
      queue: "mail",
      type: "email.batch",
      priority: value,
      payload: { value },
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: BigInt(value),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    }));
    const queue = workerQueue({
      claim: async () => jobs.shift() ?? null,
      complete: async () => true,
    });
    const worker = new Worker(queue, {
      queue: "mail",
      concurrency: 3,
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handleBatch<{ value: number }, null>("email.batch", { maxSize: 3, lingerMs: 1 }, (items) =>
      items.map(() => ({ status: "succeeded", result: null })),
    );

    await worker.runOnce();
    await collect();

    const attributes = {
      "workhorse.handler.batch.full": false,
      "workhorse.job.type": "email.batch",
      "workhorse.queue.name": "mail",
    };
    expect(metric("workhorse.handler.batch.size")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes,
        value: expect.objectContaining({ count: 1, sum: 2 }),
      }),
    ]);
    expect(metric("workhorse.handler.batch.linger")?.dataPoints).toEqual([
      expect.objectContaining({ attributes, value: expect.objectContaining({ count: 1 }) }),
    ]);
  });

  it("records a handler failure scheduled for another attempt as a retry", async () => {
    const { Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: "job-2",
      queue: "mail",
      type: "email.send",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const queue = workerQueue({
      claim: async () => job,
      fail: async () => "scheduled",
    });
    const worker = new Worker(queue, {
      queue: "mail",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle("email.send", async () => {
      throw new Error("delivery failed");
    });

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "retry",
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 1,
      }),
    ]);
  });

  it("records a terminal handler failure", async () => {
    const { Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: "job-3",
      queue: "mail",
      type: "email.send",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 3,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: 3n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const queue = workerQueue({
      claim: async () => job,
      fail: async () => "failed",
    });
    const worker = new Worker(queue, {
      queue: "mail",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle("email.send", async () => {
      throw new Error("delivery failed");
    });

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "failed",
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 1,
      }),
    ]);
  });

  it("records a cooperatively canceled execution", async () => {
    const { CancellationRequestedError, Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: "job-4",
      queue: "mail",
      type: "email.send",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const queue = workerQueue({
      claim: async () => job,
      acknowledgeCancel: async () => true,
    });
    const worker = new Worker(queue, {
      queue: "mail",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle("email.send", async () => {
      throw new CancellationRequestedError(job.id);
    });

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "canceled",
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 1,
      }),
    ]);
  });

  it("records cancellation when it wins the execution-timeout race", async () => {
    const { Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: "job-timeout-cancel-race",
      queue: "mail",
      type: "email.send",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: 10,
      attemptTimeoutAt: new Date(),
      fenceToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const queue = workerQueue({
      claim: async () => job,
      expireOwned: async () => "cancel_requested",
      acknowledgeCancel: async () => true,
    });
    const worker = new Worker(queue, {
      queue: "mail",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle(
      "email.send",
      async (_payload, context) =>
        new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        }),
    );

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "canceled",
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 1,
      }),
    ]);
  });

  it("observes queue pressure and worker capacity from PostgreSQL", async () => {
    const { WorkhorseMetricsObserver } = await import("../src/metrics-observer.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>(text: string) => {
        if (text.includes("FROM workhorse.job_runtime")) {
          return queryResult([
            {
              queue_name: "mail",
              scheduled: "2",
              ready: "3",
              active: "1",
              oldest_ready_age_ms: 4_500,
              expired: "1",
              overdue_deadlines: "2",
              overdue_execution_timeouts: "1",
              paused: true,
            },
          ] as unknown as R[]);
        }
        if (text.includes("FROM workhorse.worker_registry")) {
          return queryResult([
            {
              queue_name: "mail",
              state: "running",
              workers: "2",
              capacity: "4",
              active_slots: "3",
            },
          ] as unknown as R[]);
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    };

    await new WorkhorseMetricsObserver(database).collect();
    await collect();

    expect(metric("workhorse.jobs.count")?.dataPoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: { "workhorse.job.state": "ready", "workhorse.queue.name": "mail" },
          value: 3,
        }),
        expect.objectContaining({
          attributes: { "workhorse.job.state": "active", "workhorse.queue.name": "mail" },
          value: 1,
        }),
      ]),
    );
    expect(metric("workhorse.queue.oldest_ready.age")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.queue.name": "mail" },
        value: 4.5,
      }),
    ]);
    expect(metric("workhorse.worker.capacity")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.queue.name": "mail", "workhorse.worker.state": "running" },
        value: 4,
      }),
    ]);
    expect(metric("workhorse.worker.active")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.queue.name": "mail", "workhorse.worker.state": "running" },
        value: 3,
      }),
    ]);
    expect(metric("workhorse.queue.paused")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.queue.name": "mail" },
        value: 1,
      }),
    ]);
    expect(metric("workhorse.lease.expired")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.queue.name": "mail" },
        value: 1,
      }),
    ]);
    expect(metric("workhorse.deadline.overdue")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.queue.name": "mail" },
        value: 2,
      }),
    ]);
    expect(metric("workhorse.execution_timeout.overdue")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.queue.name": "mail" },
        value: 1,
      }),
    ]);
  });

  it("runs the database observer on an explicit interval and stops cleanly", async () => {
    vi.useFakeTimers();
    let queries = 0;
    const database: Queryable = {
      query: async <R extends QueryResultRow>() => {
        queries += 1;
        return queryResult([] as R[]);
      },
    };
    const { WorkhorseMetricsObserver } = await import("../src/metrics-observer.js");
    const observer = new WorkhorseMetricsObserver(database, { intervalMs: 1_000 });

    observer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(queries).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queries).toBe(4);
    observer.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queries).toBe(4);
    vi.useRealTimers();
  });

  it("records SQL-owned maintenance work and duration", async () => {
    const { Worker } = await import("../src/worker.js");
    const queue = workerQueue({
      defaultQueue: "default",
      tick: async () => [
        {
          phase: "promote",
          rowsAffected: 5,
          durationMs: 12,
          skippedLock: false,
          error: null,
        },
      ],
      claim: async () => null,
    });
    const worker = new Worker(queue, {
      queue: "mail",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    });

    await worker.runOnce();
    await collect();

    const attributes = {
      "workhorse.maintenance.loop": "tick",
      "workhorse.maintenance.phase": "promote",
      "workhorse.maintenance.skipped_lock": false,
    };
    expect(metric("workhorse.maintenance.runs")?.dataPoints).toEqual([
      expect.objectContaining({ attributes, value: 1 }),
    ]);
    expect(metric("workhorse.maintenance.rows")?.dataPoints).toEqual([
      expect.objectContaining({ attributes, value: 5 }),
    ]);
    expect(metric("workhorse.maintenance.duration")?.dataPoints).toEqual([
      expect.objectContaining({ attributes }),
    ]);
  });

  it("counts leases recovered by a bounded recovery pass", async () => {
    const { Queue } = await import("../src/queue.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([{ rows_affected: 7, expired_leases: 7, retried: 7 }] as unknown as R[]),
    };

    await new Queue(database).recoverExpired();
    await collect();

    expect(metric("workhorse.leases.expired")?.dataPoints).toEqual([
      expect.objectContaining({ value: 7 }),
    ]);
  });

  it("counts cancellation requests by their durable result", async () => {
    const { Queue } = await import("../src/queue.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([
          {
            status: "cancel_requested",
            state: "active",
            current_attempt: 1,
            requested_at: new Date(),
            requested_by: "operator",
            reason: "deploy",
            finished_at: null,
          },
        ] as unknown as R[]),
    };

    await new Queue(database).cancel("job-1", { requestedBy: "operator", reason: "deploy" });
    await collect();

    expect(metric("workhorse.jobs.cancellation")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.cancellation.status": "cancel_requested" },
        value: 1,
      }),
    ]);
  });

  it("counts fired schedules and records their firing lag", async () => {
    const { Queue } = await import("../src/queue.js");
    let fireCalls = 0;
    const database: Queryable = {
      query: async <R extends QueryResultRow>() => {
        fireCalls += 1;
        return queryResult([{ job_id: fireCalls === 1 ? "job-1" : null }] as unknown as R[]);
      },
    };
    const queue = new Queue(database);
    const occurrence = new Date(Date.now() - 5_000);

    await queue.fireSchedule("billing", "daily-invoice", 1n, occurrence);
    await queue.fireSchedule("billing", "daily-invoice", 1n, occurrence);
    await collect();

    const attributes = {
      "workhorse.schedule.namespace": "billing",
      "workhorse.schedule.name": "daily-invoice",
    };
    expect(metric("workhorse.schedule.fired")?.dataPoints).toEqual([
      expect.objectContaining({ attributes, value: 1 }),
    ]);
    expect(metric("workhorse.schedule.lag")?.dataPoints).toEqual([
      expect.objectContaining({ attributes }),
    ]);
  });

  it("counts redrive requests by their durable result", async () => {
    const { Queue } = await import("../src/queue.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([
          {
            status: "redriven",
            source_job_id: "failed-job",
            target_job_id: "new-job",
            source_state: "failed",
            target_state: "ready",
            requested_at: new Date(),
          },
        ] as unknown as R[]),
    };

    await new Queue(database).redrive("failed-job", {
      requestedBy: "operator",
      reason: "fixed",
      requestId: "request-1",
    });
    await collect();

    expect(metric("workhorse.jobs.redrive")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.redrive.status": "redriven" },
        value: 1,
      }),
    ]);
  });

  it("counts every result from a bulk redrive page", async () => {
    const { Queue } = await import("../src/queue.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([
          {
            status: "redriven",
            source_job_id: "failed-1",
            target_job_id: "new-1",
            source_state: "failed",
            target_state: "ready",
            requested_at: new Date(),
            source_finished_at_cursor: new Date().toISOString(),
            has_more: false,
          },
          {
            status: "replayed",
            source_job_id: "failed-2",
            target_job_id: "new-2",
            source_state: "failed",
            target_state: "ready",
            requested_at: new Date(),
            source_finished_at_cursor: new Date().toISOString(),
            has_more: false,
          },
        ] as unknown as R[]),
    };

    await new Queue(database).redriveMany(
      {},
      { requestedBy: "operator", reason: "fixed", requestId: "request-2" },
    );
    await collect();

    expect(metric("workhorse.jobs.redrive")?.dataPoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: { "workhorse.redrive.status": "redriven" },
          value: 1,
        }),
        expect.objectContaining({
          attributes: { "workhorse.redrive.status": "replayed" },
          value: 1,
        }),
      ]),
    );
  });

  it("counts claimed jobs by queue and job type", async () => {
    const { Queue } = await import("../src/queue.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([
          {
            job_id: "job-1",
            job_type: "email.send",
            payload: null,
            attempt: 1,
            max_attempts: 3,
            retry_policy: null,
            deadline_at: null,
            execution_timeout_ms: null,
            attempt_timeout_at: null,
            fence_token: "1",
            lease_expires_at: new Date(Date.now() + 30_000),
          },
        ] as unknown as R[]),
    };

    await new Queue(database).claim("worker-1", { queue: "mail" });
    await collect();

    expect(metric("workhorse.jobs.claimed")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 1,
      }),
    ]);
  });

  it("counts non-accepted heartbeat outcomes", async () => {
    const { Queue } = await import("../src/queue.js");
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([{ status: "stale" }] as unknown as R[]),
    };
    const job: ClaimedJob = {
      id: "job-1",
      queue: "mail",
      type: "email.send",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };

    await new Queue(database).heartbeatStatus(job, "worker-1");
    await collect();

    expect(metric("workhorse.worker.heartbeat.failure")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: { "workhorse.heartbeat.status": "stale" },
        value: 1,
      }),
    ]);
  });

  it.each([
    ["deadline_exceeded", "deadline_exceeded"],
    ["timeout_exceeded", "timeout"],
    ["stale", "lease_lost"],
  ] as const)("records %s execution finalization as %s", async (databaseState, outcome) => {
    const { Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: `job-${databaseState}`,
      queue: "mail",
      type: "email.send",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const queue = workerQueue({
      claim: async () => job,
      fail: async () => databaseState,
    });
    const worker = new Worker(queue, {
      queue: "mail",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle("email.send", async () => {
      throw new Error("execution stopped");
    });

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": outcome,
          "workhorse.job.type": "email.send",
          "workhorse.queue.name": "mail",
        },
        value: 1,
      }),
    ]);
  });

  it("records durable wait suspension without treating it as a failure", async () => {
    const { Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: "job-wait",
      queue: "reports",
      type: "report.publish",
      priority: 0,
      payload: null,
      contractVersion: null,
      resultMaxBytes: 1_048_576,
      redactErrorDetails: false,
      traceContext: null,
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: null,
      deadlineAt: null,
      executionTimeoutMs: null,
      attemptTimeoutAt: null,
      fenceToken: 1n,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const queue = workerQueue({
      claim: async () => job,
      scheduleWait: async () => ({
        status: "scheduled",
        wait: {
          jobId: job.id,
          name: "publish",
          mode: "relative",
          durationMs: 1_000,
          requestedWakeAt: null,
          wakeAt: new Date(Date.now() + 1_000),
          attempt: 1,
          fenceToken: 1n,
          workerId: "worker-1",
          createdAt: new Date(),
        },
      }),
    });
    const worker = new Worker(queue, {
      queue: "reports",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    }).handle("report.publish", async (_payload, context) => {
      await context.sleep("publish", 1_000);
      return null;
    });

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "suspended",
          "workhorse.job.type": "report.publish",
          "workhorse.queue.name": "reports",
        },
        value: 1,
      }),
    ]);
  });

  it("records a missing handler as the failure PostgreSQL selected", async () => {
    const { Worker } = await import("../src/worker.js");
    const job: ClaimedJob = {
      id: "job-missing-handler",
      queue: "default",
      type: "unknown.job",
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
    const queue = workerQueue({
      claim: async () => job,
      fail: async () => "failed",
    });
    const worker = new Worker(queue, {
      queue: "default",
      registryIntervalMs: 0,
      statisticsRollupIntervalMs: 0,
    });

    await worker.runOnce();
    await collect();

    expect(metric("workhorse.handler.executions")?.dataPoints).toEqual([
      expect.objectContaining({
        attributes: {
          "workhorse.handler.outcome": "failed",
          "workhorse.job.type": "unknown.job",
          "workhorse.queue.name": "default",
        },
        value: 1,
      }),
    ]);
  });

  // ADR 0024: every instrument is created on first emission and re-created when the global meter
  // provider changes, so an SDK installed after the application imported Workhorse still receives
  // metrics. The eager module-scope lifecycle this replaced bound to the no-op provider forever.
  it("reaches a meter provider registered after the instrumentation module loaded", async () => {
    const { Queue } = await import("../src/queue.js");
    const lateExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
    const lateReader = new PeriodicExportingMetricReader({
      exporter: lateExporter,
      exportIntervalMillis: 60_000,
    });
    const lateProvider = new MeterProvider({ readers: [lateReader] });
    const database: Queryable = {
      query: async <R extends QueryResultRow>() =>
        queryResult([{ ordinal: 1, job_id: "job-late", outcome: "accepted" }] as unknown as R[]),
    };

    metrics.disable();
    metrics.setGlobalMeterProvider(lateProvider);
    try {
      await new Queue(database).enqueue("email.send", null, { queue: "mail" });
      await lateProvider.forceFlush();

      expect(
        lateExporter
          .getMetrics()
          .flatMap((resource) => resource.scopeMetrics)
          .flatMap((scope) => scope.metrics)
          .find((candidate) => candidate.descriptor.name === "workhorse.jobs.enqueued")?.dataPoints,
      ).toEqual([expect.objectContaining({ value: 1 })]);
    } finally {
      await lateProvider.shutdown();
      metrics.disable();
      metrics.setGlobalMeterProvider(provider);
    }
  });
});

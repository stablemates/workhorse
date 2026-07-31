import { setTimeout as sleep } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { installSchema } from "@workhorse/core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../../src/local-database.js";
import {
  createDemoApplication,
  createDemoDatabase,
  createLocalQueueController,
  createLocalOperator,
  createLocalScheduleController,
  DEMO_LONG_RUNNING_MS,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_WORKER_POLL_MS,
  DEMO_WORKERS,
  HEARTBEAT_SCHEDULE_NAME,
  installDemoSchema,
  REPORT_SCHEDULE_NAME,
  seedDemoData,
  syncDemoSchedules,
} from "../src/app.js";
import type { CreateDemoApplicationOptions } from "../src/app.js";
import type { DashboardRouter } from "../src/rpc.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const database = createDemoDatabase(pool);

function createTestApplication(options: CreateDemoApplicationOptions = {}) {
  return createDemoApplication(database, { workerPollMs: 15, longRunningJobMs: 25, ...options });
}

beforeAll(async () => {
  await installSchema(pool);
  await installDemoSchema(database);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE public.workhorse_demo_audit, public.workhorse_demo_seed, public.workhorse_demo_order, workhorse.job_event,
    workhorse.job_checkpoint, workhorse.attempt_history, workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.queue_control, workhorse.job_outcome, workhorse.job_runtime,
    workhorse.job RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_order");
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_seed");
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_audit");
  await pool.end();
});

function dashboardClient(
  app: ReturnType<typeof createDemoApplication>["app"],
): RouterClient<DashboardRouter> {
  return createORPCClient(
    new RPCLink({ url: "http://demo.test/rpc", fetch: (request) => app.request(request) }),
  );
}

describe("Workhorse demo", () => {
  it("uses a conservative worker polling interval for the demo", () => {
    expect(DEMO_WORKER_POLL_MS).toBe(15_000);
    expect(DEMO_LONG_RUNNING_MS).toBe(20_000);
  });

  it("synchronizes the always-on demo schedules at startup", async () => {
    await syncDemoSchedules(pool);

    expect(
      await pool.query(
        `SELECT schedule_name, cron_expression, enabled
           FROM workhorse.schedule_definition
          WHERE namespace = $1
          ORDER BY schedule_name`,
        [DEMO_SCHEDULE_NAMESPACE],
      ),
    ).toMatchObject({
      rows: [
        { schedule_name: REPORT_SCHEDULE_NAME, cron_expression: "*/5 * * * *", enabled: true },
        { schedule_name: HEARTBEAT_SCHEDULE_NAME, cron_expression: "* * * * *", enabled: true },
      ],
    });
  });

  it("seeds representative dashboard data exactly once", async () => {
    const { app } = createTestApplication();

    expect(await seedDemoData(database, app)).toMatchObject({
      seeded: true,
      jobIds: [expect.any(String), expect.any(String), expect.any(String), expect.any(String)],
      historicalJobCount: 362,
    });
    expect(await seedDemoData(database, app)).toEqual({
      seeded: false,
      jobIds: [],
      historicalJobCount: 0,
    });
    expect(
      await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_demo_order"),
    ).toMatchObject({ rows: [{ count: 1 }] });
    expect(await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).toMatchObject({
      rows: [{ count: 366 }],
    });
    expect(
      await pool.query(
        `SELECT payload, max_attempts, tags FROM workhorse.job
          WHERE job_type = 'demo.retry' AND payload->>'label' = 'recover-with-durable-checkpoint'`,
      ),
    ).toMatchObject({
      rows: [
        {
          payload: { label: "recover-with-durable-checkpoint", failUntilAttempt: 1 },
          max_attempts: 3,
          tags: ["demo-test", "durable-checkpoint"],
        },
      ],
    });
    const client = dashboardClient(app);
    await expect(client.dashboard.taskCounts()).resolves.toMatchObject({
      all: 366,
      scheduled: 1,
      queued: 3,
      completed: 346,
      discarded: 16,
      retried: 22,
    });
    const firstPage = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25 });
    const secondPage = await client.dashboard.tasks({ filter: "all", page: 2, pageSize: 25 });
    expect(firstPage).toMatchObject({
      filter: "all",
      page: 1,
      pageSize: 25,
      total: 366,
      counts: { all: 366, scheduled: 1, queued: 3, completed: 346, discarded: 16 },
    });
    expect(firstPage.jobs).toHaveLength(25);
    expect(firstPage).not.toHaveProperty("facets");
    await expect(client.dashboard.taskFacets()).resolves.toMatchObject({
      queues: ["demo", "emails", "orders"],
      workers: ["demo-worker-1", "demo-worker-2"],
      jobTypes: expect.arrayContaining(["demo.report", "order.process"]),
      tags: expect.arrayContaining(["billing", "email", "reports", "weekly"]),
    });
    expect(firstPage.jobs.some((job) => job.tags.length > 0)).toBe(true);
    expect(secondPage).toMatchObject({ filter: "all", page: 2, pageSize: 25, total: 366 });
    expect(secondPage.jobs).toHaveLength(25);
    expect(
      await client.dashboard.tasks({ filter: "scheduled", page: 1, pageSize: 25 }),
    ).toMatchObject({
      filter: "scheduled",
      total: 1,
      jobs: [{ state: "scheduled", payload: { source: "scheduled-seed" } }],
    });
    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 10 as 25 }),
    ).rejects.toThrow(/input validation/i);

    const tagFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 50,
      tags: ["weekly", "billing"],
    });
    expect(tagFiltered.total).toBeGreaterThan(0);
    expect(
      tagFiltered.jobs.every((job) => job.tags.some((tag) => ["weekly", "billing"].includes(tag))),
    ).toBe(true);

    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25, search: "report" }),
    ).resolves.toMatchObject({
      jobs: expect.arrayContaining([expect.objectContaining({ type: "demo.report" })]),
    });
    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25, search: "demo.r*ort" }),
    ).resolves.toMatchObject({
      jobs: expect.arrayContaining([expect.objectContaining({ type: "demo.report" })]),
    });
    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25, search: "no-such-task" }),
    ).resolves.toMatchObject({ total: 0, jobs: [] });

    const queueFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      queue: "emails",
    });
    expect(queueFiltered.jobs.every((job) => job.queue === "emails")).toBe(true);
    const workerFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      worker: "demo-worker-1",
    });
    expect(workerFiltered.jobs.every((job) => job.workerId === "demo-worker-1")).toBe(true);
    const typeFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      jobType: "email.send",
    });
    expect(typeFiltered.jobs.every((job) => job.type === "email.send")).toBe(true);
    const combined = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      queue: "emails",
      worker: "demo-worker-1",
      jobType: "email.send",
      tags: ["email"],
    });
    expect(combined.total).toBeGreaterThan(0);
    expect(
      combined.jobs.every(
        (job) =>
          job.queue === "emails" &&
          job.workerId === "demo-worker-1" &&
          job.type === "email.send" &&
          job.tags.includes("email"),
      ),
    ).toBe(true);
    expect(
      await pool.query(
        `SELECT runtime.state, job.payload, runtime.run_at > clock_timestamp() AS is_future
           FROM workhorse.job job
           JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
          WHERE job.payload->>'source' = 'scheduled-seed'`,
      ),
    ).toMatchObject({
      rows: [{ state: "scheduled", payload: { source: "scheduled-seed" }, is_future: true }],
    });

    const queueActivity = await client.dashboard.activity({
      filter: "all",
      period: "7d",
      groupBy: "queue",
    });
    expect(queueActivity.groups).toEqual(["demo", "emails", "orders"]);
    expect(
      queueActivity.buckets.filter((bucket) => Object.keys(bucket.counts).length > 0).length,
    ).toBeGreaterThan(6);
    const filteredActivity = await client.dashboard.activity({
      filter: "all",
      period: "7d",
      groupBy: "task",
      tags: ["email"],
      queue: "emails",
      worker: "demo-worker-1",
    });
    expect(filteredActivity.groups.every((group) => group.startsWith("email."))).toBe(true);
    await expect(
      client.dashboard.activity({ filter: "all", period: "7d", groupBy: "worker" }),
    ).resolves.toMatchObject({ groups: ["demo-worker-1", "demo-worker-2", "unassigned"] });
    await expect(
      client.dashboard.activity({ filter: "all", period: "7d", groupBy: "task" }),
    ).resolves.toMatchObject({
      groups: [
        "demo.failure",
        "demo.recurring",
        "demo.report",
        "demo.retry",
        "email.digest",
        "email.send",
        "order.process",
        "order.refund",
      ],
    });
    await expect(
      client.dashboard.activity({ filter: "all", period: "7d", groupBy: "status" }),
    ).resolves.toMatchObject({
      groupBy: "status",
      groups: ["failed", "ready", "scheduled", "succeeded"],
    });
  });

  it("creates an application row and job atomically, then processes and exposes both", async () => {
    const workerErrors: unknown[] = [];
    const refreshReasons: string[] = [];
    const { app, workhorse, dashboardRefresh } = createTestApplication({
      onWorkerError: (error) => workerErrors.push(error),
    });
    const unsubscribe = dashboardRefresh.subscribe((event) => refreshReasons.push(event.reason));
    workhorse.start();

    try {
      const rootResponse = await app.request("/");
      expect(rootResponse.status).toBe(302);
      expect(rootResponse.headers.get("location")).toBe("/tasks");
      expect(await (await app.request("/api")).json()).toMatchObject({
        name: "Workhorse demo",
      });
      const response = await app.request("/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerEmail: "operator@example.com",
          description: "Validate the end-to-end demo",
        }),
      });
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as { orderId: string; jobId: string };
      const transactionIds = await pool.query<{
        order_transaction: string;
        job_transaction: string;
      }>(
        `SELECT application_order.xmin::text AS order_transaction,
                accepted_job.xmin::text AS job_transaction
           FROM public.workhorse_demo_order application_order
           JOIN workhorse.job accepted_job ON accepted_job.id = $2
          WHERE application_order.id = $1`,
        [accepted.orderId, accepted.jobId],
      );
      expect(transactionIds.rows[0]!.order_transaction).toBe(
        transactionIds.rows[0]!.job_transaction,
      );

      let orderStatus = "queued";
      let job: { state: string; result: unknown } | undefined;
      for (let attempt = 0; attempt < 40 && job?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        const orderResponse = await app.request(`/orders/${accepted.orderId}`);
        const body = (await orderResponse.json()) as { order: { status: string } };
        orderStatus = body.order.status;
        const jobResponse = await app.request(`/jobs/${accepted.jobId}`);
        job = ((await jobResponse.json()) as { job: typeof job }).job;
      }

      expect(orderStatus).toBe("processed");
      const jobResponse = await app.request(`/jobs/${accepted.jobId}`);
      expect(jobResponse.status).toBe(200);
      expect(await jobResponse.json()).toMatchObject({
        job: { id: accepted.jobId, state: "succeeded", result: { processed: true } },
      });
      const client = dashboardClient(app);
      expect(await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25 })).toMatchObject({
        filter: "all",
        page: 1,
        total: 1,
        jobs: [
          {
            id: accepted.jobId,
            state: "succeeded",
            payload: { orderId: accepted.orderId },
            createdAt: expect.any(String),
          },
        ],
        counts: { all: 1, completed: 1 },
      });
      expect(await client.dashboard.workers()).toMatchObject({
        workers: [
          { id: "demo-worker-1", status: expect.stringMatching(/active|idle|recent|offline/) },
          { id: "demo-worker-2", status: expect.stringMatching(/active|idle|recent|offline/) },
        ],
      });
      expect(await client.dashboard.system({ window: "1h" })).toMatchObject({
        window: "1h",
        status: { level: "healthy", checks: [] },
        kpis: {
          drain: { completedPerMinute: expect.any(Number), enqueuedPerMinute: expect.any(Number) },
          backlog: { ready: 0 },
          errorRate: { current: 0 },
          lease: { expired: 0 },
        },
        outcomes: expect.any(Array),
        integrity: { dueButUnpromoted: 0, partitions: expect.any(Array) },
      });
      const detail = await client.dashboard.jobDetail({ id: accepted.jobId });
      expect(detail).toMatchObject({
        identity: { id: accepted.jobId, state: "succeeded" },
        payload: { orderId: accepted.orderId },
        current: { outcome: { state: "succeeded", result: { processed: true } } },
        attempts: [{ attempt: 1, outcome: "succeeded" }],
      });
      expect(detail.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "enqueued" })]),
      );
      expect(refreshReasons).toEqual(expect.arrayContaining(["enqueue", "worker"]));
      expect(workerErrors).toEqual([]);
    } finally {
      unsubscribe();
      await workhorse.stop();
    }
  });

  it("rejects malformed order requests without writing an order or job", async () => {
    const { app } = createTestApplication();
    const response = await app.request("/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerEmail: "invalid" }),
    });

    expect(response.status).toBe(400);
    expect(
      await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_demo_order"),
    ).toMatchObject({ rows: [{ count: 0 }] });
    expect(await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).toMatchObject({
      rows: [{ count: 0 }],
    });
  });

  it("retries an intentional handler failure and exposes both attempts in the dashboard", async () => {
    const { app, workhorse } = createTestApplication();
    workhorse.start();

    try {
      const response = await app.request("/demo/retries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ failUntilAttempt: 1 }),
      });
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as {
        jobId: string;
        expectedAttempts: number;
        expectedCheckpoint: string;
      };
      expect(accepted.expectedAttempts).toBe(2);
      expect(accepted.expectedCheckpoint).toBe("reserve-capacity");

      let job: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && job?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        const jobResponse = await app.request(`/jobs/${accepted.jobId}`);
        job = ((await jobResponse.json()) as { job: typeof job }).job;
      }

      expect(job).toMatchObject({
        state: "succeeded",
        currentAttempt: 2,
        result: {
          recovered: true,
          attempt: 2,
          checkpointReused: true,
          reservation: {
            reservationId: expect.any(String),
            reservedAt: expect.any(String),
            reservedOnAttempt: 1,
          },
        },
      });
      expect(
        (
          await pool.query(
            `SELECT checkpoint_name, checkpoint_value, attempt, fence_token::text, worker_id
               FROM workhorse.job_checkpoint WHERE job_id = $1`,
            [accepted.jobId],
          )
        ).rows,
      ).toEqual([
        {
          checkpoint_name: "reserve-capacity",
          checkpoint_value: {
            reservationId: expect.any(String),
            reservedAt: expect.any(String),
            reservedOnAttempt: 1,
          },
          attempt: 1,
          fence_token: expect.any(String),
          worker_id: expect.stringMatching(/^demo-worker-/),
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT attempt, outcome FROM workhorse.attempt_history WHERE job_id = $1 ORDER BY attempt",
            [accepted.jobId],
          )
        ).rows,
      ).toEqual([
        { attempt: 1, outcome: "retry" },
        { attempt: 2, outcome: "succeeded" },
      ]);

      const client = dashboardClient(app);
      expect(
        await client.dashboard.tasks({ filter: "retried", page: 1, pageSize: 25 }),
      ).toMatchObject({
        filter: "retried",
        total: 1,
        jobs: [{ id: accepted.jobId, state: "succeeded", attempt: 2 }],
        counts: { all: 1, retried: 1, completed: 1 },
      });
      expect(await client.dashboard.workers()).toMatchObject({
        workers: [{ id: "demo-worker-1" }, { id: "demo-worker-2" }],
      });
      expect(await client.dashboard.system({ window: "1h" })).toMatchObject({
        window: "1h",
        kpis: { retry: { backoff: 0 }, errorRate: { current: expect.any(Number) } },
      });
      expect(await client.dashboard.jobDetail({ id: accepted.jobId })).toMatchObject({
        identity: { id: accepted.jobId, state: "succeeded" },
        checkpoints: [
          {
            name: "reserve-capacity",
            attempt: 1,
            fenceToken: expect.any(String),
            workerId: expect.stringMatching(/^demo-worker-/),
            value: { reservedOnAttempt: 1 },
          },
        ],
        attempts: [
          { attempt: 1, outcome: "retry" },
          { attempt: 2, outcome: "succeeded" },
        ],
        events: expect.arrayContaining([
          expect.objectContaining({
            attempt: 1,
            type: "checkpoint_saved",
            details: expect.objectContaining({ name: "reserve-capacity" }),
          }),
        ]),
      });
      expect(
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.job_event
            WHERE job_id = $1 AND event_type = 'checkpoint_saved'`,
          [accepted.jobId],
        ),
      ).toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await workhorse.stop();
    }
  });

  it("records an intentional terminal failure and exposes it in the dashboard", async () => {
    const { app, workhorse } = createTestApplication();
    workhorse.start();

    try {
      const response = await app.request("/demo/failures", { method: "POST" });
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as { jobId: string; expectedOutcome: string };
      expect(accepted.expectedOutcome).toBe("failed");

      let state: string | undefined;
      for (let attempt = 0; attempt < 40 && state !== "failed"; attempt += 1) {
        await sleep(25);
        const jobResponse = await app.request(`/jobs/${accepted.jobId}`);
        state = ((await jobResponse.json()) as { job: { state: string } }).job.state;
      }
      expect(state).toBe("failed");

      const client = dashboardClient(app);
      expect(
        await client.dashboard.tasks({ filter: "discarded", page: 1, pageSize: 25 }),
      ).toMatchObject({
        filter: "discarded",
        total: 1,
        jobs: [{ id: accepted.jobId, type: "demo.failure", state: "failed" }],
        counts: { all: 1, discarded: 1 },
      });
      expect(await client.dashboard.system({ window: "1h" })).toMatchObject({
        status: { level: "healthy", checks: [] },
        failingTypes: [
          expect.objectContaining({
            queue: "demo",
            type: "demo.failure",
            attempts: 1,
            terminalFailures: 1,
          }),
        ],
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("fires a recurring definition and exposes its occurrence and job in the dashboard", async () => {
    await syncDemoSchedules(pool);
    const { app, workhorse } = createTestApplication();
    workhorse.start();

    try {
      let jobId: string | undefined;
      let state: string | undefined;
      for (let attempt = 0; attempt < 40 && state !== "succeeded"; attempt += 1) {
        await sleep(25);
        const occurrence = await pool.query<{ job_id: string | null }>(
          `SELECT job_id FROM workhorse.schedule_occurrence
            WHERE namespace = $1 AND schedule_name = $2
            ORDER BY occurrence_at DESC LIMIT 1`,
          [DEMO_SCHEDULE_NAMESPACE, HEARTBEAT_SCHEDULE_NAME],
        );
        jobId = occurrence.rows[0]?.job_id ?? undefined;
        state = jobId ? (await workhorse.context.queue.getJob(jobId))?.state : undefined;
      }
      expect(jobId).toBeDefined();
      expect(state).toBe("succeeded");

      const client = dashboardClient(app);
      const cron = await client.dashboard.cron();
      expect(cron.schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            namespace: DEMO_SCHEDULE_NAMESPACE,
            name: HEARTBEAT_SCHEDULE_NAME,
            occurrenceCount: 1,
          }),
        ]),
      );
      expect(
        await client.dashboard.tasks({ filter: "completed", page: 1, pageSize: 25 }),
      ).toMatchObject({
        total: 2,
        jobs: expect.arrayContaining([
          expect.objectContaining({ id: jobId, type: "demo.recurring", state: "succeeded" }),
          expect.objectContaining({ type: "demo.report", state: "succeeded" }),
        ]),
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("keeps default dashboard operator read-only", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);

    await expect(
      client.dashboard.enqueueTest({
        kind: "success",
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-enqueue" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.setScheduleEnabled({
        kind: "user",
        namespace: DEMO_SCHEDULE_NAMESPACE,
        name: HEARTBEAT_SCHEDULE_NAME,
        enabled: false,
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-toggle" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.setQueuePaused({
        queue: "default",
        paused: true,
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-queue" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.purgeQueue({
        queue: "default",
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-purge" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    await expect(
      client.dashboard.setWorkerPaused({
        workerId: DEMO_WORKERS[0],
        paused: true,
        audit: { actor: "test", reason: "verify read-only", requestId: "readonly-worker" },
      }),
    ).rejects.toThrow(/read-only|FORBIDDEN/i);
    expect(
      await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_demo_audit"),
    ).toMatchObject({
      rows: [{ count: 0 }],
    });
  });

  it("keeps a long-running test job active for the configured duration", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningJobMs: 250,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: {
          actor: "operator",
          reason: "observe active work",
          requestId: "audit-long-running",
        },
      });

      let observedRunning = false;
      for (let attempt = 0; attempt < 40 && !observedRunning; attempt += 1) {
        await sleep(10);
        observedRunning = (
          await client.dashboard.tasks({ filter: "running", page: 1, pageSize: 25 })
        ).jobs.some((job) => job.id === enqueued.jobId);
      }
      expect(observedRunning).toBe(true);

      let detail = await client.dashboard.jobDetail({ id: enqueued.jobId });
      for (let attempt = 0; attempt < 40 && detail.identity.state !== "succeeded"; attempt += 1) {
        await sleep(10);
        detail = await client.dashboard.jobDetail({ id: enqueued.jobId });
      }
      expect(detail).toMatchObject({
        identity: { id: enqueued.jobId, type: "demo.long-running", state: "succeeded" },
        current: { outcome: { result: { completed: true, durationMs: 250 } } },
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("enqueues a deterministic checkpoint retry from the dashboard operator", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);

    const enqueued = await client.dashboard.enqueueTest({
      kind: "retry",
      audit: {
        actor: "operator",
        reason: "show durable checkpoint reuse",
        requestId: "audit-checkpoint-retry",
      },
    });

    expect(await client.dashboard.jobDetail({ id: enqueued.jobId })).toMatchObject({
      identity: { id: enqueued.jobId, type: "demo.retry", state: "ready" },
      payload: { label: "operator-retry", failUntilAttempt: 1 },
      checkpoints: [],
    });
    expect(
      await pool.query("SELECT max_attempts, tags FROM workhorse.job WHERE id = $1", [
        enqueued.jobId,
      ]),
    ).toMatchObject({
      rows: [{ max_attempts: 3, tags: ["demo-test", "durable-checkpoint"] }],
    });
  });

  it("supports audited local enqueue and schedule toggles", async () => {
    await syncDemoSchedules(pool);
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      scheduleController: createLocalScheduleController(database),
    });
    const client = dashboardClient(app);

    const enqueued = await client.dashboard.enqueueTest({
      kind: "success",
      audit: { actor: "operator", reason: "smoke enqueue", requestId: "audit-enqueue" },
    });
    expect(enqueued.jobId).toEqual(expect.any(String));
    expect(await client.dashboard.jobDetail({ id: enqueued.jobId })).toMatchObject({
      identity: { id: enqueued.jobId, state: "ready" },
      payload: { source: "operator" },
    });
    expect(
      await client.dashboard.setScheduleEnabled({
        kind: "user",
        namespace: DEMO_SCHEDULE_NAMESPACE,
        name: REPORT_SCHEDULE_NAME,
        enabled: false,
        audit: { actor: "operator", reason: "pause reports", requestId: "audit-toggle" },
      }),
    ).toEqual({ enabled: false });
    await syncDemoSchedules(pool);
    expect(
      await pool.query(
        `SELECT enabled FROM workhorse.schedule_definition
          WHERE namespace = $1 AND schedule_name = $2`,
        [DEMO_SCHEDULE_NAMESPACE, REPORT_SCHEDULE_NAME],
      ),
    ).toMatchObject({ rows: [{ enabled: false }] });
    expect(
      (
        await pool.query(
          `SELECT action, target, actor, reason, request_id, before, after, status
             FROM public.workhorse_demo_audit ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      {
        action: "enqueueTest",
        target: "job:success",
        actor: "operator",
        reason: "smoke enqueue",
        request_id: "audit-enqueue",
        before: null,
        after: expect.objectContaining({ jobId: enqueued.jobId }),
        status: "succeeded",
      },
      {
        action: "setScheduleEnabled",
        target: `schedule:${DEMO_SCHEDULE_NAMESPACE}:${REPORT_SCHEDULE_NAME}`,
        actor: "operator",
        reason: "pause reports",
        request_id: "audit-toggle",
        before: { enabled: true },
        after: { enabled: false },
        status: "succeeded",
      },
    ]);
  });

  it("pauses a local worker through RPC and audits the in-memory state change", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      await expect(client.dashboard.workers()).resolves.toMatchObject({
        canManageWorkers: true,
        workers: expect.arrayContaining([
          expect.objectContaining({ id: DEMO_WORKERS[0], paused: false, status: "idle" }),
        ]),
      });
      await expect(
        client.dashboard.setWorkerPaused({
          workerId: DEMO_WORKERS[0],
          paused: true,
          audit: {
            actor: "operator",
            reason: "pause one demo worker",
            requestId: "worker-pause",
          },
        }),
      ).resolves.toEqual({ paused: true });

      await expect(client.dashboard.workers()).resolves.toMatchObject({
        workers: expect.arrayContaining([
          expect.objectContaining({ id: DEMO_WORKERS[0], paused: true, status: "idle" }),
        ]),
      });
      expect(
        (
          await pool.query(
            `SELECT action, target, actor, reason, request_id, before, after, status
               FROM public.workhorse_demo_audit ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        {
          action: "setWorkerPaused",
          target: `worker:${DEMO_WORKERS[0]}`,
          actor: "operator",
          reason: "pause one demo worker",
          request_id: "worker-pause",
          before: { paused: false },
          after: { paused: true },
          status: "succeeded",
        },
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("reads queue stats and audits pause, resume, and safe purge mutations", async () => {
    const queueName = "managed-demo";
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      queueController: createLocalQueueController(database),
    });
    const client = dashboardClient(app);
    const activeId = await workhorse.context.queue.enqueue("active", {}, { queue: queueName });
    expect((await workhorse.context.queue.claim("demo-worker", { queue: queueName }))?.id).toBe(
      activeId,
    );
    await workhorse.context.queue.enqueue("ready", {}, { queue: queueName });
    await workhorse.context.queue.enqueue(
      "scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
      },
    );

    await expect(client.dashboard.queues()).resolves.toMatchObject({
      queues: [
        {
          queue: queueName,
          paused: false,
          scheduled: 1,
          ready: 1,
          active: 1,
          succeeded: 0,
          failed: 0,
          terminalCountsApproximate: false,
        },
      ],
    });
    await expect(
      client.dashboard.setQueuePaused({
        queue: queueName,
        paused: true,
        audit: { actor: "operator", reason: "pause queue", requestId: "queue-pause" },
      }),
    ).resolves.toEqual({ paused: true });
    await expect(
      workhorse.context.queue.claim("paused-worker", { queue: queueName }),
    ).resolves.toBeNull();
    await expect(
      client.dashboard.setQueuePaused({
        queue: queueName,
        paused: false,
        audit: { actor: "operator", reason: "resume queue", requestId: "queue-resume" },
      }),
    ).resolves.toEqual({ paused: false });
    await expect(
      client.dashboard.purgeQueue({
        queue: queueName,
        audit: { actor: "operator", reason: "clear queue", requestId: "queue-purge" },
      }),
    ).resolves.toEqual({ deletedCount: 2 });
    await expect(workhorse.context.queue.getJob(activeId)).resolves.toMatchObject({
      state: "active",
    });

    expect(
      (
        await pool.query(
          `SELECT action, target, actor, reason, request_id, before, after, status
             FROM public.workhorse_demo_audit ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      {
        action: "setQueuePaused",
        target: `queue:${queueName}`,
        actor: "operator",
        reason: "pause queue",
        request_id: "queue-pause",
        before: { paused: false },
        after: { paused: true },
        status: "succeeded",
      },
      {
        action: "setQueuePaused",
        target: `queue:${queueName}`,
        actor: "operator",
        reason: "resume queue",
        request_id: "queue-resume",
        before: { paused: true },
        after: { paused: false },
        status: "succeeded",
      },
      {
        action: "purgeQueue",
        target: `queue:${queueName}`,
        actor: "operator",
        reason: "clear queue",
        request_id: "queue-purge",
        before: { purgeable_jobs: 2 },
        after: { deletedCount: 2 },
        status: "succeeded",
      },
    ]);
  });

  it("reconciles local schedule toggles with worker-owned schedule definitions", async () => {
    await syncDemoSchedules(pool);
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      scheduleController: createLocalScheduleController(database),
    });
    const client = dashboardClient(app);

    const cron = await client.dashboard.cron();
    expect(cron.schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          name: "tick",
          type: "workhorse.tick_v1",
          maintenance: { intervalMs: 1_000, phases: ["promote", "recover"] },
        }),
        expect.objectContaining({
          kind: "system",
          name: "housekeeping",
          type: "workhorse.housekeep_v1",
          maintenance: {
            intervalMs: 60_000,
            phases: ["history_partitions", "schedule_occurrences"],
          },
        }),
        expect.objectContaining({
          kind: "user",
          identity: {
            kind: "user",
            namespace: DEMO_SCHEDULE_NAMESPACE,
            name: HEARTBEAT_SCHEDULE_NAME,
          },
          name: HEARTBEAT_SCHEDULE_NAME,
          active: true,
        }),
      ]),
    );

    await client.dashboard.setScheduleEnabled({
      kind: "user",
      namespace: DEMO_SCHEDULE_NAMESPACE,
      name: HEARTBEAT_SCHEDULE_NAME,
      enabled: false,
      audit: { actor: "operator", reason: "pause schedule", requestId: "schedule-disable" },
    });
    expect((await client.dashboard.cron()).schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: HEARTBEAT_SCHEDULE_NAME,
          enabled: false,
          active: false,
        }),
      ]),
    );

    await client.dashboard.setScheduleEnabled({
      kind: "user",
      namespace: DEMO_SCHEDULE_NAMESPACE,
      name: HEARTBEAT_SCHEDULE_NAME,
      enabled: true,
      audit: { actor: "operator", reason: "resume schedule", requestId: "schedule-enable" },
    });
    expect((await client.dashboard.cron()).schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: HEARTBEAT_SCHEDULE_NAME,
          enabled: true,
          active: true,
        }),
      ]),
    );
  });

  it("runs core Hono and worker flows without mounting dashboard routes", async () => {
    const { app, workhorse } = createTestApplication({ dashboard: false });
    workhorse.start();

    try {
      expect(await (await app.request("/")).json()).toMatchObject({
        name: "Workhorse demo",
      });
      expect((await app.request("/rpc/dashboard/tasks")).status).toBe(404);
      expect((await app.request("/dashboard/events")).status).toBe(404);
      const response = await app.request("/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerEmail: "headless@example.com",
          description: "Run without the optional dashboard",
        }),
      });
      expect(response.status).toBe(202);
    } finally {
      await workhorse.stop();
    }
  });
});

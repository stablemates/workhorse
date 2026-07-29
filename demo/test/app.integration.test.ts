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
    workhorse.attempt_history, workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.job_outcome, workhorse.job_runtime, workhorse.job RESTART IDENTITY CASCADE`);
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
    const client = dashboardClient(app);
    await expect(client.dashboard.taskCounts()).resolves.toMatchObject({
      all: 366,
      scheduled: 1,
      queued: 3,
      completed: 346,
      discarded: 16,
      retried: 22,
    });
    const firstPage = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 2 });
    const secondPage = await client.dashboard.tasks({ filter: "all", page: 2, pageSize: 2 });
    expect(firstPage).toMatchObject({
      filter: "all",
      page: 1,
      pageSize: 2,
      total: 366,
      counts: { all: 366, scheduled: 1, queued: 3, completed: 346, discarded: 16 },
    });
    expect(firstPage.jobs).toHaveLength(2);
    expect(secondPage).toMatchObject({ filter: "all", page: 2, pageSize: 2, total: 366 });
    expect(secondPage.jobs).toHaveLength(2);
    expect(
      await client.dashboard.tasks({ filter: "scheduled", page: 1, pageSize: 10 }),
    ).toMatchObject({
      filter: "scheduled",
      total: 1,
      jobs: [{ state: "scheduled", payload: { source: "scheduled-seed" } }],
    });
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
      expect(await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 10 })).toMatchObject({
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
      expect(await client.dashboard.system()).toMatchObject({
        failures: [],
        health: { schemaVersion: 3, counts: { succeeded: 1 } },
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
      const accepted = (await response.json()) as { jobId: string; expectedAttempts: number };
      expect(accepted.expectedAttempts).toBe(2);

      let job: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && job?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        const jobResponse = await app.request(`/jobs/${accepted.jobId}`);
        job = ((await jobResponse.json()) as { job: typeof job }).job;
      }

      expect(job).toMatchObject({
        state: "succeeded",
        currentAttempt: 2,
        result: { recovered: true, attempt: 2 },
      });
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
        await client.dashboard.tasks({ filter: "retried", page: 1, pageSize: 10 }),
      ).toMatchObject({
        filter: "retried",
        total: 1,
        jobs: [{ id: accepted.jobId, state: "succeeded", attempt: 2 }],
        counts: { all: 1, retried: 1, completed: 1 },
      });
      expect(await client.dashboard.workers()).toMatchObject({
        workers: [{ id: "demo-worker-1" }, { id: "demo-worker-2" }],
      });
      expect(await client.dashboard.system()).toMatchObject({
        failures: [],
      });
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
        await client.dashboard.tasks({ filter: "discarded", page: 1, pageSize: 10 }),
      ).toMatchObject({
        filter: "discarded",
        total: 1,
        jobs: [{ id: accepted.jobId, type: "demo.failure", state: "failed" }],
        counts: { all: 1, discarded: 1 },
      });
      expect(await client.dashboard.system()).toMatchObject({
        failures: [{ id: accepted.jobId, type: "demo.failure", attempt: 1 }],
        health: { counts: { failed: 1 } },
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
        await client.dashboard.tasks({ filter: "completed", page: 1, pageSize: 10 }),
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
          await client.dashboard.tasks({ filter: "running", page: 1, pageSize: 10 })
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

import { setTimeout as sleep } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { installSchema, Queue } from "@workhorse/core";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../../src/local-database.js";
import {
  createDemoApplication,
  createDemoDatabase,
  createLocalQueueController,
  createLocalOperator,
  createLocalScheduleController,
  DEMO_IDEMPOTENCY_TTL_MS,
  DEMO_OPERATOR_IDEMPOTENCY_KEY,
  DEMO_OPERATOR_IDEMPOTENCY_SCOPE,
  DEMO_SEED_IDEMPOTENCY_KEY,
  DEMO_SEED_IDEMPOTENCY_SCOPE,
  DEMO_DURABLE_STEP_MS,
  DEMO_DURABLE_TIMER_WAIT_MS,
  DEMO_LONG_RUNNING_MS,
  DEMO_PERSISTENT_RETRY_DELAYS_MS,
  DEMO_PERSISTENT_RETRY_POLICIES,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_WORKER_POLL_MS,
  DEMO_WORKERS,
  deterministicOrderId,
  DURABLE_TIMER_JOB_TYPE,
  DURABLE_TIMER_PREPARE_CHECKPOINT,
  DURABLE_TIMER_PUBLISH_CHECKPOINT,
  DURABLE_TIMER_WAIT_NAME,
  HEARTBEAT_SCHEDULE_NAME,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_SCOPE_HEADER,
  installDemoSchema,
  MAX_DEMO_IDEMPOTENCY_KEY_BYTES,
  REPORT_SCHEDULE_NAME,
  seedDemoData,
  syncDemoSchedules,
} from "../src/app.js";
import type { CreateDemoApplicationOptions } from "../src/app.js";
import type { DashboardRouter } from "../src/rpc.js";
import {
  describeIdempotency,
  idempotencyEvidenceLine,
  readDashboardSnapshot,
  readIdempotencyEvidence,
} from "../src/dashboard.js";

const databaseUrl = localDatabaseUrl("test");
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const database = createDemoDatabase(pool);

function createTestApplication(options: CreateDemoApplicationOptions = {}) {
  return createDemoApplication(database, {
    workerPollMs: 15,
    longRunningJobMs: 25,
    durableStepMs: 0,
    ...options,
  });
}

beforeAll(async () => {
  await installSchema(pool);
  await installDemoSchema(database);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE public.workhorse_demo_audit, public.workhorse_demo_seed, public.workhorse_demo_order, workhorse.job_event,
    workhorse.job_wait, workhorse.job_checkpoint, workhorse.attempt_history, workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.queue_control, workhorse.enqueue_idempotency, workhorse.job_outcome, workhorse.job_runtime,
    workhorse.job RESTART IDENTITY CASCADE`);
  await new Queue(pool).syncRetentionPolicy({
    jobIdentityRetentionDays: null,
    terminalOutcomeRetentionDays: null,
    jobEventRetentionDays: null,
    attemptHistoryRetentionDays: null,
    scheduleOccurrenceRetentionDays: 30,
    terminalJobPruneLimit: 1_000,
    historyPartitionsPerPass: 4,
    defaultPartitionRowsPerPass: 10_000,
    occurrenceRowsPerPass: 10_000,
  });
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_order");
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_seed");
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_audit");
  await pool.end();
});

async function postOrder(
  app: ReturnType<typeof createDemoApplication>["app"],
  body: { customerEmail: string; description: string },
  idempotency?: { key: string; scope?: string },
) {
  return app.request("/orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotency ? { [IDEMPOTENCY_KEY_HEADER]: idempotency.key } : {}),
      ...(idempotency?.scope ? { [IDEMPOTENCY_SCOPE_HEADER]: idempotency.scope } : {}),
    },
    body: JSON.stringify(body),
  });
}

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
    expect(DEMO_DURABLE_STEP_MS).toBe(2_000);
    expect(DEMO_DURABLE_TIMER_WAIT_MS).toBe(10_000);
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

    const seeded = await seedDemoData(database);
    expect(seeded).toMatchObject({
      seeded: true,
      jobIds: [
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(String),
      ],
      historicalJobCount: 362,
    });
    expect(await seedDemoData(database)).toEqual({
      seeded: false,
      jobIds: [],
      historicalJobCount: 0,
    });
    expect(
      await pool.query(
        `SELECT array_agg(DISTINCT version ORDER BY version) AS versions
           FROM (
             SELECT xmin::text AS version FROM workhorse.job WHERE id = ANY($1::uuid[])
             UNION ALL SELECT xmin::text FROM public.workhorse_demo_order
            UNION ALL SELECT xmin::text FROM public.workhorse_demo_seed
               WHERE name = 'default-dashboard-v7'
           ) representative_rows`,
        [seeded.jobIds],
      ),
    ).toMatchObject({ rows: [{ versions: [expect.any(String)] }] });
    expect(
      await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_demo_order"),
    ).toMatchObject({ rows: [{ count: 1 }] });
    expect(await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).toMatchObject({
      rows: [{ count: 374 }],
    });
    expect(
      await pool.query(
        `SELECT payload, max_attempts, tags FROM workhorse.job
          WHERE job_type = $1 AND payload->>'source' = 'representative-seed'`,
        [DURABLE_TIMER_JOB_TYPE],
      ),
    ).toMatchObject({
      rows: [
        {
          payload: { source: "representative-seed" },
          max_attempts: 1,
          tags: ["demo-test", "durable-checkpoint", "durable-timer"],
        },
      ],
    });
    expect(
      await pool.query(
        `SELECT payload, max_attempts, retry_policy, tags FROM workhorse.job
          WHERE job_type = 'demo.retry' AND payload->>'label' = 'recover-with-durable-checkpoint'`,
      ),
    ).toMatchObject({
      rows: [
        {
          payload: { label: "recover-with-durable-checkpoint", failUntilAttempt: 1 },
          max_attempts: 3,
          retry_policy: { type: "fixed", delayMs: 100 },
          tags: ["demo-test", "durable-checkpoint"],
        },
      ],
    });
    expect(
      await pool.query(
        `SELECT payload, max_attempts, tags FROM workhorse.job
          WHERE job_type = 'demo.durable-pipeline'
            AND payload->>'failureMode' IS NULL
          ORDER BY payload->>'scenario'`,
      ),
    ).toMatchObject({
      rows: [
        {
          payload: { scenario: "customer-onboarding" },
          max_attempts: 2,
          tags: ["demo-test", "durable-checkpoint", "customer-onboarding"],
        },
        {
          payload: { scenario: "order-fulfillment" },
          max_attempts: 2,
          tags: ["demo-test", "durable-checkpoint", "order-fulfillment"],
        },
        {
          payload: { scenario: "report-publication" },
          max_attempts: 2,
          tags: ["demo-test", "durable-checkpoint", "report-publication"],
        },
      ],
    });
    expect(
      await pool.query(
        `SELECT payload, max_attempts, retry_policy, tags FROM workhorse.job
          WHERE job_type = 'demo.durable-pipeline'
            AND payload->>'failureMode' = 'continuous'
          ORDER BY CASE payload->>'scenario'
            WHEN 'order-fulfillment' THEN 1
            WHEN 'customer-onboarding' THEN 2
            ELSE 3
          END`,
      ),
    ).toMatchObject({
      rows: [
        {
          payload: {
            scenario: "order-fulfillment",
            failureMode: "continuous",
            source: "persistent-failure-seed",
          },
          max_attempts: 25,
          retry_policy: DEMO_PERSISTENT_RETRY_POLICIES[0],
          tags: [
            "demo-test",
            "durable-checkpoint",
            "intentionally-failing",
            "order-fulfillment",
            "retry-5m",
          ],
        },
        {
          payload: {
            scenario: "customer-onboarding",
            failureMode: "continuous",
            source: "persistent-failure-seed",
          },
          max_attempts: 25,
          retry_policy: DEMO_PERSISTENT_RETRY_POLICIES[1],
          tags: [
            "demo-test",
            "durable-checkpoint",
            "intentionally-failing",
            "customer-onboarding",
            "retry-7m",
          ],
        },
        {
          payload: {
            scenario: "report-publication",
            failureMode: "continuous",
            source: "persistent-failure-seed",
          },
          max_attempts: 25,
          retry_policy: DEMO_PERSISTENT_RETRY_POLICIES[2],
          tags: [
            "demo-test",
            "durable-checkpoint",
            "intentionally-failing",
            "report-publication",
            "retry-10m",
          ],
        },
      ],
    });
    const client = dashboardClient(app);
    await expect(client.dashboard.taskCounts()).resolves.toMatchObject({
      all: 374,
      scheduled: 1,
      queued: 11,
      completed: 346,
      discarded: 16,
      retried: 22,
    });
    // Seeds must never manufacture a retention problem: startup stays healthy and deterministic.
    await expect(client.dashboard.system({ window: "1h" })).resolves.toMatchObject({
      status: { level: "healthy", checks: [], criticalChecks: [], degradedChecks: [] },
      integrity: {
        retention: {
          maxLagMs: null,
          maxLagCategory: null,
          eligibleHistoryPartitions: { jobEvents: 0, attemptHistory: 0 },
          defaultHistoryRows: { jobEvents: 0, attemptHistory: 0 },
          defaultHistoryRowsCapped: { jobEvents: false, attemptHistory: false },
        },
      },
    });
    const firstPage = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25 });
    const secondPage = await client.dashboard.tasks({ filter: "all", page: 2, pageSize: 25 });
    expect(firstPage).toMatchObject({
      filter: "all",
      page: 1,
      pageSize: 25,
      total: 374,
      counts: { all: 374, scheduled: 1, queued: 11, completed: 346, discarded: 16 },
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
    expect(secondPage).toMatchObject({ filter: "all", page: 2, pageSize: 25, total: 374 });
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
    expect(workerFiltered.jobs.every((job) => job.lastWorkerId === "demo-worker-1")).toBe(true);
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
          job.lastWorkerId === "demo-worker-1" &&
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
        "demo.durable-pipeline",
        "demo.durable-timer",
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

  it("keeps seeded durable failures retrying in visible five-to-ten-minute windows", async () => {
    const workerErrors: unknown[] = [];
    const { app, workhorse } = createTestApplication({
      durableTimerWaitMs: 1,
      onWorkerError: (error) => workerErrors.push(error),
    });
    await seedDemoData(database);
    workhorse.start();

    type PersistentFailureRow = {
      scenario: string;
      retry_delay_ms: number;
      state: string;
      current_attempt: number;
      max_attempts: number;
      retry_policy: unknown;
      selected_delay_ms: number;
      remaining_ms: number;
      checkpoint_count: number;
      error_message: string;
    };
    let rows: PersistentFailureRow[] = [];
    try {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        await sleep(25);
        rows = (
          await pool.query<PersistentFailureRow>(`
            SELECT job.payload->>'scenario' AS scenario,
                   CASE job.payload->>'scenario'
                     WHEN 'order-fulfillment' THEN ${DEMO_PERSISTENT_RETRY_DELAYS_MS[0]}
                     WHEN 'customer-onboarding' THEN ${DEMO_PERSISTENT_RETRY_DELAYS_MS[1]}
                     ELSE ${DEMO_PERSISTENT_RETRY_DELAYS_MS[2]}
                   END AS retry_delay_ms,
                   job.retry_policy,
                   (SELECT (event.details->>'retry_delay_ms')::integer
                      FROM workhorse.job_event event
                     WHERE event.job_id = job.id AND event.event_type = 'retry_scheduled'
                     ORDER BY event.event_id DESC LIMIT 1) AS selected_delay_ms,
                   runtime.state, runtime.current_attempt, job.max_attempts,
                   floor(extract(epoch FROM (runtime.run_at - clock_timestamp())) * 1000)::integer
                     AS remaining_ms,
                   (SELECT count(*)::integer FROM workhorse.job_checkpoint checkpoint
                     WHERE checkpoint.job_id = job.id) AS checkpoint_count,
                   runtime.error->>'message' AS error_message
              FROM workhorse.job job
              JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
             WHERE job.payload->>'source' = 'persistent-failure-seed'
             ORDER BY CASE job.payload->>'scenario'
               WHEN 'order-fulfillment' THEN 1
               WHEN 'customer-onboarding' THEN 2
               ELSE 3
             END
          `)
        ).rows;
        if (rows.length === 3 && rows.every((row) => row.state === "scheduled")) break;
      }

      expect(rows).toHaveLength(3);
      for (const [index, row] of rows.entries()) {
        const configuredDelay = DEMO_PERSISTENT_RETRY_DELAYS_MS[index]!;
        expect(row).toMatchObject({
          retry_delay_ms: configuredDelay,
          retry_policy: DEMO_PERSISTENT_RETRY_POLICIES[index],
          selected_delay_ms: configuredDelay,
          state: "scheduled",
          current_attempt: 2,
          max_attempts: 25,
          error_message: expect.stringContaining("Intentional"),
        });
        expect(row.remaining_ms).toBeGreaterThan(configuredDelay - 15_000);
        expect(row.remaining_ms).toBeLessThanOrEqual(configuredDelay);
        expect(row.checkpoint_count).toBeGreaterThan(0);
      }
      expect(rows.map((row) => row.scenario)).toEqual([
        "order-fulfillment",
        "customer-onboarding",
        "report-publication",
      ]);
      const client = dashboardClient(app);
      const retried = await client.dashboard.tasks({ filter: "retried", page: 1, pageSize: 25 });
      expect(retried.jobs).toEqual(
        expect.arrayContaining(
          DEMO_PERSISTENT_RETRY_DELAYS_MS.map((retryDelayMs, index) =>
            expect.objectContaining({
              state: "scheduled",
              attempt: 2,
              maxAttempts: 25,
              retryPolicy: DEMO_PERSISTENT_RETRY_POLICIES[index],
              runAt: expect.any(String),
              payload: expect.objectContaining({
                failureMode: "continuous",
                source: "persistent-failure-seed",
              }),
              tags: expect.arrayContaining(["intentionally-failing"]),
            }),
          ),
        ),
      );
      const detail = await client.dashboard.jobDetail({ id: retried.jobs[0]!.id });
      expect(detail.identity.retryPolicy).toEqual(retried.jobs[0]!.retryPolicy);
      let system = await client.dashboard.system({ window: "1h" });
      for (let attempt = 0; attempt < 80 && system.kpis.retry.backoff !== 3; attempt += 1) {
        await sleep(25);
        system = await client.dashboard.system({ window: "1h" });
      }
      expect(system.kpis.retry).toMatchObject({
        backoff: 3,
        dueSoon: 1,
        buckets: expect.arrayContaining([
          { label: "5m", count: 1 },
          { label: "15m", count: 2 },
        ]),
      });
      expect(workerErrors).toEqual([]);
    } finally {
      await workhorse.stop();
    }
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
        status: { level: "healthy", checks: [], criticalChecks: [], degradedChecks: [] },
        kpis: {
          drain: { completedPerMinute: expect.any(Number), enqueuedPerMinute: expect.any(Number) },
          backlog: { ready: 0 },
          errorRate: { current: 0 },
          lease: { expired: 0 },
        },
        outcomes: expect.any(Array),
        integrity: {
          dueButUnpromoted: 0,
          partitions: expect.any(Array),
          defaultEventRows: 0,
          defaultAttemptRows: 0,
          retention: {
            policyUpdatedAt: expect.any(String),
            eligibleHistoryPartitions: { jobEvents: 0, attemptHistory: 0 },
            defaultHistoryRows: { jobEvents: 0, attemptHistory: 0 },
            defaultHistoryRowsCapped: { jobEvents: false, attemptHistory: false },
          },
        },
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

  it("suspends and reclaims one logical attempt around a named durable timer", async () => {
    const operations: Array<{ operation: string; attempt: number; fenceToken: string }> = [];
    const { app, workhorse } = createTestApplication({
      workerPollMs: 5,
      maintenanceIntervalMs: 100,
      durableTimerWaitMs: 500,
      onDurableTimerOperation(operation, attempt, fenceToken) {
        operations.push({ operation, attempt, fenceToken: fenceToken.toString() });
      },
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const response = await app.request("/demo/timers", { method: "POST" });
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as {
        jobId: string;
        expectedAttempt: number;
        prepareCheckpoint: string;
        waitName: string;
        publishCheckpoint: string;
      };
      expect(accepted).toMatchObject({
        expectedAttempt: 1,
        prepareCheckpoint: DURABLE_TIMER_PREPARE_CHECKPOINT,
        waitName: DURABLE_TIMER_WAIT_NAME,
        publishCheckpoint: DURABLE_TIMER_PUBLISH_CHECKPOINT,
      });

      let suspended:
        | {
            state: string;
            current_attempt: number;
            fence_token: string;
            worker_id: string | null;
            acquired_at: Date | null;
            heartbeat_at: Date | null;
            expires_at: Date | null;
            wait_name: string | null;
            attempt_started_at: Date;
          }
        | undefined;
      for (let poll = 0; poll < 100 && suspended?.state !== "scheduled"; poll += 1) {
        await sleep(10);
        suspended = (
          await pool.query(
            `SELECT state, current_attempt, fence_token::text, worker_id, acquired_at, heartbeat_at,
                    expires_at, wait_name, attempt_started_at
               FROM workhorse.job_runtime WHERE job_id = $1`,
            [accepted.jobId],
          )
        ).rows[0];
      }
      expect(suspended).toMatchObject({
        state: "scheduled",
        current_attempt: 1,
        fence_token: "0",
        worker_id: null,
        acquired_at: null,
        heartbeat_at: null,
        expires_at: null,
        wait_name: DURABLE_TIMER_WAIT_NAME,
        attempt_started_at: expect.any(Date),
      });

      const waits = await pool.query<{
        wait_name: string;
        mode: string;
        duration_ms: string;
        wake_at: Date;
        attempt: number;
        fence_token: string;
        worker_id: string;
      }>(
        `SELECT wait_name, mode, duration_ms::text, wake_at, attempt, fence_token::text, worker_id
           FROM workhorse.job_wait WHERE job_id = $1`,
        [accepted.jobId],
      );
      expect(waits.rows).toEqual([
        {
          wait_name: DURABLE_TIMER_WAIT_NAME,
          mode: "relative",
          duration_ms: "500",
          wake_at: expect.any(Date),
          attempt: 1,
          fence_token: expect.any(String),
          worker_id: expect.stringMatching(/^demo-worker-/),
        },
      ]);
      const firstFence = waits.rows[0]!.fence_token;
      expect(BigInt(firstFence)).toBeGreaterThan(0n);
      expect(operations).toEqual([{ operation: "prepare", attempt: 1, fenceToken: firstFence }]);
      expect(
        (
          await pool.query(
            `SELECT checkpoint_name, fence_token::text FROM workhorse.job_checkpoint
              WHERE job_id = $1 ORDER BY created_at`,
            [accepted.jobId],
          )
        ).rows,
      ).toEqual([{ checkpoint_name: DURABLE_TIMER_PREPARE_CHECKPOINT, fence_token: firstFence }]);
      expect(
        (
          await pool.query(
            `SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY event_id`,
            [accepted.jobId],
          )
        ).rows.map((row) => row.event_type),
      ).toEqual(["enqueued", "claimed", "checkpoint_saved", "wait_scheduled"]);

      const scheduledTasks = await client.dashboard.tasks({
        filter: "scheduled",
        page: 1,
        pageSize: 25,
      });
      expect(scheduledTasks.jobs).toEqual([
        expect.objectContaining({
          id: accepted.jobId,
          state: "scheduled",
          attempt: 1,
          workerId: null,
          lastWorkerId: waits.rows[0]!.worker_id,
          waitName: DURABLE_TIMER_WAIT_NAME,
          wakeAt: waits.rows[0]!.wake_at.toISOString(),
          wait: {
            name: DURABLE_TIMER_WAIT_NAME,
            wakeAt: waits.rows[0]!.wake_at.toISOString(),
            mode: "relative",
          },
        }),
      ]);
      expect(await client.dashboard.jobDetail({ id: accepted.jobId })).toMatchObject({
        current: {
          runtime: {
            state: "scheduled",
            attempt: 1,
            fenceToken: "0",
            workerId: null,
            acquiredAt: null,
            heartbeatAt: null,
            expiresAt: null,
            waitName: DURABLE_TIMER_WAIT_NAME,
            attemptStartedAt: suspended!.attempt_started_at.toISOString(),
          },
        },
        waits: [
          {
            name: DURABLE_TIMER_WAIT_NAME,
            mode: "relative",
            durationMs: 500,
            wakeAt: waits.rows[0]!.wake_at.toISOString(),
            attempt: 1,
            fenceToken: firstFence,
            workerId: waits.rows[0]!.worker_id,
          },
        ],
      });

      let finalJob:
        | {
            state: string;
            currentAttempt: number;
            fenceToken: string;
            result: Record<string, unknown>;
          }
        | undefined;
      for (let poll = 0; poll < 200 && finalJob?.state !== "succeeded"; poll += 1) {
        await sleep(10);
        const jobResponse = await app.request(`/jobs/${accepted.jobId}`);
        finalJob = ((await jobResponse.json()) as { job: typeof finalJob }).job;
      }
      expect(finalJob).toMatchObject({
        state: "succeeded",
        currentAttempt: 1,
        result: {
          source: "http",
          completed: true,
          attempt: 1,
          prepareCheckpointReused: true,
          waitReplayed: true,
          wait: { name: DURABLE_TIMER_WAIT_NAME, firstFence },
          prepared: { preparedOnAttempt: 1, preparedOnFence: firstFence },
          publication: { publishedOnAttempt: 1, publishedOnFence: expect.any(String) },
        },
      });

      const claims = await pool.query<{
        fence_token: string;
        occurred_at: Date;
      }>(
        `SELECT details->>'fence_token' AS fence_token, occurred_at
           FROM workhorse.job_event
          WHERE job_id = $1 AND event_type = 'claimed' ORDER BY event_id`,
        [accepted.jobId],
      );
      expect(claims.rows).toHaveLength(2);
      expect(claims.rows[0]!.fence_token).toBe(firstFence);
      const secondFence = claims.rows[1]!.fence_token;
      expect(secondFence).not.toBe(firstFence);
      expect(finalJob!.fenceToken).toBe(secondFence);
      expect(operations).toEqual([
        { operation: "prepare", attempt: 1, fenceToken: firstFence },
        { operation: "publish", attempt: 1, fenceToken: secondFence },
      ]);

      const history = await pool.query<{
        attempt: number;
        fence_token: string;
        outcome: string;
        started_at: Date;
        claimed_at: Date;
        finished_at: Date;
      }>(
        `SELECT attempt, fence_token::text, outcome, started_at, claimed_at, finished_at
           FROM workhorse.attempt_history WHERE job_id = $1`,
        [accepted.jobId],
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]).toMatchObject({
        attempt: 1,
        fence_token: secondFence,
        outcome: "succeeded",
        started_at: suspended!.attempt_started_at,
      });
      expect(history.rows[0]!.claimed_at.getTime()).toBeGreaterThan(
        history.rows[0]!.started_at.getTime(),
      );
      expect(
        Math.abs(history.rows[0]!.claimed_at.getTime() - claims.rows[1]!.occurred_at.getTime()),
      ).toBeLessThan(100);
      expect(history.rows[0]!.finished_at.getTime()).toBeGreaterThanOrEqual(
        history.rows[0]!.claimed_at.getTime(),
      );

      const finalDetail = await client.dashboard.jobDetail({ id: accepted.jobId });
      expect(finalDetail).toMatchObject({
        identity: { type: DURABLE_TIMER_JOB_TYPE, state: "succeeded" },
        current: { runtime: null, outcome: { attempt: 1, result: { waitReplayed: true } } },
        checkpoints: [
          { name: DURABLE_TIMER_PREPARE_CHECKPOINT, attempt: 1, fenceToken: firstFence },
          { name: DURABLE_TIMER_PUBLISH_CHECKPOINT, attempt: 1, fenceToken: secondFence },
        ],
        attempts: [
          {
            attempt: 1,
            outcome: "succeeded",
            startedAt: history.rows[0]!.started_at.toISOString(),
            claimedAt: history.rows[0]!.claimed_at.toISOString(),
            executionMs: expect.any(Number),
            elapsedMs: expect.any(Number),
          },
        ],
        waits: [{ name: DURABLE_TIMER_WAIT_NAME, fenceToken: firstFence }],
      });
      expect(finalDetail.attempts[0]!.elapsedMs).toBeGreaterThan(
        finalDetail.attempts[0]!.executionMs + 300,
      );
      expect(finalDetail.events.map((event) => event.type)).toEqual([
        "enqueued",
        "claimed",
        "checkpoint_saved",
        "wait_scheduled",
        "promoted",
        "wait_elapsed",
        "claimed",
        "wait_replayed",
        "checkpoint_saved",
        "succeeded",
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("continues a declared durable pipeline without repeating completed steps", async () => {
    const operations: string[] = [];
    const { app, workhorse } = createTestApplication({
      onDurableStepOperation(scenario, stepName, attempt) {
        operations.push(`${scenario}:${stepName}:${attempt}`);
      },
    });
    workhorse.start();

    try {
      const response = await app.request("/demo/durable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: "order-fulfillment" }),
      });
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as {
        jobId: string;
        scenario: string;
        checkpointPlan: string[];
        expectedAttempts: number;
      };
      expect(accepted).toMatchObject({
        scenario: "order-fulfillment",
        checkpointPlan: [
          "validate-order",
          "reserve-inventory",
          "authorize-payment",
          "arrange-shipment",
        ],
        expectedAttempts: 2,
      });

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
          scenario: "order-fulfillment",
          completed: true,
          attempt: 2,
          reusedCheckpoints: ["validate-order", "reserve-inventory"],
          artifacts: {
            "validate-order": { completedOnAttempt: 1 },
            "reserve-inventory": { completedOnAttempt: 1 },
            "authorize-payment": { completedOnAttempt: 2 },
            "arrange-shipment": { completedOnAttempt: 2 },
          },
        },
      });

      const checkpointRows = (
        await pool.query<{
          checkpoint_name: string;
          checkpoint_value: { operationId: string; completedOnAttempt: number };
          attempt: number;
        }>(
          `SELECT checkpoint_name, checkpoint_value, attempt
             FROM workhorse.job_checkpoint WHERE job_id = $1 ORDER BY created_at, checkpoint_name`,
          [accepted.jobId],
        )
      ).rows;
      expect(
        checkpointRows.map((row) => ({ name: row.checkpoint_name, attempt: row.attempt })),
      ).toEqual([
        { name: "validate-order", attempt: 1 },
        { name: "reserve-inventory", attempt: 1 },
        { name: "authorize-payment", attempt: 2 },
        { name: "arrange-shipment", attempt: 2 },
      ]);
      expect(new Set(checkpointRows.map((row) => row.checkpoint_value.operationId)).size).toBe(4);
      expect(operations).toEqual([
        "order-fulfillment:validate-order:1",
        "order-fulfillment:reserve-inventory:1",
        "order-fulfillment:authorize-payment:2",
        "order-fulfillment:arrange-shipment:2",
      ]);

      const client = dashboardClient(app);
      expect(await client.dashboard.jobDetail({ id: accepted.jobId })).toMatchObject({
        identity: { id: accepted.jobId, state: "succeeded", type: "demo.durable-pipeline" },
        durability: {
          source: "demo-declared",
          scenario: "order-fulfillment",
          label: "Order fulfillment",
          steps: [
            { name: "validate-order" },
            { name: "reserve-inventory" },
            { name: "authorize-payment" },
            { name: "arrange-shipment" },
          ],
        },
        checkpoints: [{ attempt: 1 }, { attempt: 1 }, { attempt: 2 }, { attempt: 2 }],
      });
      await pool.query(
        `INSERT INTO workhorse.job_checkpoint
          (job_id, checkpoint_name, checkpoint_value, attempt, fence_token, worker_id)
         VALUES ($1, 'diagnostic-extra', '{"output":"extra evidence"}'::jsonb, 2, 999999, 'test')`,
        [accepted.jobId],
      );
      expect(
        await client.dashboard.tasks({ filter: "retried", page: 1, pageSize: 25 }),
      ).toMatchObject({
        jobs: [
          {
            id: accepted.jobId,
            durability: { completedSteps: 4, totalSteps: 4 },
          },
        ],
      });
      expect(await client.dashboard.jobDetail({ id: accepted.jobId })).toMatchObject({
        durability: { steps: expect.any(Array) },
        checkpoints: expect.arrayContaining([
          expect.objectContaining({
            name: "diagnostic-extra",
            value: { output: "extra evidence" },
          }),
        ]),
      });
      expect(
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.job_event
            WHERE job_id = $1 AND event_type = 'checkpoint_saved'`,
          [accepted.jobId],
        ),
      ).toMatchObject({ rows: [{ count: 4 }] });

      for (const scenario of ["unknown", "toString", "__proto__"]) {
        expect(
          (
            await app.request("/demo/durable", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ scenario }),
            })
          ).status,
        ).toBe(400);
      }
    } finally {
      await workhorse.stop();
    }
  });

  it.each([
    {
      scenario: "customer-onboarding",
      reused: ["create-account"],
      operations: [
        "customer-onboarding:create-account:1",
        "customer-onboarding:provision-workspace:2",
        "customer-onboarding:send-welcome:2",
      ],
      checkpointAttempts: [1, 2, 2],
    },
    {
      scenario: "report-publication",
      reused: ["snapshot-data", "render-report", "publish-report"],
      operations: [
        "report-publication:snapshot-data:1",
        "report-publication:render-report:1",
        "report-publication:publish-report:1",
      ],
      checkpointAttempts: [1, 1, 1],
    },
  ] as const)("resumes $scenario from its distinct durable boundary", async (example) => {
    const operations: string[] = [];
    const { app, workhorse } = createTestApplication({
      onDurableStepOperation(scenario, stepName, attempt) {
        operations.push(`${scenario}:${stepName}:${attempt}`);
      },
    });
    workhorse.start();

    try {
      const response = await app.request("/demo/durable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: example.scenario }),
      });
      const accepted = (await response.json()) as { jobId: string };
      let job: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && job?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        const jobResponse = await app.request(`/jobs/${accepted.jobId}`);
        job = ((await jobResponse.json()) as { job: typeof job }).job;
      }

      expect(job).toMatchObject({
        state: "succeeded",
        currentAttempt: 2,
        result: { reusedCheckpoints: example.reused },
      });
      expect(operations).toEqual(example.operations);
      expect(
        (
          await pool.query<{ attempt: number }>(
            `SELECT attempt FROM workhorse.job_checkpoint
              WHERE job_id = $1 ORDER BY created_at, checkpoint_name`,
            [accepted.jobId],
          )
        ).rows.map((row) => row.attempt),
      ).toEqual(example.checkpointAttempts);
      expect(
        (
          await pool.query<{ attempt: number; outcome: string }>(
            `SELECT attempt, outcome FROM workhorse.attempt_history
              WHERE job_id = $1 ORDER BY attempt`,
            [accepted.jobId],
          )
        ).rows,
      ).toEqual([
        { attempt: 1, outcome: "retry" },
        { attempt: 2, outcome: "succeeded" },
      ]);
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

    const timer = await client.dashboard.enqueueTest({
      kind: "timer",
      audit: {
        actor: "operator",
        reason: "show named durable timer replay",
        requestId: "audit-durable-timer",
      },
    });
    expect(await client.dashboard.jobDetail({ id: timer.jobId })).toMatchObject({
      identity: { id: timer.jobId, type: DURABLE_TIMER_JOB_TYPE, state: "ready" },
      payload: { source: "operator" },
      waits: [],
      checkpoints: [],
    });
    expect(
      await pool.query("SELECT max_attempts, tags FROM workhorse.job WHERE id = $1", [timer.jobId]),
    ).toMatchObject({
      rows: [
        {
          max_attempts: 1,
          tags: ["demo-test", "durable-checkpoint", "durable-timer"],
        },
      ],
    });
    expect(
      await pool.query(
        `SELECT action, target FROM public.workhorse_demo_audit WHERE request_id = $1`,
        ["audit-durable-timer"],
      ),
    ).toMatchObject({ rows: [{ action: "enqueueTest", target: "job:timer" }] });

    for (const example of [
      { scenario: "order-fulfillment", totalSteps: 4 },
      { scenario: "customer-onboarding", totalSteps: 3 },
      { scenario: "report-publication", totalSteps: 3 },
    ] as const) {
      const durable = await client.dashboard.enqueueTest({
        kind: "durable",
        scenario: example.scenario,
        audit: {
          actor: "operator",
          reason: `show ${example.scenario} durable progress`,
          requestId: `audit-durable-${example.scenario}`,
        },
      });
      const detail = await client.dashboard.jobDetail({ id: durable.jobId });
      expect(detail).toMatchObject({
        identity: { id: durable.jobId, type: "demo.durable-pipeline", state: "ready" },
        payload: { scenario: example.scenario },
        durability: { source: "demo-declared", scenario: example.scenario },
        checkpoints: [],
      });
      expect(detail.durability?.steps).toHaveLength(example.totalSteps);
      expect(
        await client.dashboard.tasks({ filter: "queued", page: 1, pageSize: 25 }),
      ).toMatchObject({
        jobs: expect.arrayContaining([
          expect.objectContaining({
            id: durable.jobId,
            durability: { completedSteps: 0, totalSteps: example.totalSteps },
          }),
        ]),
      });
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

  it("reports history spill as degraded rather than critical", async () => {
    // A timestamp older than every weekly partition lands in the catch-all partition, which is
    // exactly the condition operators need to see. No sleeping or seed data is involved.
    await pool.query(
      `INSERT INTO workhorse.job(id, queue_name, job_type, payload, max_attempts, created_at)
       VALUES ($1, 'demo', 'retention-spill', '{}'::jsonb, 1, timestamptz '2000-01-01T00:00:00Z')`,
      ["00000000-0000-4000-8000-000000000001"],
    );
    await pool.query(
      `INSERT INTO workhorse.job_event (job_id, attempt, event_type, details, occurred_at)
       VALUES ($1, 1, 'enqueued', '{}'::jsonb, timestamptz '2000-01-01T00:00:00Z')`,
      ["00000000-0000-4000-8000-000000000001"],
    );

    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const system = await client.dashboard.system({ window: "1h" });

    expect(system.status.level).toBe("degraded");
    expect(system.status.criticalChecks).toEqual([]);
    expect(system.status.degradedChecks).toEqual(["History rows outside weekly partitions (1)"]);
    expect(system.status.checks).toEqual(system.status.degradedChecks);
    expect(system.integrity.retention.defaultHistoryRows).toEqual({
      jobEvents: 1,
      attemptHistory: 0,
    });
    // The row predates every partition cutoff, so it is spill rather than an un-dropped week.
    expect(system.integrity.retention.eligibleHistoryPartitions).toEqual({
      jobEvents: 0,
      attemptHistory: 0,
    });
    expect(system.integrity.defaultEventRows).toBe(1);
    expect(system.integrity.retention.oldestRetainedAt).toBe("2000-01-01T00:00:00.000Z");
    expect(system.integrity.retention.oldestRetainedCategory).toBe("jobEvents");

    // Retention is disabled by default in the demo, so no category can report lag.
    expect(system.integrity.retention.maxLagMs).toBeNull();
    expect(system.integrity.retention.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "jobEvents",
          label: "Task events",
          lagMs: null,
          prunedByPartition: true,
        }),
      ]),
    );
  });

  it("reports a row-level retention category that is past its cutoff as degraded", async () => {
    // Schedule runs are the one row-level category the shipped policy enables (30 days), so this
    // needs no policy mutation and cannot collide with the identity-dependency check constraint.
    await syncDemoSchedules(pool);
    // Relative interval arithmetic keeps this free of time-zone and ISO-week dependence.
    await pool.query(
      `INSERT INTO workhorse.schedule_occurrence
         (namespace, schedule_name, occurrence_at, job_id, fired_at)
       VALUES ($1, $2, clock_timestamp() - interval '60 days', NULL,
               clock_timestamp() - interval '60 days')`,
      [DEMO_SCHEDULE_NAMESPACE, HEARTBEAT_SCHEDULE_NAME],
    );

    const { app } = createTestApplication();
    const system = await dashboardClient(app).dashboard.system({ window: "1h" });

    expect(system.status.level).toBe("degraded");
    expect(system.status.criticalChecks).toEqual([]);
    expect(system.status.degradedChecks).toEqual(["Retention behind: schedule runs"]);
    expect(system.status.checks).toEqual(system.status.degradedChecks);

    const scheduleRuns = system.integrity.retention.categories.find(
      (row) => row.category === "scheduleOccurrences",
    );
    expect(scheduleRuns).toMatchObject({
      label: "Schedule runs",
      retentionDays: 30,
      prunedByPartition: false,
      oldestRetainedAt: expect.any(String),
    });
    // Roughly 30 days past the cutoff; a wide band keeps clock skew from making this flaky.
    expect(scheduleRuns?.lagMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(scheduleRuns?.lagMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);
    expect(system.integrity.retention.maxLagCategory).toBe("scheduleOccurrences");
    expect(system.integrity.retention.maxLagMs).toBe(scheduleRuns?.lagMs);
    expect(system.integrity.retention.oldestRetainedCategory).toBe("scheduleOccurrences");

    // Categories the policy leaves disabled report no window and no lag rather than a false zero.
    expect(
      system.integrity.retention.categories.find((row) => row.category === "jobEvents"),
    ).toMatchObject({ retentionDays: null, lagMs: null });
    // Retention never escalates past degraded, and nothing spilled outside weekly storage.
    expect(system.integrity.retention.defaultHistoryRows).toEqual({
      jobEvents: 0,
      attemptHistory: 0,
    });
  });

  it("keeps the retention policy read model aligned with the queue read model", async () => {
    const queue = new Queue(pool, "demo");
    const [health, { app }] = [await queue.health(), createTestApplication()];
    const system = await dashboardClient(app).dashboard.system({ window: "1h" });

    expect(system.integrity.retention.policyUpdatedAt).toBe(
      health.retentionPolicy.updatedAt.toISOString(),
    );
    expect(system.integrity.retention.categories.map((row) => row.category)).toEqual([
      "jobIdentity",
      "terminalOutcome",
      "jobEvents",
      "attemptHistory",
      "scheduleOccurrences",
    ]);
    expect(
      system.integrity.retention.categories.find((row) => row.category === "scheduleOccurrences")
        ?.retentionDays,
    ).toBe(health.retentionPolicy.scheduleOccurrenceRetentionDays);
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

  it("returns the same order and task for a repeated keyed submission", async () => {
    const { app } = createTestApplication();
    const order = {
      customerEmail: "repeat@example.com",
      description: "Submit the same order twice",
    };

    const first = await postOrder(app, order, { key: "order-repeat-1" });
    const second = await postOrder(app, order, { key: "order-repeat-1" });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const accepted = (await first.json()) as { orderId: string; jobId: string };
    expect(await second.json()).toEqual(await Promise.resolve({ ...accepted, status: "queued" }));

    // Exactly one application row and one accepted job identity exist for the retained key.
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM public.workhorse_demo_order`))
        .rows[0],
    ).toEqual({ count: 1 });
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM workhorse.job`)).rows[0],
    ).toEqual({ count: 1 });
    expect(accepted.orderId).toBe(deterministicOrderId("workhorse-demo:orders", "order-repeat-1"));

    // A replay records no additional job event, so FIFO order and history stay untouched.
    expect(
      (
        await pool.query<{ event_type: string }>(
          `SELECT event_type FROM workhorse.job_event WHERE job_id = $1 ORDER BY occurred_at, event_id`,
          [accepted.jobId],
        )
      ).rows,
    ).toEqual([{ event_type: "enqueued" }]);
  });

  it("keeps unkeyed submissions creating a new identity every time", async () => {
    const { app } = createTestApplication();
    const order = { customerEmail: "unkeyed@example.com", description: "No key supplied" };
    const first = (await (await postOrder(app, order)).json()) as { orderId: string };
    const second = (await (await postOrder(app, order)).json()) as { orderId: string };
    expect(first.orderId).not.toBe(second.orderId);
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM public.workhorse_demo_order`))
        .rows[0],
    ).toEqual({ count: 2 });
  });

  it("separates identical keys held in different scopes", async () => {
    const { app } = createTestApplication();
    const order = { customerEmail: "scoped@example.com", description: "Same key, two scopes" };
    const first = (await (
      await postOrder(app, order, { key: "shared", scope: "tenant-a" })
    ).json()) as {
      jobId: string;
    };
    const second = (await (
      await postOrder(app, order, { key: "shared", scope: "tenant-b" })
    ).json()) as { jobId: string };
    expect(first.jobId).not.toBe(second.jobId);
  });

  it("rolls back the order insert when a changed request conflicts with a retained key", async () => {
    const { app } = createTestApplication();
    // Longer than the preview budget so the rejected response provably truncates the key.
    const key = "order-conflict-key-long-enough-to-truncate";
    const accepted = (await (
      await postOrder(
        app,
        { customerEmail: "first@example.com", description: "Original order" },
        { key },
      )
    ).json()) as { orderId: string; jobId: string };

    const conflicted = await postOrder(
      app,
      { customerEmail: "second@example.com", description: "Different order under the same key" },
      { key },
    );
    expect(conflicted.status).toBe(409);
    const body = (await conflicted.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: expect.stringContaining("idempotency key"),
      reason: "idempotency-conflict",
      scope: "workhorse-demo:orders",
      keyDigest: expect.stringMatching(/^[0-9a-f]{12}$/),
      keyLength: key.length,
      existingJobId: accepted.jobId,
      // The demo puts a digest of the submitted order in the keyed payload, so a changed
      // customer or description is reported as a real request difference.
      conflictingFields: ["payload"],
      storedRequestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      rejectedRequestDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      retentionMs: DEMO_IDEMPOTENCY_TTL_MS,
    });
    expect(body.storedRequestDigest).not.toBe(body.rejectedRequestDigest);
    // The rejected response identifies the key without ever reproducing it.
    expect(JSON.stringify(body)).not.toContain(key);

    // The whole statement rolled back: no second order row, and the original row is unchanged.
    expect(
      (
        await pool.query<{ id: string; customer_email: string; description: string }>(
          `SELECT id, customer_email, description FROM public.workhorse_demo_order`,
        )
      ).rows,
    ).toEqual([
      {
        id: accepted.orderId,
        customer_email: "first@example.com",
        description: "Original order",
      },
    ]);
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM workhorse.job`)).rows[0],
    ).toEqual({ count: 1 });
  });

  it("never publishes a raw idempotency key through RPC, events, or a conflict response", async () => {
    const sentinel = "sentinel-raw-key-must-never-appear-7f3a91";
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const accepted = (await (
      await postOrder(
        app,
        { customerEmail: "sentinel@example.com", description: "Leak regression" },
        { key: sentinel },
      )
    ).json()) as { jobId: string };

    const conflicted = await postOrder(
      app,
      { customerEmail: "sentinel@example.com", description: "Changed request" },
      { key: sentinel },
    );
    expect(conflicted.status).toBe(409);

    const surfaces = [
      await conflicted.text(),
      JSON.stringify(await client.dashboard.jobDetail({ id: accepted.jobId })),
      JSON.stringify(await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25 })),
      JSON.stringify(
        (
          await pool.query(`SELECT details FROM workhorse.job_event WHERE job_id = $1`, [
            accepted.jobId,
          ])
        ).rows,
      ),
      await (await app.request(`/jobs/${accepted.jobId}`)).text(),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(sentinel);
  });

  it("never reproduces a short idempotency key in a demo-rendered surface", async () => {
    // Regression: core's own `key_preview` is a bounded prefix, so for a key shorter than the
    // preview budget the "preview" is the entire key. Every surface this demo authors must
    // therefore identify a key by digest and length only, never by preview.
    const shortKey = "k1";
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const accepted = (await (
      await postOrder(
        app,
        { customerEmail: "short@example.com", description: "Short key" },
        { key: shortKey },
      )
    ).json()) as { jobId: string };

    const conflicted = await postOrder(
      app,
      { customerEmail: "short@example.com", description: "Changed under a short key" },
      { key: shortKey },
    );
    expect(conflicted.status).toBe(409);
    const conflictBody = await conflicted.text();
    expect(conflictBody).not.toContain(`"${shortKey}"`);
    expect(JSON.parse(conflictBody)).not.toHaveProperty("keyPreview");

    // The evidence this demo derives, and the exact wording it renders from that evidence, are
    // both free of the key even though the underlying core event still records a prefix preview.
    const detail = await client.dashboard.jobDetail({ id: accepted.jobId });
    const enqueued = detail.events.find((event) => event.type === "enqueued");
    const evidence = readIdempotencyEvidence({
      type: enqueued!.type,
      details: enqueued!.details,
    });
    expect(evidence).not.toBeNull();
    expect(evidence).not.toHaveProperty("keyPreview");
    expect(JSON.stringify(evidence)).not.toContain(shortKey);
    expect(describeIdempotency(evidence!).exact).not.toContain(shortKey);
    expect(idempotencyEvidenceLine(evidence!)).not.toContain(shortKey);
  });

  it("exposes only safe deduplication metadata to the dashboard", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    // Longer than the preview budget, so the recorded preview is provably a truncation rather
    // than the whole key.
    const key = "order-metadata-key-long-enough-to-truncate";
    const keyed = (await (
      await postOrder(
        app,
        { customerEmail: "metadata@example.com", description: "Show safe evidence" },
        { key, scope: "tenant-metadata" },
      )
    ).json()) as { jobId: string };
    const unkeyed = (await (
      await postOrder(app, {
        customerEmail: "plain@example.com",
        description: "No deduplication surface",
      })
    ).json()) as { jobId: string };

    const detail = await client.dashboard.jobDetail({ id: keyed.jobId });
    const enqueued = detail.events.find((event) => event.type === "enqueued");
    const evidence = readIdempotencyEvidence({
      type: enqueued!.type,
      details: enqueued!.details,
    });
    expect(evidence).toMatchObject({
      scope: "tenant-metadata",
      ttlMs: DEMO_IDEMPOTENCY_TTL_MS,
      keyLength: key.length,
    });
    expect(evidence!.keyDigest).not.toContain(key);
    expect(JSON.stringify(evidence)).not.toContain(key);
    expect(Object.keys(evidence!)).toEqual([
      "scope",
      "keyDigest",
      "keyLength",
      "ttlMs",
      "expiresAt",
      "requestDigest",
    ]);

    const plainDetail = await client.dashboard.jobDetail({ id: unkeyed.jobId });
    const plainEnqueued = plainDetail.events.find((event) => event.type === "enqueued");
    expect(
      readIdempotencyEvidence({ type: plainEnqueued!.type, details: plainEnqueued!.details }),
    ).toBeNull();

    const tasks = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25 });
    expect(tasks.jobs.find((job) => job.id === keyed.jobId)?.keyed).toBe(true);
    expect(tasks.jobs.find((job) => job.id === unkeyed.jobId)?.keyed).toBe(false);
  });

  it("reports the same keyed state through the snapshot projection as the task list", async () => {
    // Regression: the snapshot used to hardcode `keyed: false`, so a keyed task was silently
    // mislabelled depending only on which projection observed it.
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const keyed = (await (
      await postOrder(
        app,
        { customerEmail: "snapshot@example.com", description: "Snapshot agreement" },
        { key: "snapshot-agreement-key" },
      )
    ).json()) as { jobId: string };
    const unkeyed = (await (
      await postOrder(app, {
        customerEmail: "snapshot-plain@example.com",
        description: "Snapshot agreement, unkeyed",
      })
    ).json()) as { jobId: string };

    const snapshot = await readDashboardSnapshot(
      database,
      new Queue(pool, "demo"),
      ["demo-worker"],
      createLocalOperator(database),
    );
    const tasks = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 50 });
    for (const id of [keyed.jobId, unkeyed.jobId]) {
      const fromSnapshot = snapshot.jobs.find((job) => job.id === id);
      const fromTasks = tasks.jobs.find((job) => job.id === id);
      expect(fromSnapshot).toBeDefined();
      expect(fromTasks).toBeDefined();
      expect(fromSnapshot!.keyed).toBe(fromTasks!.keyed);
    }
    expect(snapshot.jobs.find((job) => job.id === keyed.jobId)!.keyed).toBe(true);
    expect(snapshot.jobs.find((job) => job.id === unkeyed.jobId)!.keyed).toBe(false);
  });

  it("rejects an unusable idempotency header before touching the database", async () => {
    const { app } = createTestApplication();
    const order = { customerEmail: "limits@example.com", description: "Header validation" };
    const oversized = await postOrder(app, order, {
      key: "k".repeat(MAX_DEMO_IDEMPOTENCY_KEY_BYTES + 1),
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      error: expect.stringContaining(IDEMPOTENCY_KEY_HEADER),
    });

    const scopeWithoutKey = await app.request("/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [IDEMPOTENCY_SCOPE_HEADER]: "tenant-a",
      },
      body: JSON.stringify(order),
    });
    expect(scopeWithoutKey.status).toBe(400);
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM public.workhorse_demo_order`))
        .rows[0],
    ).toEqual({ count: 0 });
  });

  it("applies optional idempotency headers to every demo enqueue route", async () => {
    const { app } = createTestApplication();
    for (const [path, body] of [
      ["/demo/retries", {}],
      ["/demo/durable", { scenario: "order-fulfillment" }],
      ["/demo/timers", {}],
      ["/demo/failures", {}],
    ] as const) {
      const request = () =>
        app.request(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [IDEMPOTENCY_KEY_HEADER]: `route-key${path}`,
          },
          body: JSON.stringify(body),
        });
      const first = (await (await request()).json()) as { jobId: string };
      const second = (await (await request()).json()) as { jobId: string };
      expect(second.jobId).toBe(first.jobId);
    }
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM workhorse.job`)).rows[0],
    ).toEqual({ count: 4 });
  });

  it("opens the same task every time the operator repeats the idempotent scenario", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const first = await client.dashboard.enqueueTest({
      kind: "idempotent",
      audit: { actor: "operator", reason: "show deduplication", requestId: "audit-idempotent-1" },
    });
    const second = await client.dashboard.enqueueTest({
      kind: "idempotent",
      audit: { actor: "operator", reason: "show deduplication", requestId: "audit-idempotent-2" },
    });
    expect(second.jobId).toBe(first.jobId);
    expect(
      (await pool.query(`SELECT count(*)::integer AS count FROM workhorse.job`)).rows[0],
    ).toEqual({ count: 1 });

    const detail = await client.dashboard.jobDetail({ id: first.jobId });
    const enqueued = detail.events.find((event) => event.type === "enqueued");
    expect(
      readIdempotencyEvidence({ type: enqueued!.type, details: enqueued!.details }),
    ).toMatchObject({ scope: DEMO_OPERATOR_IDEMPOTENCY_SCOPE });
    expect(JSON.stringify(detail)).not.toContain(DEMO_OPERATOR_IDEMPOTENCY_KEY);

    // Both attempts are audited even though only one task identity exists.
    expect(
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM public.workhorse_demo_audit WHERE action = 'enqueueTest'`,
        )
      ).rows[0],
    ).toEqual({ count: 2 });
  });

  it("seeds exactly one deterministic keyed representative task", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    await seedDemoData(database);

    // Keys are retained only as a hash, so the seed is located by its scope rather than its key.
    const keyedRows = await pool.query<{ job_id: string }>(
      `SELECT job_id::text FROM workhorse.enqueue_idempotency
        WHERE idempotency_scope = $1`,
      [DEMO_SEED_IDEMPOTENCY_SCOPE],
    );
    expect(keyedRows.rows).toHaveLength(1);
    const seededJobId = keyedRows.rows[0]!.job_id;

    const tasks = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 100 });
    expect(tasks.jobs.filter((job) => job.keyed).map((job) => job.id)).toEqual([seededJobId]);
    expect(tasks.jobs.find((job) => job.id === seededJobId)?.tags).toContain("idempotent");
    expect(JSON.stringify(tasks)).not.toContain(DEMO_SEED_IDEMPOTENCY_KEY);

    // Re-running the seed leaves the keyed task alone rather than accumulating duplicates.
    await seedDemoData(database);
    expect(
      (
        await pool.query(
          `SELECT count(*)::integer AS count FROM workhorse.enqueue_idempotency
            WHERE idempotency_scope = $1`,
          [DEMO_SEED_IDEMPOTENCY_SCOPE],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(app).toBeDefined();
  });
});

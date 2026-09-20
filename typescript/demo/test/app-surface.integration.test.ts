/* oxlint-disable vitest/no-standalone-expect -- dashboardBrowserTest wraps Vitest callbacks. */
/**
 * The demo's HTTP surface, its schema contract, and the data and policy it seeds.
 *
 * One piece of the demo integration suite. Every piece owns a scratch database, so the pieces run
 * in parallel; see ./support/demo-integration.ts for the harness they share.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { seedStagingData, syncStagingSchedules } from "../src/staging.js";
import { Queue } from "@stablemates/workhorse";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import {
  assertDemoSchemaCompatible,
  createLocalOperator,
  createLocalOperatorControllers,
  DEMO_BUDGET_MAX_ACTIVE,
  DEMO_BUDGET_NAME,
  DEMO_BUDGET_NAMESPACE,
  DEMO_BUDGET_RATE,
  DEMO_CONCURRENCY_MAX_ACTIVE,
  DEMO_CONCURRENCY_MAX_ACTIVE_PER_KEY,
  DEMO_CONCURRENCY_POLICY_NAMESPACE,
  DEMO_DURABLE_STEP_MS,
  DEMO_DURABLE_TIMER_WAIT_MS,
  DEMO_GO_QUEUE,
  DEMO_LONG_RUNNING_MS,
  DEMO_LONG_RUNNING_SEED_TASKS,
  DEMO_PERSISTENT_RETRY_DELAYS_MS,
  DEMO_PERSISTENT_RETRY_POLICIES,
  DEMO_PYTHON_QUEUE,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT,
  DEMO_RATE_LIMIT_PER_KEY,
  DEMO_RATE_LIMIT_POLICY_NAMESPACE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_RATE_LIMIT_SEED_TASKS,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_SEED_IDEMPOTENCY_KEY,
  DEMO_SEED_IDEMPOTENCY_SCOPE,
  DEMO_SHARED_QUEUE,
  DEMO_TIMING_POLICY_TIMEOUT_MS,
  DEMO_TIMING_TIMEOUT_MS,
  DEMO_WORKER_POLL_MS,
  DURABLE_TIMER_TASK_TYPE,
  GO_WORKER_SCHEDULE_NAME,
  HEARTBEAT_SCHEDULE_NAME,
  HISTORICAL_WORKER_IDS,
  installDemoSchema,
  LANGUAGE_WORKER_TASK_TYPE,
  LONG_RUNNING_SCHEDULE_NAME,
  PYTHON_WORKER_SCHEDULE_NAME,
  REPORT_SCHEDULE_NAME,
  seedDemoData,
  SHARED_WORKER_SCHEDULE_NAME,
  SHARED_WORKER_TASK_TYPE,
  syncDemoBudgets,
  syncDemoConcurrencyPolicies,
  syncDemoRateLimitPolicies,
  syncDemoSchedules,
  TYPESCRIPT_WORKER_SCHEDULE_NAME,
} from "../src/app.js";
import { DEMO_AUDIT_RETENTION_ROWS_PER_PASS, pruneDemoAudit } from "../src/audit-retention.js";
import { DEMO_QUEUE_OPTIONS } from "../src/contracts.js";
import { durableDemoScenarios } from "../src/durable-demo.js";
import {
  DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT,
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  DEMO_FEATURE_SHOWCASE_SOURCE,
} from "../src/feature-showcase.js";
import { createDemoWorkerDefinition } from "../src/worker-definition.js";
import {
  GENERATED_WORKER_ID,
  createDemoIntegrationSuite,
  dashboardBrowserTest,
  settingsDashboardTestName,
  workspaceDashboardTestName,
} from "./support/demo-integration.js";

const { createTestApplication, dashboardClient, database, pool, waitFor } =
  createDemoIntegrationSuite(import.meta.url);

it("reports readiness outside the dashboard route space", async () => {
  const { app } = createTestApplication({ workers: false });

  const response = await app.request("/up");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "ok" });
});

it("sets security and crawler headers across the public demo", async () => {
  const { app } = createTestApplication({ workers: false });

  const readiness = await app.request("/up");

  const robots = await app.request("/robots.txt");
  expect(robots.status).toBe(200);
  expect(robots.headers.get("content-type")).toContain("text/plain");
  await expect(robots.text()).resolves.toBe("User-agent: *\nDisallow: /\n");

  const dashboard = await app.request("/");
  for (const response of [readiness, robots, dashboard]) {
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
});

it("prunes expired demo audit rows in bounded oldest-first passes", async () => {
  await pool.query(
    `INSERT INTO public.workhorse_demo_audit
       (actor, reason, request_id, occurred_at, action, target, status)
     SELECT 'retention-test', 'expired', 'expired-' || id,
            clock_timestamp() - interval '8 days' - id * interval '1 second',
            'enqueueTest', 'test', 'succeeded'
       FROM generate_series(1, $1) AS id`,
    [DEMO_AUDIT_RETENTION_ROWS_PER_PASS + 5],
  );
  await pool.query(
    `INSERT INTO public.workhorse_demo_audit
       (actor, reason, request_id, action, target, status)
     VALUES ('retention-test', 'current', 'current', 'enqueueTest', 'test', 'succeeded')`,
  );

  await expect(pruneDemoAudit(pool)).resolves.toBe(DEMO_AUDIT_RETENTION_ROWS_PER_PASS);
  await expect(
    pool.query<{ expired: number }>(
      `SELECT count(*) FILTER (WHERE request_id LIKE 'expired-%')::integer AS expired
         FROM public.workhorse_demo_audit`,
    ),
  ).resolves.toMatchObject({ rows: [{ expired: 5 }] });
  await expect(pruneDemoAudit(pool)).resolves.toBe(5);
  await expect(
    pool.query<{ request_id: string }>(
      `SELECT request_id FROM public.workhorse_demo_audit ORDER BY id`,
    ),
  ).resolves.toMatchObject({ rows: [{ request_id: "current" }] });
});

dashboardBrowserTest(settingsDashboardTestName, async () => {
  const { app } = createTestApplication({
    workers: false,
    operator: createLocalOperator(database),
  });

  const page = await app.request("/settings");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).toContain("https://www.googletagmanager.com/gtag/js?id=G-9NC8FKZPVB");
  expect(html).toContain("gtag('config', 'G-9NC8FKZPVB')");
  await expect(dashboardClient(app).dashboard.settings()).resolves.toMatchObject({
    editable: true,
    maintenance: { timezone: "UTC" },
    workers: [],
  });
});

it("accepts same-origin mutations behind a TLS-terminating proxy", async () => {
  const publicOrigin = "https://demo.workhorse.run";
  const queueController = createLocalOperatorControllers(database).queueController;
  const { app } = createTestApplication({
    operator: createLocalOperator(database),
    publicOrigin,
    queueController,
  });
  const client = dashboardClient(app, "/rpc", {
    browser: publicOrigin,
    upstream: "http://demo:3000",
  });

  await expect(
    client.dashboard.setQueuePaused({
      queue: "cloudflare-proxy-test",
      paused: true,
      audit: { actor: "operator", reason: "proxy origin", requestId: "proxy-origin" },
    }),
  ).resolves.toEqual({ paused: true });
});

dashboardBrowserTest(workspaceDashboardTestName, async () => {
  // Routing is what this test asserts, so production and staging may share the test database.
  const { app } = createTestApplication({ workers: false, stagingDatabase: database });

  const redirect = await app.request("/");
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe("/production/tasks");

  const page = await app.request("/production/tasks");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('"workspace":"production"');
  expect(html).toContain(
    '"workspaces":[{"name":"production","url":"/production"},{"name":"staging","url":"/staging"}]',
  );

  // The single-workspace URL space no longer exists once workspaces are configured.
  expect((await app.request("/tasks")).status).toBe(404);

  await expect(dashboardClient(app, "/staging/rpc").dashboard.meta()).resolves.toMatchObject({
    environment: "staging",
  });
  await expect(dashboardClient(app, "/production/rpc").dashboard.meta()).resolves.toMatchObject({
    environment: "development",
  });
});

describe("Workhorse demo", () => {
  it("accepts the prepared demo schema without changing it", async () => {
    await expect(assertDemoSchemaCompatible(database)).resolves.toBeUndefined();
  });

  it("rejects an incompatible demo schema version", async () => {
    await pool.query("UPDATE public.workhorse_demo_schema_version SET version = 0");
    try {
      await expect(assertDemoSchemaCompatible(database)).rejects.toThrow(
        "Demo schema version 0 is incompatible with runtime version 1",
      );
    } finally {
      await installDemoSchema(database);
    }
  });

  it("migrates legacy showcase tasks to their family task types", async () => {
    const queue = new Queue(pool, { defaultQueue: DEMO_QUEUE });
    const taskIds = await Promise.all(
      DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) =>
        queue.enqueue("demo.feature-showcase", {
          source: DEMO_FEATURE_SHOWCASE_SOURCE,
          family: family.key,
        }),
      ),
    );

    await installDemoSchema(database);

    expect(
      await pool.query(
        `SELECT payload->>'family' AS family, task_type
           FROM workhorse.task
          WHERE id = ANY($1::uuid[])
          ORDER BY payload->>'family'`,
        [taskIds],
      ),
    ).toMatchObject({
      rows: [...DEMO_FEATURE_SHOWCASE_FAMILIES]
        .toSorted((left, right) => left.key.localeCompare(right.key))
        .map((family) => ({ family: family.key, task_type: family.taskType })),
    });
  });

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
        `SELECT schedule_name, cron_expression, task_type, queue_name, configured_enabled
           FROM workhorse.schedule_definition
          WHERE namespace = $1
          ORDER BY schedule_name`,
        [DEMO_SCHEDULE_NAMESPACE],
      ),
    ).toMatchObject({
      rows: [
        {
          schedule_name: LONG_RUNNING_SCHEDULE_NAME,
          cron_expression: "* * * * *",
          task_type: "demo.long-running",
          queue_name: DEMO_QUEUE,
          configured_enabled: true,
        },
        {
          schedule_name: REPORT_SCHEDULE_NAME,
          cron_expression: "*/5 * * * *",
          task_type: "demo.report",
          queue_name: DEMO_QUEUE,
          configured_enabled: true,
        },
        {
          schedule_name: HEARTBEAT_SCHEDULE_NAME,
          cron_expression: "* * * * *",
          task_type: "demo.recurring",
          queue_name: DEMO_QUEUE,
          configured_enabled: true,
        },
        {
          schedule_name: GO_WORKER_SCHEDULE_NAME,
          cron_expression: "2-59/3 * * * *",
          task_type: LANGUAGE_WORKER_TASK_TYPE,
          queue_name: DEMO_GO_QUEUE,
          configured_enabled: true,
        },
        {
          schedule_name: PYTHON_WORKER_SCHEDULE_NAME,
          cron_expression: "1-59/3 * * * *",
          task_type: LANGUAGE_WORKER_TASK_TYPE,
          queue_name: DEMO_PYTHON_QUEUE,
          configured_enabled: true,
        },
        {
          schedule_name: TYPESCRIPT_WORKER_SCHEDULE_NAME,
          cron_expression: "*/3 * * * *",
          task_type: LANGUAGE_WORKER_TASK_TYPE,
          queue_name: DEMO_QUEUE,
          configured_enabled: true,
        },
        {
          schedule_name: SHARED_WORKER_SCHEDULE_NAME,
          cron_expression: "* * * * *",
          task_type: SHARED_WORKER_TASK_TYPE,
          queue_name: DEMO_SHARED_QUEUE,
          configured_enabled: true,
        },
        ...DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => ({
          schedule_name: family.scheduleName,
          cron_expression: family.schedule,
          task_type: family.taskType,
          queue_name: DEMO_QUEUE,
          configured_enabled: true,
        })).toSorted((left, right) => left.schedule_name.localeCompare(right.schedule_name)),
      ],
    });
  });

  it("seeds a distinct staging workload once and executes its dependencies and retries", async () => {
    const seed = await seedStagingData(database);
    expect(seed.taskIds).toHaveLength(7);
    expect(await seedStagingData(database)).toEqual({ seeded: false, taskIds: [] });
    await syncStagingSchedules(pool);
    await syncStagingSchedules(pool);
    expect(
      (
        await pool.query(
          "SELECT schedule_name AS name, cron_expression FROM workhorse.schedule_definition WHERE namespace = $1",
          [DEMO_SCHEDULE_NAMESPACE],
        )
      ).rows,
    ).toEqual([{ name: "staging.release-validation", cron_expression: "*/10 * * * *" }]);
    const adapter = createDrizzleAdapter(database, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const definition = createDemoWorkerDefinition(database, adapter.queue, {
      concurrency: 2,
      workerId: "test-staging",
      pollMs: 20,
      registryIntervalMs: 100,
      maintenanceIntervalMs: 100,
      durableTimerWaitMs: 20,
      scheduleNamespaces: [],
    });
    const worker = adapter.createWorker(definition.options);
    definition.configure(worker);
    const run = worker.run();
    try {
      await waitFor(
        async () => {
          const tasks = await Promise.all(seed.taskIds.map((id) => adapter.admin.getTask(id)));
          return (
            tasks.map((task) => task?.state).join(",") ===
            "succeeded,succeeded,succeeded,succeeded,canceled,scheduled,failed"
          );
        },
        (done) => done,
        1000,
      );
      expect((await adapter.admin.getTask(seed.taskIds[2]!))?.currentAttempt).toBe(2);
    } finally {
      await worker.stop();
      await run;
    }
  });

  it("seeds representative dashboard data exactly once", async () => {
    const { app } = createTestApplication();

    const seeded = await seedDemoData(database);
    expect(seeded).toMatchObject({ seeded: true, historicalTaskCount: 362 });
    expect(seeded.taskIds).toHaveLength(86);
    expect(await seedDemoData(database)).toEqual({
      seeded: false,
      taskIds: [],
      historicalTaskCount: 0,
    });
    expect(
      await pool.query(
        `SELECT array_agg(DISTINCT version ORDER BY version) AS versions
           FROM (
             -- Throttled acceptance runs inside a SQL exception block, so those rows carry
             -- subtransaction xids of the same showcase transaction rather than its top-level id.
             SELECT xmin::text AS version FROM workhorse.task
               WHERE id = ANY($1::uuid[])
                 AND task_type NOT IN ('demo.long-running', 'demo.keyed-throttle')
             UNION ALL SELECT xmin::text FROM public.workhorse_demo_order
            UNION ALL SELECT xmin::text FROM public.workhorse_demo_seed
               WHERE name = 'default-dashboard-v8'
           ) representative_rows`,
        [seeded.taskIds],
      ),
    ).toMatchObject({
      rows: [{ versions: [expect.any(String), expect.any(String), expect.any(String)] }],
    });
    expect(
      await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_demo_order"),
    ).toMatchObject({ rows: [{ count: 1 }] });
    expect(await pool.query("SELECT count(*)::integer AS count FROM workhorse.task")).toMatchObject(
      {
        rows: [{ count: 448 }],
      },
    );
    const blockedTasks = await dashboardClient(app).dashboard.tasks({
      filter: "blocked",
      page: 1,
      pageSize: 25,
    });
    expect(blockedTasks.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "blocked",
          blockedReason: "prerequisite_pending",
          tags: expect.arrayContaining(["dependency", "release", "dependent"]),
        }),
      ]),
    );
    const visibleBlockedTask = blockedTasks.tasks.find(
      (task) => task.tags.includes("dependency") && task.tags.includes("release"),
    );
    expect(visibleBlockedTask).toBeDefined();
    await expect(
      dashboardClient(app).dashboard.taskDetail({ id: visibleBlockedTask!.id }),
    ).resolves.toMatchObject({
      payload: {
        family: "task-dependencies",
        scenario: "release-after-success",
        role: "dependent",
      },
    });
    const scheduledTasks = await dashboardClient(app).dashboard.tasks({
      filter: "scheduled",
      page: 1,
      pageSize: 25,
    });
    expect(scheduledTasks.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining(visibleBlockedTask!.prerequisiteTaskIds),
    );
    const retainedPrerequisite = scheduledTasks.tasks.find((task) =>
      visibleBlockedTask!.prerequisiteTaskIds.includes(task.id),
    );
    expect(retainedPrerequisite?.runAt).toBe("9999-12-31T23:59:59.999Z");
    expect(
      await pool.query(
        `SELECT payload->>'family' AS family,
                task_type,
                count(DISTINCT payload->>'scenario')::integer AS scenarios
           FROM workhorse.task
          WHERE payload->>'source' = $1
          GROUP BY payload->>'family', task_type
          ORDER BY payload->>'family'`,
        [DEMO_FEATURE_SHOWCASE_SOURCE],
      ),
    ).toMatchObject({
      rows: [...DEMO_FEATURE_SHOWCASE_FAMILIES]
        .toSorted((left, right) => left.key.localeCompare(right.key))
        .map((family) => ({ family: family.key, task_type: family.taskType, scenarios: 3 })),
    });
    expect(DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT).toBe(51);
    expect(
      await pool.query(
        `SELECT count(*)::integer AS count
           FROM workhorse.task task
           JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
          WHERE task.task_type = 'demo.cancellation'
            AND task.payload->>'family' = 'cancellation'
            AND outcome.state = 'canceled'`,
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
    expect(
      await pool.query(
        `SELECT count(*)::integer AS count,
                count(DISTINCT source_task_id)::integer AS sources,
                count(DISTINCT target_task_id)::integer AS targets
           FROM workhorse.task_redrive
          WHERE requested_by = 'demo-seed'`,
      ),
    ).toMatchObject({ rows: [{ count: 2, sources: 2, targets: 2 }] });
    expect(
      await pool.query(
        `SELECT task.payload, task.concurrency_key, task.max_attempts, task.tags, runtime.state,
                runtime.run_at > clock_timestamp() AS is_future
           FROM workhorse.task task
           JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
          WHERE task_type = 'demo.long-running' AND payload->>'source' = 'long-running-seed'
          ORDER BY payload->>'label'`,
      ),
    ).toMatchObject({
      rows: DEMO_LONG_RUNNING_SEED_TASKS.map(({ label, concurrencyKey }) => ({
        payload: { source: "long-running-seed", label },
        concurrency_key: concurrencyKey,
        max_attempts: 1,
        tags: ["demo-test", "long-running", "low-resource", "concurrency-policy"],
        state: "scheduled",
        is_future: true,
      })),
    });
    expect(
      await pool.query(
        `SELECT payload, max_attempts, tags FROM workhorse.task
          WHERE task_type = $1 AND payload->>'source' = 'representative-seed'`,
        [DURABLE_TIMER_TASK_TYPE],
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
        `SELECT task.payload, task.max_attempts,
                task.execution_timeout_ms::integer AS execution_timeout_ms,
                task.deadline_at IS NOT NULL AS has_deadline,
                COALESCE(runtime.state, outcome.state) AS state,
                CASE WHEN runtime.run_at IS NULL THEN NULL
                     ELSE task.deadline_at > runtime.run_at END AS deadline_after_run_at,
                task.tags
           FROM workhorse.task task
           LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
           LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
          WHERE task.task_type = 'demo.timing-policy'
          ORDER BY task.payload->>'source'`,
      ),
    ).toMatchObject({
      rows: [
        {
          payload: { durationMs: 5_000, source: "execution-timeout-seed" },
          max_attempts: 1,
          execution_timeout_ms: DEMO_TIMING_TIMEOUT_MS,
          has_deadline: false,
          state: "ready",
          deadline_after_run_at: null,
          tags: ["demo-test", "execution-timeout", "intentionally-timed-out"],
        },
        {
          payload: { durationMs: 0, source: "expired-deadline-seed" },
          max_attempts: 1,
          execution_timeout_ms: null,
          has_deadline: true,
          state: "failed",
          deadline_after_run_at: null,
          tags: ["demo-test", "deadline", "intentionally-expired"],
        },
        {
          payload: { durationMs: 10, source: "timing-policy-seed" },
          max_attempts: 1,
          execution_timeout_ms: DEMO_TIMING_POLICY_TIMEOUT_MS,
          has_deadline: true,
          state: "scheduled",
          deadline_after_run_at: true,
          tags: ["demo-test", "deadline", "execution-timeout", "deployment-safe"],
        },
      ],
    });
    expect(
      await pool.query(
        `SELECT payload, max_attempts, retry_policy, tags FROM workhorse.task
          WHERE task_type = 'demo.retry' AND payload->>'label' = 'recover-with-durable-checkpoint'`,
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
        `SELECT payload, max_attempts, tags FROM workhorse.task
          WHERE task_type = 'demo.durable-pipeline'
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
        `SELECT payload, max_attempts, retry_policy, tags FROM workhorse.task
          WHERE task_type = 'demo.durable-pipeline'
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
      all: 448,
      scheduled: 10,
      queued: 62,
      completed: 350,
      discarded: 21,
      retried: 22,
    });
    // The rate-limit scenario is the one deliberate degraded check; retention stays healthy.
    await expect(client.dashboard.system({ window: "1h" })).resolves.toMatchObject({
      status: {
        level: "degraded",
        reasons: [
          {
            code: "rate-limit-throttled",
            severity: "degraded",
            observed: 3,
            queue: "partner-api",
          },
        ],
      },
      integrity: {
        retention: {
          maxLagMs: null,
          maxLagCategory: null,
          eligibleHistoryPartitions: { taskEvents: 0, attemptHistory: 0 },
          defaultHistoryRows: { taskEvents: 0, attemptHistory: 0 },
          defaultHistoryRowsCapped: { taskEvents: false, attemptHistory: false },
        },
      },
    });
    const firstPage = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25 });
    const secondPage = await client.dashboard.tasks({ filter: "all", page: 2, pageSize: 25 });
    expect(firstPage).toMatchObject({
      filter: "all",
      page: 1,
      pageSize: 25,
      // Without a count mode a page reports what it proved: this page plus one more row.
      count: "none",
      hasMore: true,
      total: 26,
    });
    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25, count: "exact" }),
    ).resolves.toMatchObject({ count: "exact", total: 448 });
    await expect(client.dashboard.taskCounts()).resolves.toMatchObject({
      all: 448,
      scheduled: 10,
      queued: 62,
      completed: 350,
      discarded: 21,
    });
    expect(firstPage.tasks).toHaveLength(25);
    expect(firstPage).not.toHaveProperty("facets");
    await expect(client.dashboard.taskFacets()).resolves.toMatchObject({
      queues: [
        "demo",
        "emails",
        "orders",
        "partner-api",
        "showcase-dead-letter",
        "showcase-redrive-replay",
        "showcase-redrive-success",
      ],
      workers: [
        HISTORICAL_WORKER_IDS[0],
        HISTORICAL_WORKER_IDS[1],
        "rate-limit-seed-a",
        "rate-limit-seed-b",
        "showcase-seed-dead-letter",
        "showcase-seed-redrive-replay",
        "showcase-seed-redrive-success",
      ],
      taskTypes: expect.arrayContaining(["demo.report", "order.process"]),
      tags: expect.arrayContaining(["billing", "email", "reports", "weekly"]),
    });
    expect(firstPage.tasks.some((task) => task.tags.length > 0)).toBe(true);
    expect(secondPage).toMatchObject({ filter: "all", page: 2, pageSize: 25, total: 51 });
    expect(secondPage.tasks).toHaveLength(25);
    expect(
      await client.dashboard.tasks({ filter: "scheduled", page: 1, pageSize: 25 }),
    ).toMatchObject({
      filter: "scheduled",
      total: 10,
      tasks: expect.arrayContaining([expect.objectContaining({ state: "scheduled" })]),
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
      tagFiltered.tasks.every((task) =>
        task.tags.some((tag) => ["weekly", "billing"].includes(tag)),
      ),
    ).toBe(true);

    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25, search: "report" }),
    ).resolves.toMatchObject({
      tasks: expect.arrayContaining([expect.objectContaining({ type: "demo.report" })]),
    });
    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25, search: "demo.r*ort" }),
    ).resolves.toMatchObject({
      tasks: expect.arrayContaining([expect.objectContaining({ type: "demo.report" })]),
    });
    await expect(
      client.dashboard.tasks({ filter: "all", page: 1, pageSize: 25, search: "no-such-task" }),
    ).resolves.toMatchObject({ total: 0, tasks: [] });

    const queueFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      queue: "emails",
    });
    expect(queueFiltered.tasks.every((task) => task.queue === "emails")).toBe(true);
    const workerFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      worker: HISTORICAL_WORKER_IDS[0],
    });
    expect(
      workerFiltered.tasks.every((task) => task.lastWorkerId === HISTORICAL_WORKER_IDS[0]),
    ).toBe(true);
    const typeFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      taskType: "email.send",
    });
    expect(typeFiltered.tasks.every((task) => task.type === "email.send")).toBe(true);
    const combined = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      queue: "emails",
      worker: HISTORICAL_WORKER_IDS[0],
      taskType: "email.send",
      tags: ["email"],
    });
    expect(combined.total).toBeGreaterThan(0);
    expect(
      combined.tasks.every(
        (task) =>
          task.queue === "emails" &&
          task.lastWorkerId === HISTORICAL_WORKER_IDS[0] &&
          task.type === "email.send" &&
          task.tags.includes("email"),
      ),
    ).toBe(true);
    const priorityFiltered = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      priority: 90,
    });
    expect(priorityFiltered).toMatchObject({ priority: 90, sort: "updated" });
    expect(priorityFiltered.total).toBeGreaterThan(0);
    expect(priorityFiltered.tasks.every((task) => task.priority === 90)).toBe(true);

    const prioritySorted = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 100,
      sort: "priority",
    });
    expect(prioritySorted).toMatchObject({ priority: null, sort: "priority" });
    const sortedPriorities = prioritySorted.tasks.map((task) => task.priority);
    expect(sortedPriorities).toEqual(sortedPriorities.toSorted((left, right) => right - left));
    expect(
      await pool.query(
        `SELECT runtime.state, task.payload, runtime.run_at > clock_timestamp() AS is_future
           FROM workhorse.task task
           JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
          WHERE task.payload->>'source' = 'scheduled-seed'`,
      ),
    ).toMatchObject({
      rows: [{ state: "scheduled", payload: { source: "scheduled-seed" }, is_future: true }],
    });

    const queueActivity = await client.dashboard.activity({
      filter: "all",
      period: "7d",
      groupBy: "queue",
    });
    expect(queueActivity.groups).toEqual([
      "demo",
      "emails",
      "orders",
      "partner-api",
      "showcase-dead-letter",
      "showcase-redrive-replay",
      "showcase-redrive-success",
    ]);
    expect(
      queueActivity.buckets.filter((bucket) => Object.keys(bucket.counts).length > 0).length,
    ).toBeGreaterThan(6);
    const filteredActivity = await client.dashboard.activity({
      filter: "all",
      period: "7d",
      groupBy: "task",
      tags: ["email"],
      queue: "emails",
      worker: HISTORICAL_WORKER_IDS[0],
    });
    expect(filteredActivity.groups.every((group) => group.startsWith("email."))).toBe(true);
    await expect(
      client.dashboard.activity({ filter: "all", period: "7d", groupBy: "worker" }),
    ).resolves.toMatchObject({
      groups: [
        HISTORICAL_WORKER_IDS[0],
        HISTORICAL_WORKER_IDS[1],
        "rate-limit-seed-a",
        "rate-limit-seed-b",
        "showcase-seed-dead-letter",
        "showcase-seed-redrive-replay",
        "showcase-seed-redrive-success",
        "unassigned",
      ],
    });
    const taskActivity = await client.dashboard.activity({
      filter: "all",
      period: "7d",
      groupBy: "task",
    });
    expect(taskActivity.groups).toEqual(
      expect.arrayContaining([
        "demo.batch-digest",
        "demo.durable-pipeline",
        "demo.task-dependency",
        "demo.recurring",
        "demo.report",
        "email.digest",
        "email.send",
        "order.process",
        "order.refund",
      ]),
    );
    expect(taskActivity.groups.length).toBeGreaterThan(10);
    expect(taskActivity.groups).not.toContain("other");
    await expect(
      client.dashboard.activity({ filter: "all", period: "7d", groupBy: "status" }),
    ).resolves.toMatchObject({
      groupBy: "status",
      groups: ["blocked", "canceled", "failed", "ready", "scheduled", "succeeded"],
    });
  });

  it("synchronizes a fleet budget and seeds queue-scoped key examples", async () => {
    await syncDemoConcurrencyPolicies(pool);
    await seedDemoData(database);

    await expect(new Queue(pool).listConcurrencyPolicies(["demo"])).resolves.toEqual([
      expect.objectContaining({
        namespace: DEMO_CONCURRENCY_POLICY_NAMESPACE,
        queue: "demo",
        maxActive: DEMO_CONCURRENCY_MAX_ACTIVE,
        maxActivePerKey: DEMO_CONCURRENCY_MAX_ACTIVE_PER_KEY,
      }),
    ]);
    await expect(
      pool.query(
        `SELECT payload->>'label' AS label, concurrency_key, tags
           FROM workhorse.task
          WHERE task_type = 'demo.long-running'
            AND payload->>'source' = 'long-running-seed'
          ORDER BY payload->>'label'`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          label: "archive-validation",
          concurrency_key: "customer-acme",
          tags: expect.arrayContaining(["concurrency-policy"]),
        },
        {
          label: "partner-catalog-sync",
          concurrency_key: "customer-acme",
          tags: expect.arrayContaining(["concurrency-policy"]),
        },
        {
          label: "quarterly-report-export",
          concurrency_key: "customer-globex",
          tags: expect.arrayContaining(["concurrency-policy"]),
        },
      ],
    });

    const examples = await pool.query<{ id: string; label: string; concurrency_key: string }>(
      `SELECT id::text, payload->>'label' AS label, concurrency_key
         FROM workhorse.task
        WHERE task_type = 'demo.long-running'
          AND payload->>'source' = 'long-running-seed'`,
    );
    const idByLabel = new Map(examples.rows.map((row) => [row.label, row.id]));
    const keyById = new Map(examples.rows.map((row) => [row.id, row.concurrency_key]));
    const exampleIds = examples.rows.map((row) => row.id);
    await pool.query(
      `UPDATE workhorse.task_runtime
          SET state = 'scheduled', run_at = clock_timestamp() + interval '1 day',
              ready_at = NULL, sequence = NULL, worker_id = NULL, acquired_at = NULL,
              heartbeat_at = NULL, expires_at = NULL, attempt_timeout_at = NULL,
              fence_token = 0, wait_name = NULL, attempt_started_at = NULL,
              cancel_requested_at = NULL, cancel_requested_by = NULL, cancel_reason = NULL`,
    );
    await pool.query(
      `UPDATE workhorse.task_runtime
          SET state = 'ready', run_at = clock_timestamp(), ready_at = clock_timestamp(),
              sequence = nextval('workhorse.ready_sequence_seq')
        WHERE task_id = ANY($1::uuid[])`,
      [exampleIds],
    );

    const queue = new Queue(pool, "demo");
    const first = await queue.claim("demo-concurrency-a", { queue: "demo" });
    const second = await queue.claim("demo-concurrency-b", { queue: "demo" });
    if (!first || !second) throw new Error("Expected two distinct concurrency keys to be admitted");
    expect([keyById.get(first.id), keyById.get(second.id)].toSorted()).toEqual([
      "customer-acme",
      "customer-globex",
    ]);
    await expect(queue.claim("demo-concurrency-c", { queue: "demo" })).resolves.toBeNull();

    const acmeClaim = keyById.get(first.id) === "customer-acme" ? first : second;
    const acmeWorker = acmeClaim === first ? "demo-concurrency-a" : "demo-concurrency-b";
    const globexClaim = acmeClaim === first ? second : first;
    const globexWorker = globexClaim === first ? "demo-concurrency-a" : "demo-concurrency-b";
    const remainingAcmeId = [
      idByLabel.get("archive-validation"),
      idByLabel.get("partner-catalog-sync"),
    ].find((id) => id !== acmeClaim.id);
    await queue.complete(acmeClaim, acmeWorker, { seededConcurrencyExample: true });
    const released = await queue.claim("demo-concurrency-c", { queue: "demo" });
    expect(released?.id).toBe(remainingAcmeId);
    await queue.complete(globexClaim, globexWorker, { seededConcurrencyExample: true });
    await queue.complete(released!, "demo-concurrency-c", { seededConcurrencyExample: true });
  });

  it("synchronizes one named budget that the seeded queues share", async () => {
    await syncDemoConcurrencyPolicies(pool);
    await syncDemoRateLimitPolicies(pool);
    await syncDemoBudgets(pool);
    await seedDemoData(database);

    await expect(new Queue(pool).listBudgets([DEMO_BUDGET_NAME])).resolves.toEqual([
      expect.objectContaining({
        namespace: DEMO_BUDGET_NAMESPACE,
        name: DEMO_BUDGET_NAME,
        maxActive: DEMO_BUDGET_MAX_ACTIVE,
        rate: DEMO_BUDGET_RATE,
      }),
    ]);
    await expect(
      pool.query(
        `SELECT DISTINCT task.queue_name
           FROM workhorse.task task
          WHERE task.budget_name = $1
          ORDER BY task.queue_name`,
        [DEMO_BUDGET_NAME],
      ),
    ).resolves.toMatchObject({
      rows: [{ queue_name: DEMO_QUEUE }, { queue_name: DEMO_RATE_LIMIT_QUEUE }],
    });
    const health = await new Queue(pool).health();
    expect(health.budgetPolicies.budgets).toEqual([
      expect.objectContaining({ name: DEMO_BUDGET_NAME, maxActive: DEMO_BUDGET_MAX_ACTIVE }),
    ]);
  });

  it("seeds a visibly throttled partner API queue", async () => {
    await syncDemoRateLimitPolicies(pool);
    await seedDemoData(database);

    await expect(new Queue(pool).listRateLimitPolicies([DEMO_RATE_LIMIT_QUEUE])).resolves.toEqual([
      expect.objectContaining({
        namespace: DEMO_RATE_LIMIT_POLICY_NAMESPACE,
        queue: DEMO_RATE_LIMIT_QUEUE,
        rate: DEMO_RATE_LIMIT,
        perKey: DEMO_RATE_LIMIT_PER_KEY,
      }),
    ]);
    await expect(
      pool.query(
        `SELECT runtime.state, task.concurrency_key, count(*)::integer AS count
           FROM workhorse.task task
           JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
          WHERE task.payload->>'source' = 'rate-limit-seed'
          GROUP BY runtime.state, task.concurrency_key
          ORDER BY task.concurrency_key`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { state: "ready", concurrency_key: "customer-acme", count: 2 },
        { state: "ready", concurrency_key: "customer-globex", count: 1 },
      ],
    });
    expect(DEMO_RATE_LIMIT_SEED_TASKS).toHaveLength(5);
    await expect(new Queue(pool).rateLimitStatuses([DEMO_RATE_LIMIT_QUEUE])).resolves.toMatchObject(
      [
        {
          throttledReady: 3,
          throttledKeys: 2,
          nextEligibleAt: expect.any(Date),
        },
      ],
    );
  });

  it("drains the partner API backlog only as rate tokens refill", async () => {
    const { workhorse } = createTestApplication({ rateLimitWorker: true });
    await syncDemoRateLimitPolicies(pool);
    await seedDemoData(database);
    workhorse.start();

    try {
      await pool.query(
        `UPDATE workhorse.rate_limit_bucket
            SET refilled_at = clock_timestamp() - interval '1 hour'
          WHERE queue_name = $1`,
        [DEMO_RATE_LIMIT_QUEUE],
      );
      await waitFor(
        async () => {
          const result = await pool.query<{ count: number }>(
            `SELECT count(*)::integer AS count
               FROM workhorse.task task
               JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
              WHERE task.payload->>'source' = 'rate-limit-seed'
                AND outcome.state = 'succeeded'`,
          );
          return result.rows[0]!.count;
        },
        (count) => count === 4,
      );
      await expect(
        pool.query(
          `SELECT count(*)::integer AS count
             FROM workhorse.task task
             JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
            WHERE task.payload->>'source' = 'rate-limit-seed' AND runtime.state = 'ready'`,
        ),
      ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    } finally {
      await workhorse.stop();
    }
  });

  it("materializes the representative execution-timeout example", async () => {
    const { workhorse } = createTestApplication({ maintenanceIntervalMs: 100 });
    await seedDemoData(database);
    const seeded = await pool.query<{ id: string }>(
      `SELECT id::text FROM workhorse.task
        WHERE task_type = 'demo.timing-policy'
          AND payload->>'source' = 'execution-timeout-seed'`,
    );
    const taskId = seeded.rows[0]!.id;
    workhorse.start();

    try {
      let task = await workhorse.context.admin.getTask(taskId);
      for (let attempt = 0; attempt < 240 && task?.state !== "failed"; attempt += 1) {
        await sleep(25);
        task = await workhorse.context.admin.getTask(taskId);
      }
      expect(task).toMatchObject({
        state: "failed",
        currentAttempt: 1,
        error: { name: "ExecutionTimeout" },
      });
      await expect(
        pool.query(
          `SELECT outcome FROM workhorse.attempt_history
            WHERE task_id = $1 ORDER BY attempt`,
          [taskId],
        ),
      ).resolves.toMatchObject({ rows: [{ outcome: "timeout" }] });
    } finally {
      await workhorse.stop();
    }
  });

  it("keeps seeded durable failures pinned to their persistent boundary across retries", async () => {
    const workerErrors: unknown[] = [];
    const { app, workhorse } = createTestApplication({
      durableTimerWaitMs: 1,
      maintenanceIntervalMs: 100,
      onWorkerError: (error) => workerErrors.push(error),
    });
    await seedDemoData(database);
    workhorse.start();

    type PersistentFailureRow = {
      task_id: string;
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
    type PersistentCheckpointRow = {
      scenario: string;
      checkpoint_name: string;
      checkpoint_value: {
        operationId: string;
        completedAt: string;
        completedOnAttempt: number;
        output: string;
      };
      attempt: number;
      fence_token: string;
      worker_id: string;
    };
    const persistentScenarios = Object.entries(durableDemoScenarios).map(
      ([scenario, definition], index) => {
        const boundaryIndex = definition.persistentFailAfterStep;
        const checkpointNames = definition.steps
          .slice(0, boundaryIndex + 1)
          .map((step) => step.name);
        const boundaryStep = definition.steps[boundaryIndex]!;
        const nextStep = definition.steps[boundaryIndex + 1];
        return {
          scenario,
          checkpointNames,
          retryDelayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[index]!,
          retryPolicy: DEMO_PERSISTENT_RETRY_POLICIES[index]!,
          errorMessage: nextStep
            ? `Intentional persistent demo failure between durable stages ${boundaryStep.name} and ${nextStep.name}`
            : `Intentional persistent demo failure at the boundary after durable stage ${boundaryStep.name}`,
        };
      },
    );
    const readPersistentRows = async () =>
      (
        await pool.query<PersistentFailureRow>(`
          SELECT task.id AS task_id, task.payload->>'scenario' AS scenario,
                 CASE task.payload->>'scenario'
                   WHEN 'order-fulfillment' THEN ${DEMO_PERSISTENT_RETRY_DELAYS_MS[0]}
                   WHEN 'customer-onboarding' THEN ${DEMO_PERSISTENT_RETRY_DELAYS_MS[1]}
                   ELSE ${DEMO_PERSISTENT_RETRY_DELAYS_MS[2]}
                 END AS retry_delay_ms,
                 task.retry_policy,
                 (SELECT (event.details->>'retry_delay_ms')::integer
                    FROM workhorse.task_event event
                   WHERE event.task_id = task.id AND event.event_type = 'retry_scheduled'
                   ORDER BY event.occurred_at DESC, event.event_id DESC LIMIT 1) AS selected_delay_ms,
                 runtime.state, runtime.current_attempt, task.max_attempts,
                 floor(extract(epoch FROM (runtime.run_at - clock_timestamp())) * 1000)::integer
                   AS remaining_ms,
                 (SELECT count(*)::integer FROM workhorse.task_checkpoint checkpoint
                   WHERE checkpoint.task_id = task.id) AS checkpoint_count,
                 runtime.error->>'message' AS error_message
            FROM workhorse.task task
            JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
           WHERE task.payload->>'source' = 'persistent-failure-seed'
           ORDER BY CASE task.payload->>'scenario'
             WHEN 'order-fulfillment' THEN 1
             WHEN 'customer-onboarding' THEN 2
             ELSE 3
           END
        `)
      ).rows;
    const readPersistentCheckpoints = async () =>
      (
        await pool.query<PersistentCheckpointRow>(`
          SELECT task.payload->>'scenario' AS scenario, checkpoint.checkpoint_name,
                 checkpoint.checkpoint_value, checkpoint.attempt,
                 checkpoint.fence_token::text, checkpoint.worker_id
            FROM workhorse.task_checkpoint checkpoint
            JOIN workhorse.task task ON task.id = checkpoint.task_id
           WHERE task.payload->>'source' = 'persistent-failure-seed'
           ORDER BY CASE task.payload->>'scenario'
             WHEN 'order-fulfillment' THEN 1
             WHEN 'customer-onboarding' THEN 2
             ELSE 3
           END, checkpoint.created_at, checkpoint.checkpoint_name
        `)
      ).rows;
    try {
      // The full seventeen-family showcase backlog competes for the same four worker slots (the
      // batch family lingers deliberately), so this wait needs a larger budget than the default.
      const firstAttemptRows = await waitFor(
        readPersistentRows,
        (rows) =>
          rows.length === persistentScenarios.length &&
          rows.every((row) => row.state === "scheduled" && row.current_attempt === 2),
        1_200,
      );

      for (const [index, row] of firstAttemptRows.entries()) {
        const expected = persistentScenarios[index]!;
        expect(row).toMatchObject({
          scenario: expected.scenario,
          retry_delay_ms: expected.retryDelayMs,
          retry_policy: expected.retryPolicy,
          selected_delay_ms: expected.retryDelayMs,
          state: "scheduled",
          current_attempt: 2,
          max_attempts: 25,
          checkpoint_count: expected.checkpointNames.length,
          error_message: expected.errorMessage,
        });
        expect(row.remaining_ms).toBeGreaterThan(expected.retryDelayMs - 15_000);
        expect(row.remaining_ms).toBeLessThanOrEqual(expected.retryDelayMs);
      }
      const firstCheckpoints = await readPersistentCheckpoints();
      expect(
        firstCheckpoints.map((checkpoint) => ({
          scenario: checkpoint.scenario,
          name: checkpoint.checkpoint_name,
          attempt: checkpoint.attempt,
        })),
      ).toEqual(
        persistentScenarios.flatMap((expected) =>
          expected.checkpointNames.map((name) => ({
            scenario: expected.scenario,
            name,
            attempt: 1,
          })),
        ),
      );
      for (const checkpoint of firstCheckpoints) {
        expect(checkpoint).toMatchObject({
          checkpoint_value: {
            operationId: expect.any(String),
            completedAt: expect.any(String),
            completedOnAttempt: 1,
            output: expect.stringMatching(/ completed$/),
          },
          fence_token: expect.any(String),
          worker_id: expect.stringMatching(GENERATED_WORKER_ID),
        });
      }
      await pool.query(`
        UPDATE workhorse.task_runtime runtime
           SET run_at = clock_timestamp()
          FROM workhorse.task task
         WHERE runtime.task_id = task.id
           AND runtime.state = 'scheduled'
           AND task.payload->>'source' = 'persistent-failure-seed'
      `);
      const secondAttemptRows = await waitFor(
        readPersistentRows,
        (rows) =>
          rows.length === persistentScenarios.length &&
          rows.every((row) => row.state === "scheduled" && row.current_attempt === 3),
      );
      for (const [index, row] of secondAttemptRows.entries()) {
        const expected = persistentScenarios[index]!;
        expect(row).toMatchObject({
          scenario: expected.scenario,
          retry_policy: expected.retryPolicy,
          state: "scheduled",
          current_attempt: 3,
          max_attempts: 25,
          checkpoint_count: expected.checkpointNames.length,
          error_message: expected.errorMessage,
        });
        expect(row.remaining_ms).toBeGreaterThan(0);
      }
      expect(await readPersistentCheckpoints()).toEqual(firstCheckpoints);
      expect(
        (
          await pool.query<{ scenario: string; attempt: number; outcome: string }>(`
            SELECT task.payload->>'scenario' AS scenario, history.attempt, history.outcome
              FROM workhorse.attempt_history history
              JOIN workhorse.task task ON task.id = history.task_id
             WHERE task.payload->>'source' = 'persistent-failure-seed'
             ORDER BY CASE task.payload->>'scenario'
               WHEN 'order-fulfillment' THEN 1
               WHEN 'customer-onboarding' THEN 2
               ELSE 3
             END, history.attempt
          `)
        ).rows,
      ).toEqual(
        persistentScenarios.flatMap((expected) => [
          { scenario: expected.scenario, attempt: 1, outcome: "retry" },
          { scenario: expected.scenario, attempt: 2, outcome: "retry" },
        ]),
      );

      const client = dashboardClient(app);
      const retried = await client.dashboard.tasks({ filter: "retried", page: 1, pageSize: 25 });
      expect(retried.tasks).toEqual(
        expect.arrayContaining(
          DEMO_PERSISTENT_RETRY_DELAYS_MS.map((retryDelayMs, index) =>
            expect.objectContaining({
              state: "scheduled",
              attempt: 3,
              maxAttempts: 25,
              retryPolicy: DEMO_PERSISTENT_RETRY_POLICIES[index],
              runAt: expect.any(String),
              tags: expect.arrayContaining(["intentionally-failing"]),
            }),
          ),
        ),
      );
      for (const [index, row] of secondAttemptRows.entries()) {
        const expected = persistentScenarios[index]!;
        const detail = await client.dashboard.taskDetail({ id: row.task_id });
        expect(detail).toMatchObject({
          payload: {
            failureMode: "continuous",
            source: "persistent-failure-seed",
            scenario: expected.scenario,
          },
          identity: {
            id: row.task_id,
            state: "scheduled",
            retryPolicy: expected.retryPolicy,
            maxAttempts: 25,
          },
          current: {
            runtime: {
              state: "scheduled",
              attempt: 3,
              error: { message: expected.errorMessage },
            },
            error: { message: expected.errorMessage },
          },
          attempts: [
            { attempt: 1, outcome: "retry", error: { message: expected.errorMessage } },
            { attempt: 2, outcome: "retry", error: { message: expected.errorMessage } },
          ],
        });
        expect(
          detail.checkpoints.map((checkpoint) => ({
            name: checkpoint.name,
            value: checkpoint.value,
            attempt: checkpoint.attempt,
            fenceToken: checkpoint.fenceToken,
            workerId: checkpoint.workerId,
          })),
        ).toEqual(
          firstCheckpoints
            .filter((checkpoint) => checkpoint.scenario === expected.scenario)
            .map((checkpoint) => ({
              name: checkpoint.checkpoint_name,
              value: checkpoint.checkpoint_value,
              attempt: checkpoint.attempt,
              fenceToken: checkpoint.fence_token,
              workerId: checkpoint.worker_id,
            })),
        );
      }
      expect(workerErrors).toEqual([]);
    } finally {
      await workhorse.stop();
    }
  });

  it("runs workers without mounting dashboard routes", async () => {
    const { app, workhorse } = createTestApplication({ dashboard: false });
    workhorse.start();

    try {
      expect((await app.request("/")).status).toBe(404);
      expect((await app.request("/workhorse/rpc/dashboard/tasks")).status).toBe(404);
      expect((await app.request("/workhorse/events")).status).toBe(404);
      const taskId = await workhorse.context.queue.enqueue(
        "demo.recurring",
        { source: "headless-test" },
        { maxAttempts: 1, tags: ["demo-test"] },
      );
      const task = await waitFor(
        () => workhorse.context.admin.getTask(taskId),
        (candidate) => candidate?.state === "succeeded",
      );
      expect(task?.state).toBe("succeeded");
    } finally {
      await workhorse.stop();
    }
  });

  it("seeds exactly one deterministic keyed representative task", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    await seedDemoData(database);

    // Keys are retained only as a hash, so the seed is located by its scope rather than its key.
    const keyedRows = await pool.query<{ task_id: string }>(
      `SELECT task_id::text FROM workhorse.enqueue_idempotency
        WHERE idempotency_scope = $1`,
      [DEMO_SEED_IDEMPOTENCY_SCOPE],
    );
    expect(keyedRows.rows).toHaveLength(1);
    const seededTaskId = keyedRows.rows[0]!.task_id;

    const tasks = await client.dashboard.tasks({ filter: "all", page: 1, pageSize: 100 });
    expect(tasks.tasks.filter((task) => task.keyed).map((task) => task.id)).toContain(seededTaskId);
    expect(tasks.tasks.find((task) => task.id === seededTaskId)?.tags).toContain("idempotent");
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

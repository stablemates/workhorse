import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Admin, installSchema, Queue, type Json, type Worker } from "@workhorse-js/core";
import { createDrizzleAdapter } from "@workhorse-js/drizzle";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLocalDatabasePurpose, localDatabaseUrl } from "../../core/src/local-database.js";
import {
  assertDemoSchemaCompatible,
  createDemoApplication,
  createDemoDatabase,
  createLocalOperatorControllers,
  createLocalOperator,
  createLocalScheduleController,
  DEMO_CONCURRENCY_MAX_ACTIVE,
  DEMO_CONCURRENCY_MAX_ACTIVE_PER_KEY,
  DEMO_CONCURRENCY_POLICY_NAMESPACE,
  DEMO_OPERATOR_IDEMPOTENCY_KEY,
  DEMO_OPERATOR_IDEMPOTENCY_SCOPE,
  DEMO_SEED_IDEMPOTENCY_KEY,
  DEMO_SEED_IDEMPOTENCY_SCOPE,
  DEMO_DURABLE_STEP_MS,
  DEMO_DURABLE_TIMER_WAIT_MS,
  DEMO_LONG_RUNNING_MS,
  DEMO_LONG_RUNNING_SEED_JOBS,
  DEMO_MAINTENANCE_INTERVAL_MS,
  DEMO_MAINTENANCE_TASK_POLL_MS,
  DEMO_PERSISTENT_RETRY_DELAYS_MS,
  DEMO_PERSISTENT_RETRY_POLICIES,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT,
  DEMO_RATE_LIMIT_PER_KEY,
  DEMO_RATE_LIMIT_POLICY_NAMESPACE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_RATE_LIMIT_SEED_JOBS,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_TIMING_POLICY_TIMEOUT_MS,
  DEMO_TIMING_TIMEOUT_MS,
  DEMO_HUMAN_WAIT_NAME,
  DEMO_SIGNAL_NAME,
  DEMO_WORKER_POLL_MS,
  DEMO_WORKER_CONCURRENCY,
  HISTORICAL_WORKER_IDS,
  DURABLE_TIMER_JOB_TYPE,
  DURABLE_TIMER_PREPARE_CHECKPOINT,
  DURABLE_TIMER_PUBLISH_CHECKPOINT,
  DURABLE_TIMER_WAIT_NAME,
  HEARTBEAT_SCHEDULE_NAME,
  installDemoSchema,
  LONG_RUNNING_SCHEDULE_NAME,
  REPORT_SCHEDULE_NAME,
  seedDemoData,
  syncDemoConcurrencyPolicies,
  syncDemoRateLimitPolicies,
  syncDemoSchedules,
} from "../src/app.js";
import type { CreateDemoApplicationOptions } from "../src/app.js";
import type { DashboardRouter } from "@workhorse-js/dashboard/server";
import { dashboardDatabase, readDashboardWorkers } from "@workhorse-js/dashboard/server";
import { DEMO_QUEUE_OPTIONS } from "../src/contracts.js";
import { durableDemoScenarios } from "../src/durable-demo.js";
import {
  DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT,
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  DEMO_FEATURE_SHOWCASE_SOURCE,
  demoFeatureShowcaseFamily,
  type DemoFeatureBehavior,
  type DemoFeatureFamily,
  type DemoFeaturePayload,
} from "../src/feature-showcase.js";
import { readIdempotencyEvidence, type DashboardWorkerRow } from "@workhorse-js/dashboard/wire";
import { createDemoWorkerDefinition } from "../src/worker-definition.js";

/**
 * These tests exercise the demo application, but they must never run against the demo database.
 *
 * `beforeAll` drops and reinstalls the schema, `beforeEach` truncates every table, and `afterAll`
 * drops the demo's own tables. Pointed at the demo database that is destructive to a demo someone
 * is watching: its data disappears mid-session and its tables are gone when the run ends. Worse in
 * the other direction, a running demo registers two workers of its own, and any assertion about the
 * fleet then sees extra workers beyond the demo workers the test started.
 */
const databaseUrl = localDatabaseUrl("test");
const hasDashboardBrowserBundle = existsSync(
  new URL("../../dashboard-server/dist/app/index.html", import.meta.url),
);
const dashboardBrowserTest = hasDashboardBrowserBundle ? it : it.skip;
const settingsDashboardTestName =
  "loads the settings dashboard route and its read model (requires the built dashboard browser bundle)";
const workspaceDashboardTestName =
  "serves two switchable workspaces when a staging database is configured (requires the built dashboard browser bundle)";
assertLocalDatabasePurpose(databaseUrl, "test");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const database = createDemoDatabase(pool);
const admin = new Admin(pool, DEMO_QUEUE, DEMO_QUEUE_OPTIONS);

/**
 * Slot use and operator pause both travel through the durable worker registry, so these tests need
 * a refresh cadence far shorter than the work they observe.
 */
const TEST_REGISTRY_INTERVAL_MS = 100;

/**
 * The identity shape a worker generates for itself: `<hostname>-<pid>-<8 hex>`.
 *
 * The demo names no workers, so tests assert the shape of a generated identity rather than a
 * literal an application chose.
 */
const GENERATED_WORKER_ID = /^\S+-\d+-[\da-f]{8}$/;

/**
 * Duration for jobs whose *transient* in-flight state a test asserts on.
 *
 * Reported slot use is only as fresh as the registry cadence, so a test that wants to observe
 * overlapping handlers has to keep them overlapping for many refresh cycles. Tuning this close to
 * the cadence makes the test race with load on the machine rather than with the behavior it checks.
 *
 * It also has to stay comfortably inside `waitFor`'s polling budget, because the same tests then
 * wait for those jobs to succeed. Ten registry refreshes is enough headroom for the first
 * constraint without approaching the second.
 */
const TEST_OBSERVABLE_JOB_MS = TEST_REGISTRY_INTERVAL_MS * 10;

/**
 * Applications created by the current test, stopped before the next one truncates.
 *
 * Worker registration is durable, so a worker still running from a previous test would re-register
 * itself after `beforeEach` truncates and pollute the next test's fleet view. Stopping is idempotent,
 * so tests that already stop their own runtime in a `finally` are unaffected.
 */
const runningApplications: Array<{ stop: () => Promise<void> }> = [];

interface DemoTestRuntimeOptions {
  workers?: boolean;
  rateLimitWorker?: boolean;
  onWorkerError?: (error: unknown) => void;
  workerPollMs?: number;
  registryIntervalMs?: number;
  maintenanceTaskPollMs?: number;
  longRunningJobMs?: number;
  durableStepMs?: number;
  durableTimerWaitMs?: number;
  onDurableStepOperation?: (
    scenario: keyof typeof durableDemoScenarios,
    stepName: string,
    attempt: number,
  ) => void;
  onDurableTimerOperation?: (
    operation: "prepare" | "publish",
    attempt: number,
    fenceToken: bigint,
  ) => void;
}

type TestApplicationOptions = CreateDemoApplicationOptions & DemoTestRuntimeOptions;

function createTestWorkerRuntime(options: DemoTestRuntimeOptions) {
  // The worker runtime shares the demo's queue options so contracted job types stay completable.
  const adapter = createDrizzleAdapter(database, {
    defaultQueue: DEMO_QUEUE,
    queueOptions: DEMO_QUEUE_OPTIONS,
  });
  const workers: Worker[] = [];
  const runs: Promise<void>[] = [];
  let started = false;
  let quiescePromise: Promise<void> | undefined;

  return {
    context: { admin: adapter.admin, queue: adapter.queue },
    start() {
      if (started) return;
      if (quiescePromise) throw new Error("A stopped test worker runtime cannot be restarted");
      started = true;
      if (options.workers === false) return;

      const definitions = [
        ...DEMO_WORKER_CONCURRENCY.map((concurrency) =>
          createDemoWorkerDefinition(database, adapter.queue, {
            concurrency,
            pollMs: options.workerPollMs ?? DEMO_WORKER_POLL_MS,
            maintenanceIntervalMs: options.maintenanceIntervalMs ?? DEMO_MAINTENANCE_INTERVAL_MS,
            maintenanceTaskPollMs: options.maintenanceTaskPollMs ?? DEMO_MAINTENANCE_TASK_POLL_MS,
            registryIntervalMs: options.registryIntervalMs,
            durableStepMs: options.durableStepMs,
            durableTimerWaitMs: options.durableTimerWaitMs,
            longRunningJobMs: options.longRunningJobMs,
            onDurableStepOperation: options.onDurableStepOperation,
            onDurableTimerOperation: options.onDurableTimerOperation,
          }),
        ),
        ...(options.rateLimitWorker
          ? [
              createDemoWorkerDefinition(database, adapter.queue, {
                queue: DEMO_RATE_LIMIT_QUEUE,
                scheduleNamespaces: [],
                concurrency: 1,
                pollMs: options.workerPollMs ?? DEMO_WORKER_POLL_MS,
                registryIntervalMs: options.registryIntervalMs,
              }),
            ]
          : []),
      ];
      for (const definition of definitions) {
        const worker = adapter.createWorker(definition.options);
        definition.configure(worker);
        workers.push(worker);
        runs.push(
          worker.run().catch((error: unknown) => {
            options.onWorkerError?.(error);
          }),
        );
      }
    },
    quiesce() {
      quiescePromise ??= (async () => {
        for (const worker of workers) worker.stop();
        await Promise.all(runs);
      })();
      return quiescePromise;
    },
    stop() {
      return this.quiesce();
    },
  };
}

function createTestApplication(options: TestApplicationOptions = {}) {
  const resolved = {
    workerPollMs: 15,
    registryIntervalMs: TEST_REGISTRY_INTERVAL_MS,
    longRunningJobMs: 25,
    durableStepMs: 0,
    ...options,
  };
  const application = createDemoApplication(database, resolved);
  const workhorse = createTestWorkerRuntime(resolved);
  runningApplications.push(workhorse);
  return { ...application, workhorse };
}

beforeAll(async () => {
  await pool.query("DROP SCHEMA IF EXISTS workhorse CASCADE");
  await installSchema(pool);
  await installDemoSchema(database);
});

beforeEach(async () => {
  // Stop any worker left running by the previous test before truncating, so a straggler cannot
  // re-register itself into the fleet view this test is about to assert on.
  await Promise.all(runningApplications.splice(0).map((workhorse) => workhorse.stop()));
  await pool.query(`TRUNCATE public.workhorse_demo_audit, public.workhorse_demo_seed, public.workhorse_demo_order, workhorse.job_event,
    workhorse.job_wait, workhorse.job_checkpoint, workhorse.attempt_history, workhorse.schedule_occurrence, workhorse.schedule_definition,
    workhorse.queue_control, workhorse.rate_limit_bucket, workhorse.rate_limit_policy,
    workhorse.concurrency_policy, workhorse.worker_registry,
    workhorse.enqueue_idempotency, workhorse.job_outcome, workhorse.job_runtime,
    workhorse.job_stat_bucket, workhorse.job RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE workhorse.job_stat_state SET
    rolled_up_through = date_bin('1 minute', clock_timestamp(), timestamp with time zone '2000-01-01'),
    last_run_at = NULL, updated_at = clock_timestamp()`);
  await new Queue(pool).syncRetentionPolicy({
    jobIdentityRetentionDays: null,
    terminalOutcomeRetentionDays: null,
    jobEventRetentionDays: null,
    attemptHistoryRetentionDays: null,
    scheduleOccurrenceRetentionDays: 30,
    statisticsRetentionDays: 14,
    terminalJobPruneLimit: 1_000,
    historyPartitionsPerPass: 4,
    defaultPartitionRowsPerPass: 10_000,
    occurrenceRowsPerPass: 10_000,
    statisticsRowsPerPass: 10_000,
  });
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_order");
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_seed");
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_audit");
  await pool.query("DROP TABLE IF EXISTS public.workhorse_demo_schema_version");
  await pool.end();
});

function dashboardClient(
  app: ReturnType<typeof createDemoApplication>["app"],
  rpcPath = "/rpc",
  origins: { browser: string; upstream: string } = {
    browser: "http://demo.test",
    upstream: "http://demo.test",
  },
): RouterClient<DashboardRouter> {
  return createORPCClient(
    new RPCLink({
      url: `${origins.browser}${rpcPath}`,
      fetch: (request) => {
        const browserUrl = new URL(request.url);
        const forwarded = new Request(
          new URL(`${browserUrl.pathname}${browserUrl.search}`, origins.upstream),
          request,
        );
        forwarded.headers.set("origin", origins.browser);
        return app.request(forwarded);
      },
    }),
  );
}

it("reports readiness outside the dashboard route space", async () => {
  const { app } = createTestApplication({ workers: false });

  const response = await app.request("/up");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "ok" });
});

it("disallows crawler indexing across the public demo", async () => {
  const { app } = createTestApplication({ workers: false });

  const readiness = await app.request("/up");
  expect(readiness.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");

  const robots = await app.request("/robots.txt");
  expect(robots.status).toBe(200);
  expect(robots.headers.get("content-type")).toContain("text/plain");
  expect(robots.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  await expect(robots.text()).resolves.toBe("User-agent: *\nDisallow: /\n");

  const dashboard = await app.request("/");
  expect(dashboard.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
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

let demoTestRequest = 0;
async function enqueueDemoTest(
  kind: "success" | "retry" | "durable" | "timer" | "failure" | "idempotent" | "long-running",
  scenario?: keyof typeof durableDemoScenarios,
) {
  demoTestRequest += 1;
  return createLocalOperator(database).enqueueTest!(
    kind,
    {
      actor: "integration-test",
      reason: `exercise ${kind} worker behavior`,
      requestId: `integration-${kind}-${demoTestRequest}`,
    },
    scenario,
  );
}

/**
 * Poll a read model until it satisfies a predicate. The demo has no synchronous hook into worker
 * slot transitions, so the tests bound the wait instead of sleeping for a fixed guessed duration.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  attempts = 200,
): Promise<T> {
  let latest = await read();
  for (let attempt = 0; attempt < attempts && !matches(latest); attempt += 1) {
    await sleep(5);
    latest = await read();
  }
  expect(matches(latest)).toBe(true);
  return latest;
}

async function waitForWorker(
  client: RouterClient<DashboardRouter>,
  workerId: string,
  matches: (worker: DashboardWorkerRow) => boolean,
): Promise<DashboardWorkerRow> {
  const page = await waitFor(
    () => client.dashboard.workers(),
    (value) => {
      const worker = value.workers.find((candidate) => candidate.id === workerId);
      return worker !== undefined && matches(worker);
    },
  );
  return page.workers.find((candidate) => candidate.id === workerId)!;
}

/**
 * Wait for the demo workers to announce themselves and return one of them.
 *
 * The demo does not name its workers, exactly as a real deployment usually does not, so tests have
 * to discover the fleet from the registry rather than assume an identity.
 */
async function waitForRegisteredWorker(
  client: RouterClient<DashboardRouter>,
): Promise<DashboardWorkerRow> {
  const page = await waitFor(
    () => client.dashboard.workers(),
    (value) =>
      value.workers.filter((worker) => worker.registered).length === DEMO_WORKER_CONCURRENCY.length,
  );
  const registered = page.workers.filter((worker) => worker.registered);
  const defaultQueueWorker = registered.find((worker) => worker.concurrency === 3);
  expect(defaultQueueWorker, "a worker with three declared slots").toBeDefined();
  return defaultQueueWorker!;
}

function showcaseTestPayload(
  family: DemoFeatureFamily,
  scenario: string,
  behavior: DemoFeatureBehavior,
  extra: Partial<DemoFeaturePayload> = {},
): DemoFeaturePayload {
  return {
    source: DEMO_FEATURE_SHOWCASE_SOURCE,
    family,
    scenario,
    behavior,
    label: `${scenario} test`,
    durationMs: null,
    waitMs: null,
    checkpointCount: null,
    waitMode: null,
    waitTimeoutMs: null,
    childCount: null,
    role: null,
    memberIndex: null,
    shouldFail: null,
    invoiceId: null,
    ...extra,
  };
}

async function jobResult(jobId: string): Promise<Json | null> {
  const rows = await pool.query<{ result: Json | null }>(
    "SELECT result FROM workhorse.job_outcome WHERE job_id = $1",
    [jobId],
  );
  return rows.rows[0]?.result ?? null;
}

const waitForJobState = (admin: Admin, jobId: string, state: string) =>
  waitFor(
    async () => (await admin.getJob(jobId))?.state,
    (value) => value === state,
    1_600,
  );

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

  it("migrates legacy showcase jobs to their family task types", async () => {
    const queue = new Queue(pool, { defaultQueue: DEMO_QUEUE });
    const jobIds = await Promise.all(
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
        `SELECT payload->>'family' AS family, job_type
           FROM workhorse.job
          WHERE id = ANY($1::uuid[])
          ORDER BY payload->>'family'`,
        [jobIds],
      ),
    ).toMatchObject({
      rows: [...DEMO_FEATURE_SHOWCASE_FAMILIES]
        .toSorted((left, right) => left.key.localeCompare(right.key))
        .map((family) => ({ family: family.key, job_type: family.jobType })),
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
        `SELECT schedule_name, cron_expression, job_type, enabled
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
          job_type: "demo.long-running",
          enabled: true,
        },
        {
          schedule_name: REPORT_SCHEDULE_NAME,
          cron_expression: "*/5 * * * *",
          job_type: "demo.report",
          enabled: true,
        },
        {
          schedule_name: HEARTBEAT_SCHEDULE_NAME,
          cron_expression: "* * * * *",
          job_type: "demo.recurring",
          enabled: true,
        },
        ...DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => ({
          schedule_name: family.scheduleName,
          cron_expression: family.schedule,
          job_type: family.jobType,
          enabled: true,
        })).toSorted((left, right) => left.schedule_name.localeCompare(right.schedule_name)),
      ],
    });
  });

  it("seeds representative dashboard data exactly once", async () => {
    const { app } = createTestApplication();

    const seeded = await seedDemoData(database);
    expect(seeded).toMatchObject({ seeded: true, historicalJobCount: 362 });
    expect(seeded.jobIds).toHaveLength(86);
    expect(await seedDemoData(database)).toEqual({
      seeded: false,
      jobIds: [],
      historicalJobCount: 0,
    });
    expect(
      await pool.query(
        `SELECT array_agg(DISTINCT version ORDER BY version) AS versions
           FROM (
             -- Throttled acceptance runs inside a SQL exception block, so those rows carry
             -- subtransaction xids of the same showcase transaction rather than its top-level id.
             SELECT xmin::text AS version FROM workhorse.job
               WHERE id = ANY($1::uuid[])
                 AND job_type NOT IN ('demo.long-running', 'demo.keyed-throttle')
             UNION ALL SELECT xmin::text FROM public.workhorse_demo_order
            UNION ALL SELECT xmin::text FROM public.workhorse_demo_seed
               WHERE name = 'default-dashboard-v8'
           ) representative_rows`,
        [seeded.jobIds],
      ),
    ).toMatchObject({
      rows: [{ versions: [expect.any(String), expect.any(String), expect.any(String)] }],
    });
    expect(
      await pool.query("SELECT count(*)::integer AS count FROM public.workhorse_demo_order"),
    ).toMatchObject({ rows: [{ count: 1 }] });
    expect(await pool.query("SELECT count(*)::integer AS count FROM workhorse.job")).toMatchObject({
      rows: [{ count: 448 }],
    });
    const blockedTasks = await dashboardClient(app).dashboard.tasks({
      filter: "blocked",
      page: 1,
      pageSize: 25,
    });
    expect(blockedTasks.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "blocked",
          blockedReason: "prerequisite_pending",
          payload: expect.objectContaining({
            family: "job-dependencies",
            scenario: "release-after-success",
            role: "dependent",
          }),
        }),
      ]),
    );
    const visibleBlockedTask = blockedTasks.jobs.find(
      (job) =>
        job.payload &&
        typeof job.payload === "object" &&
        "scenario" in job.payload &&
        job.payload.scenario === "release-after-success",
    );
    expect(visibleBlockedTask).toBeDefined();
    const scheduledTasks = await dashboardClient(app).dashboard.tasks({
      filter: "scheduled",
      page: 1,
      pageSize: 25,
    });
    expect(scheduledTasks.jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining(visibleBlockedTask!.prerequisiteJobIds),
    );
    const retainedPrerequisite = scheduledTasks.jobs.find((job) =>
      visibleBlockedTask!.prerequisiteJobIds.includes(job.id),
    );
    expect(retainedPrerequisite?.runAt).toBe("9999-12-31T23:59:59.999Z");
    expect(
      await pool.query(
        `SELECT payload->>'family' AS family,
                job_type,
                count(DISTINCT payload->>'scenario')::integer AS scenarios
           FROM workhorse.job
          WHERE payload->>'source' = $1
          GROUP BY payload->>'family', job_type
          ORDER BY payload->>'family'`,
        [DEMO_FEATURE_SHOWCASE_SOURCE],
      ),
    ).toMatchObject({
      rows: [...DEMO_FEATURE_SHOWCASE_FAMILIES]
        .toSorted((left, right) => left.key.localeCompare(right.key))
        .map((family) => ({ family: family.key, job_type: family.jobType, scenarios: 3 })),
    });
    expect(DEMO_FEATURE_SHOWCASE_EXAMPLE_COUNT).toBe(51);
    expect(
      await pool.query(
        `SELECT count(*)::integer AS count
           FROM workhorse.job job
           JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
          WHERE job.job_type = 'demo.cancellation'
            AND job.payload->>'family' = 'cancellation'
            AND outcome.state = 'canceled'`,
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
    expect(
      await pool.query(
        `SELECT count(*)::integer AS count,
                count(DISTINCT source_job_id)::integer AS sources,
                count(DISTINCT target_job_id)::integer AS targets
           FROM workhorse.job_redrive
          WHERE requested_by = 'demo-seed'`,
      ),
    ).toMatchObject({ rows: [{ count: 2, sources: 2, targets: 2 }] });
    expect(
      await pool.query(
        `SELECT job.payload, job.concurrency_key, job.max_attempts, job.tags, runtime.state,
                runtime.run_at > clock_timestamp() AS is_future
           FROM workhorse.job job
           JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
          WHERE job_type = 'demo.long-running' AND payload->>'source' = 'long-running-seed'
          ORDER BY payload->>'label'`,
      ),
    ).toMatchObject({
      rows: DEMO_LONG_RUNNING_SEED_JOBS.map(({ label, concurrencyKey }) => ({
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
        `SELECT job.payload, job.max_attempts,
                job.execution_timeout_ms::integer AS execution_timeout_ms,
                job.deadline_at IS NOT NULL AS has_deadline,
                COALESCE(runtime.state, outcome.state) AS state,
                CASE WHEN runtime.run_at IS NULL THEN NULL
                     ELSE job.deadline_at > runtime.run_at END AS deadline_after_run_at,
                job.tags
           FROM workhorse.job job
           LEFT JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
           LEFT JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
          WHERE job.job_type = 'demo.timing-policy'
          ORDER BY job.payload->>'source'`,
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
      total: 448,
      counts: { all: 448, scheduled: 10, queued: 62, completed: 350, discarded: 21 },
    });
    expect(firstPage.jobs).toHaveLength(25);
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
      jobTypes: expect.arrayContaining(["demo.report", "order.process"]),
      tags: expect.arrayContaining(["billing", "email", "reports", "weekly"]),
    });
    expect(firstPage.jobs.some((job) => job.tags.length > 0)).toBe(true);
    expect(secondPage).toMatchObject({ filter: "all", page: 2, pageSize: 25, total: 448 });
    expect(secondPage.jobs).toHaveLength(25);
    expect(
      await client.dashboard.tasks({ filter: "scheduled", page: 1, pageSize: 25 }),
    ).toMatchObject({
      filter: "scheduled",
      total: 10,
      jobs: expect.arrayContaining([
        expect.objectContaining({ state: "scheduled", payload: { source: "scheduled-seed" } }),
      ]),
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
      worker: HISTORICAL_WORKER_IDS[0],
    });
    expect(workerFiltered.jobs.every((job) => job.lastWorkerId === HISTORICAL_WORKER_IDS[0])).toBe(
      true,
    );
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
      worker: HISTORICAL_WORKER_IDS[0],
      jobType: "email.send",
      tags: ["email"],
    });
    expect(combined.total).toBeGreaterThan(0);
    expect(
      combined.jobs.every(
        (job) =>
          job.queue === "emails" &&
          job.lastWorkerId === HISTORICAL_WORKER_IDS[0] &&
          job.type === "email.send" &&
          job.tags.includes("email"),
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
    expect(priorityFiltered.jobs.every((job) => job.priority === 90)).toBe(true);

    const prioritySorted = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 100,
      sort: "priority",
    });
    expect(prioritySorted).toMatchObject({ priority: null, sort: "priority" });
    const sortedPriorities = prioritySorted.jobs.map((job) => job.priority);
    expect(sortedPriorities).toEqual(sortedPriorities.toSorted((left, right) => right - left));
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
        "demo.job-dependency",
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

    await expect(new Queue(pool).concurrencyPolicies(["demo"])).resolves.toEqual([
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
           FROM workhorse.job
          WHERE job_type = 'demo.long-running'
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
         FROM workhorse.job
        WHERE job_type = 'demo.long-running'
          AND payload->>'source' = 'long-running-seed'`,
    );
    const idByLabel = new Map(examples.rows.map((row) => [row.label, row.id]));
    const keyById = new Map(examples.rows.map((row) => [row.id, row.concurrency_key]));
    const exampleIds = examples.rows.map((row) => row.id);
    await pool.query(
      `UPDATE workhorse.job_runtime
          SET state = 'scheduled', run_at = clock_timestamp() + interval '1 day',
              ready_at = NULL, sequence = NULL, worker_id = NULL, acquired_at = NULL,
              heartbeat_at = NULL, expires_at = NULL, attempt_timeout_at = NULL,
              fence_token = 0, wait_name = NULL, attempt_started_at = NULL,
              cancel_requested_at = NULL, cancel_requested_by = NULL, cancel_reason = NULL`,
    );
    await pool.query(
      `UPDATE workhorse.job_runtime
          SET state = 'ready', run_at = clock_timestamp(), ready_at = clock_timestamp(),
              sequence = nextval('workhorse.ready_sequence_seq')
        WHERE job_id = ANY($1::uuid[])`,
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

  it("seeds a visibly throttled partner API queue", async () => {
    await syncDemoRateLimitPolicies(pool);
    await seedDemoData(database);

    await expect(new Queue(pool).rateLimitPolicies([DEMO_RATE_LIMIT_QUEUE])).resolves.toEqual([
      expect.objectContaining({
        namespace: DEMO_RATE_LIMIT_POLICY_NAMESPACE,
        queue: DEMO_RATE_LIMIT_QUEUE,
        rate: DEMO_RATE_LIMIT,
        perKey: DEMO_RATE_LIMIT_PER_KEY,
      }),
    ]);
    await expect(
      pool.query(
        `SELECT runtime.state, job.concurrency_key, count(*)::integer AS count
           FROM workhorse.job job
           JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
          WHERE job.payload->>'source' = 'rate-limit-seed'
          GROUP BY runtime.state, job.concurrency_key
          ORDER BY job.concurrency_key`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { state: "ready", concurrency_key: "customer-acme", count: 2 },
        { state: "ready", concurrency_key: "customer-globex", count: 1 },
      ],
    });
    expect(DEMO_RATE_LIMIT_SEED_JOBS).toHaveLength(5);
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
               FROM workhorse.job job
               JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
              WHERE job.payload->>'source' = 'rate-limit-seed'
                AND outcome.state = 'succeeded'`,
          );
          return result.rows[0]!.count;
        },
        (count) => count === 4,
      );
      await expect(
        pool.query(
          `SELECT count(*)::integer AS count
             FROM workhorse.job job
             JOIN workhorse.job_runtime runtime ON runtime.job_id = job.id
            WHERE job.payload->>'source' = 'rate-limit-seed' AND runtime.state = 'ready'`,
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
      `SELECT id::text FROM workhorse.job
        WHERE job_type = 'demo.timing-policy'
          AND payload->>'source' = 'execution-timeout-seed'`,
    );
    const jobId = seeded.rows[0]!.id;
    workhorse.start();

    try {
      let job = await workhorse.context.admin.getJob(jobId);
      for (let attempt = 0; attempt < 240 && job?.state !== "failed"; attempt += 1) {
        await sleep(25);
        job = await workhorse.context.admin.getJob(jobId);
      }
      expect(job).toMatchObject({
        state: "failed",
        currentAttempt: 1,
        error: { name: "ExecutionTimeout" },
      });
      await expect(
        pool.query(
          `SELECT outcome FROM workhorse.attempt_history
            WHERE job_id = $1 ORDER BY attempt`,
          [jobId],
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
      job_id: string;
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
          SELECT job.id AS job_id, job.payload->>'scenario' AS scenario,
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
    const readPersistentCheckpoints = async () =>
      (
        await pool.query<PersistentCheckpointRow>(`
          SELECT job.payload->>'scenario' AS scenario, checkpoint.checkpoint_name,
                 checkpoint.checkpoint_value, checkpoint.attempt,
                 checkpoint.fence_token::text, checkpoint.worker_id
            FROM workhorse.job_checkpoint checkpoint
            JOIN workhorse.job job ON job.id = checkpoint.job_id
           WHERE job.payload->>'source' = 'persistent-failure-seed'
           ORDER BY CASE job.payload->>'scenario'
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
        UPDATE workhorse.job_runtime runtime
           SET run_at = clock_timestamp()
          FROM workhorse.job job
         WHERE runtime.job_id = job.id
           AND runtime.state = 'scheduled'
           AND job.payload->>'source' = 'persistent-failure-seed'
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
            SELECT job.payload->>'scenario' AS scenario, history.attempt, history.outcome
              FROM workhorse.attempt_history history
              JOIN workhorse.job job ON job.id = history.job_id
             WHERE job.payload->>'source' = 'persistent-failure-seed'
             ORDER BY CASE job.payload->>'scenario'
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
      expect(retried.jobs).toEqual(
        expect.arrayContaining(
          DEMO_PERSISTENT_RETRY_DELAYS_MS.map((retryDelayMs, index) =>
            expect.objectContaining({
              state: "scheduled",
              attempt: 3,
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
      for (const [index, row] of secondAttemptRows.entries()) {
        const expected = persistentScenarios[index]!;
        const detail = await client.dashboard.jobDetail({ id: row.job_id });
        expect(detail).toMatchObject({
          identity: {
            id: row.job_id,
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

  it("retries an intentional handler failure and exposes both attempts in the dashboard", async () => {
    const { app, workhorse } = createTestApplication();
    workhorse.start();

    try {
      const accepted = {
        ...(await enqueueDemoTest("retry")),
        expectedAttempts: 2,
        expectedCheckpoint: "reserve-capacity",
      };
      expect(accepted.expectedAttempts).toBe(2);
      expect(accepted.expectedCheckpoint).toBe("reserve-capacity");

      let job: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && job?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        job = (await workhorse.context.admin.getJob(accepted.jobId)) as typeof job;
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
          worker_id: expect.stringMatching(GENERATED_WORKER_ID),
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
      const workers = await client.dashboard.workers();
      expect(workers.workers).toHaveLength(DEMO_WORKER_CONCURRENCY.length);
      expect(workers.workers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(GENERATED_WORKER_ID),
            registered: true,
          }),
        ]),
      );
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
            workerId: expect.stringMatching(GENERATED_WORKER_ID),
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
      const accepted = {
        ...(await enqueueDemoTest("timer")),
        expectedAttempt: 1,
        prepareCheckpoint: DURABLE_TIMER_PREPARE_CHECKPOINT,
        waitName: DURABLE_TIMER_WAIT_NAME,
        publishCheckpoint: DURABLE_TIMER_PUBLISH_CHECKPOINT,
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
          worker_id: expect.stringMatching(GENERATED_WORKER_ID),
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
            fenceToken: bigint;
            result: Record<string, unknown>;
          }
        | undefined;
      for (let poll = 0; poll < 200 && finalJob?.state !== "succeeded"; poll += 1) {
        await sleep(10);
        finalJob = (await workhorse.context.admin.getJob(accepted.jobId)) as typeof finalJob;
      }
      expect(finalJob).toMatchObject({
        state: "succeeded",
        currentAttempt: 1,
        result: {
          source: "operator",
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
      expect(finalJob!.fenceToken).toBe(BigInt(secondFence));
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
      const accepted = {
        ...(await enqueueDemoTest("durable", "order-fulfillment")),
        scenario: "order-fulfillment",
        checkpointPlan: [
          "validate-order",
          "reserve-inventory",
          "authorize-payment",
          "arrange-shipment",
        ],
        expectedAttempts: 2,
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
        job = (await workhorse.context.admin.getJob(accepted.jobId)) as typeof job;
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
    const { workhorse } = createTestApplication({
      onDurableStepOperation(scenario, stepName, attempt) {
        operations.push(`${scenario}:${stepName}:${attempt}`);
      },
    });
    workhorse.start();

    try {
      const accepted = await enqueueDemoTest("durable", example.scenario);
      let job: { state: string; currentAttempt: number; result: unknown } | undefined;
      for (let attempt = 0; attempt < 80 && job?.state !== "succeeded"; attempt += 1) {
        await sleep(25);
        job = (await workhorse.context.admin.getJob(accepted.jobId)) as typeof job;
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
      const accepted = await enqueueDemoTest("failure");

      let state: string | undefined;
      for (let attempt = 0; attempt < 40 && state !== "failed"; attempt += 1) {
        await sleep(25);
        state = (await workhorse.context.admin.getJob(accepted.jobId))?.state;
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
        status: { level: "healthy", reasons: [] },
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
        state = jobId ? (await workhorse.context.admin.getJob(jobId))?.state : undefined;
      }
      expect(jobId).toBeDefined();
      expect(state).toBe("succeeded");

      const longRunningJob = await waitFor(
        async () => {
          const occurrence = await pool.query<{ job_id: string | null }>(
            `SELECT job_id FROM workhorse.schedule_occurrence
              WHERE namespace = $1 AND schedule_name = $2
              ORDER BY occurrence_at DESC LIMIT 1`,
            [DEMO_SCHEDULE_NAMESPACE, LONG_RUNNING_SCHEDULE_NAME],
          );
          const recurringJobId = occurrence.rows[0]?.job_id;
          return recurringJobId ? workhorse.context.admin.getJob(recurringJobId) : null;
        },
        (job) => job?.state === "succeeded",
      );
      expect(longRunningJob).toMatchObject({ type: "demo.long-running", state: "succeeded" });

      const client = dashboardClient(app);
      const cron = await client.dashboard.cron();
      expect(cron.schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            namespace: DEMO_SCHEDULE_NAMESPACE,
            name: HEARTBEAT_SCHEDULE_NAME,
            occurrenceCount: 1,
          }),
          expect.objectContaining({
            namespace: DEMO_SCHEDULE_NAMESPACE,
            name: LONG_RUNNING_SCHEDULE_NAME,
            occurrenceCount: 1,
          }),
        ]),
      );
      const completed = await client.dashboard.tasks({
        filter: "completed",
        page: 1,
        pageSize: 25,
      });
      expect(completed.jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: jobId, type: "demo.recurring", state: "succeeded" }),
          expect.objectContaining({
            type: "demo.long-running",
            state: "succeeded",
          }),
        ]),
      );
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
        workerId: "any-worker",
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
        progress: {
          value: { phase: "complete", completed: 250, total: 250 },
          revision: "2",
          attempt: 1,
        },
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
      priority: 73,
      audit: {
        actor: "operator",
        reason: "show durable checkpoint reuse",
        requestId: "audit-checkpoint-retry",
      },
    });

    expect(await client.dashboard.jobDetail({ id: enqueued.jobId })).toMatchObject({
      identity: { id: enqueued.jobId, type: "demo.retry", state: "ready", priority: 73 },
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
    expect(
      (await client.dashboard.system({ window: "1h" })).queues.find(
        (row) => row.queue === DEMO_QUEUE,
      )?.priorityBacklog,
    ).toContainEqual(expect.objectContaining({ priority: 73, ready: 1 }));
    await expect(
      client.dashboard.enqueueTest({
        kind: "success",
        priority: 101,
        audit: {
          actor: "operator",
          reason: "reject invalid priority",
          requestId: "invalid-priority",
        },
      }),
    ).rejects.toThrow(/input validation/i);

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

  it("enqueues the declared live example for a feature family with its audit trail", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);

    const contract = await client.dashboard.enqueueTest({
      kind: "feature",
      feature: "payload-contracts",
      priority: 12,
      audit: {
        actor: "operator",
        reason: "show contract validation",
        requestId: "audit-feature-contract",
      },
    });
    expect(await client.dashboard.jobDetail({ id: contract.jobId })).toMatchObject({
      identity: {
        id: contract.jobId,
        type: "demo.contract-check",
        state: "ready",
        priority: 12,
      },
      payload: {
        source: "feature-showcase-operator",
        family: "payload-contracts",
        scenario: "validated-acceptance",
        invoiceId: "INV-validated-acceptance",
      },
    });
    expect(
      await pool.query(
        `SELECT action, target, after FROM public.workhorse_demo_audit WHERE request_id = $1`,
        ["audit-feature-contract"],
      ),
    ).toMatchObject({
      rows: [
        {
          action: "enqueueTest",
          target: "job:feature:payload-contracts",
          after: expect.objectContaining({ jobId: contract.jobId, memberCount: 1 }),
        },
      ],
    });

    // The batch example accepts its whole member group in one click, so a digest can form.
    const batch = await client.dashboard.enqueueTest({
      kind: "feature",
      feature: "batch-handlers",
      audit: {
        actor: "operator",
        reason: "show one grouped digest",
        requestId: "audit-feature-batch",
      },
    });
    expect(batch.jobId).toEqual(expect.any(String));
    expect(
      await pool.query(
        `SELECT count(*)::integer AS members FROM workhorse.job
          WHERE job_type = 'demo.batch-digest'
            AND payload->>'source' = 'feature-showcase-operator'`,
      ),
    ).toMatchObject({ rows: [{ members: 3 }] });

    await expect(
      client.dashboard.enqueueTest({
        kind: "feature",
        audit: {
          actor: "operator",
          reason: "reject a missing family",
          requestId: "audit-feature-missing",
        },
      }),
    ).rejects.toThrow(/input validation/i);
  });

  it("runs an operator feature example through the ordinary worker path", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "feature",
        feature: "ingress-routing",
        audit: {
          actor: "operator",
          reason: "run one live ingress example",
          requestId: "audit-feature-ingress",
        },
      });
      let detail = await client.dashboard.jobDetail({ id: enqueued.jobId });
      for (let attempt = 0; attempt < 200 && detail.identity.state !== "succeeded"; attempt += 1) {
        await sleep(10);
        detail = await client.dashboard.jobDetail({ id: enqueued.jobId });
      }
      expect(detail).toMatchObject({
        identity: { id: enqueued.jobId, type: "demo.ingress-routing", state: "succeeded" },
        payload: {
          source: "feature-showcase-operator",
          family: "ingress-routing",
          scenario: "immediate-tagged",
        },
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
        actor: "local-demo",
        reason: "smoke enqueue",
        request_id: "audit-enqueue",
        before: null,
        after: expect.objectContaining({ jobId: enqueued.jobId }),
        status: "succeeded",
      },
      {
        action: "setScheduleEnabled",
        target: `schedule:${DEMO_SCHEDULE_NAMESPACE}:${REPORT_SCHEDULE_NAME}`,
        actor: "local-demo",
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
      // Workers are unnamed, so the fleet is discovered from the registry rather than assumed.
      const defaultQueueWorker = await waitForRegisteredWorker(client);
      const workerId = defaultQueueWorker.id;
      expect(defaultQueueWorker).toMatchObject({
        paused: false,
        registered: true,
        lastHeartbeatAt: expect.any(String),
      });
      await expect(client.dashboard.workers()).resolves.toMatchObject({ canManageWorkers: true });
      await expect(
        client.dashboard.setWorkerPaused({
          workerId,
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
          expect.objectContaining({
            id: workerId,
            paused: true,
            registered: true,
            lastHeartbeatAt: expect.any(String),
          }),
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
          target: `worker:${workerId}`,
          actor: "local-demo",
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

  it("declares deterministic demo worker concurrency and projects it through RPC", async () => {
    expect(DEMO_WORKER_CONCURRENCY).toEqual([3, 3]);

    const { app, workhorse } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    // Declared concurrency travels through the durable registry rather than a process-local Worker
    // object, and the workers are unnamed, so the fleet is discovered rather than looked up by id.
    workhorse.start();

    try {
      const defaultQueueWorker = await waitForRegisteredWorker(client);
      expect(defaultQueueWorker).toMatchObject({
        concurrency: 3,
        activeSlots: 0,
        activeJobs: 0,
        paused: false,
        draining: false,
      });
      // Generated identities, not names the application chose.
      expect(defaultQueueWorker.id).toMatch(/^\S+-\d+-[\da-f]{8}$/);
    } finally {
      await workhorse.stop();
    }
  });

  it("reports overlapping slots and keeps active work running when a worker is paused", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningJobMs: TEST_OBSERVABLE_JOB_MS,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      // Wait for both unnamed workers before enqueueing enough work to fill either worker's slots.
      await waitForRegisteredWorker(client);

      const enqueued = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          client.dashboard.enqueueTest({
            kind: "long-running",
            audit: {
              actor: "operator",
              reason: "fill slots",
              requestId: `slots-${index + 1}`,
            },
          }),
        ),
      );

      const busyFleet = await waitFor(
        () => client.dashboard.workers(),
        (page) => page.workers.some((worker) => worker.activeSlots === 3),
      );
      const overlapped = busyFleet.workers.find((worker) => worker.activeSlots === 3)!;
      expect(overlapped).toMatchObject({ concurrency: 3, activeSlots: 3, paused: false });
      // SQL-observed active jobs and in-process slots describe the same overlap from two sources.
      expect(overlapped.activeJobs).toBe(3);

      await expect(
        client.dashboard.setWorkerPaused({
          workerId: overlapped.id,
          paused: true,
          audit: { actor: "operator", reason: "pause while busy", requestId: "slots-pause" },
        }),
      ).resolves.toEqual({ paused: true });

      // Pause stops new claims only, so both in-flight handlers keep their slots.
      const paused = (await client.dashboard.workers()).workers.find(
        (worker) => worker.id === overlapped.id,
      );
      expect(paused).toMatchObject({ paused: true, activeSlots: 3, concurrency: 3 });

      for (const { jobId } of enqueued) {
        const detail = await waitFor(
          () => client.dashboard.jobDetail({ id: jobId }),
          (value) => value.identity.state === "succeeded",
        );
        expect(detail.identity.state).toBe("succeeded");
      }

      const drained = await waitForWorker(
        client,
        overlapped.id,
        (worker) => worker.activeSlots === 0,
      );
      expect(drained).toMatchObject({ paused: true, activeSlots: 0, draining: false });

      expect(
        (
          await pool.query(
            `SELECT target, before, after FROM public.workhorse_demo_audit
              WHERE request_id = 'slots-pause'`,
          )
        ).rows,
      ).toEqual([
        {
          target: `worker:${overlapped.id}`,
          before: { paused: false },
          after: { paused: true },
        },
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("reports unknown capacity for a declared worker that has never registered", async () => {
    // The demo declares no fleet, because real deployments do not name their workers. Hosts that do
    // declare one still get an expected-but-never-started worker rendered with unknown capacity
    // rather than an implied zero or one slot.
    await expect(
      readDashboardWorkers(dashboardDatabase(pool), ["expected-worker-a", "expected-worker-b"]),
    ).resolves.toMatchObject({
      canManageWorkers: false,
      workers: [
        {
          id: "expected-worker-a",
          registered: false,
          concurrency: null,
          activeSlots: null,
          draining: false,
          lastHeartbeatAt: null,
        },
        {
          id: "expected-worker-b",
          registered: false,
          concurrency: null,
          activeSlots: null,
          draining: false,
          lastHeartbeatAt: null,
        },
      ],
    });
  });

  it("reports declared capacity and slot use in the snapshot from the durable registry", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningJobMs: TEST_OBSERVABLE_JOB_MS,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: { actor: "operator", reason: "snapshot capacity", requestId: "snapshot-slots" },
      });
      await waitFor(
        () => client.dashboard.workers(),
        (page) => page.workers.some((worker) => worker.activeSlots === 1),
      );

      // No declared fleet is configured: the page discovers workers from the registry alone. The
      // read is a pure SQL projection with no process-local worker handle, yet it still reports
      // declared capacity and slot use because workers publish both to the durable registry.
      // SQL-observed active jobs remain a separate, independently sourced number.
      const page = await client.dashboard.workers();
      expect(page.workers.map((worker) => worker.activeJobs).reduce((a, b) => a + b, 0)).toBe(1);
      expect(page.workers).toHaveLength(DEMO_WORKER_CONCURRENCY.length);
      expect(page.workers.map((worker) => worker.concurrency)).toEqual([3, 3]);
      for (const worker of page.workers) {
        expect(worker).toMatchObject({ registered: true, draining: false });
        expect(worker.activeSlots).not.toBeNull();
      }
    } finally {
      await workhorse.stop();
    }
  });

  it("reports a worker as draining while shutdown waits on an in-flight handler", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningJobMs: TEST_OBSERVABLE_JOB_MS,
    });
    const client = dashboardClient(app);
    workhorse.start();
    let quiesced: Promise<void> | null = null;

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: { actor: "operator", reason: "observe draining", requestId: "drain-one" },
      });
      const busy = await waitFor(
        () => client.dashboard.workers(),
        (page) => page.workers.some((worker) => worker.activeSlots === 1),
      );
      const busyWorker = busy.workers.find((worker) => worker.activeSlots === 1)!;
      expect(busyWorker.draining).toBe(false);

      // quiesce stops claiming immediately and then waits for the running handler to finish.
      quiesced = workhorse.quiesce();
      const draining = await waitForWorker(
        client,
        busyWorker.id,
        (worker) => worker.draining || worker.activeSlots === 0,
      );
      expect(draining).toMatchObject({ draining: true, activeSlots: 1 });

      await quiesced;
      quiesced = null;
      await expect(client.dashboard.jobDetail({ id: enqueued.jobId })).resolves.toMatchObject({
        identity: { state: "succeeded" },
      });
      // A drained worker has stopped, so it deregisters. The demo declares no expected fleet, so it
      // simply leaves the list rather than lingering as an offline row nobody asked for.
      const afterDrain = await client.dashboard.workers();
      expect(afterDrain.workers.map((worker) => worker.id)).not.toContain(busyWorker.id);
    } finally {
      if (quiesced) await quiesced;
      await workhorse.stop();
    }
  });

  it("reads queue stats and audits pause, resume, and safe purge mutations", async () => {
    const queueName = "managed-demo";
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      queueController: createLocalOperatorControllers(database).queueController,
    });
    const client = dashboardClient(app);
    await new Queue(pool).syncConcurrencyPolicies("dashboard-test", [
      { queue: queueName, maxActive: 1, maxActivePerKey: 1 },
      { queue: "policy-only-demo", maxActive: 3 },
      { queue: "terminal-demo", maxActive: 2, maxActivePerKey: 1 },
    ]);
    const activeId = await workhorse.context.queue.enqueue(
      "active",
      {},
      {
        queue: queueName,
        concurrencyKey: "tenant-secret",
      },
    );
    expect((await workhorse.context.queue.claim("demo-worker", { queue: queueName }))?.id).toBe(
      activeId,
    );
    const readyId = await workhorse.context.queue.enqueue(
      "ready",
      {},
      {
        queue: queueName,
        concurrencyKey: "tenant-secret",
      },
    );
    await workhorse.context.queue.enqueue(
      "scheduled",
      {},
      {
        queue: queueName,
        runAt: new Date(Date.now() + 60_000),
      },
    );

    const queuesPage = await client.dashboard.queues();
    expect(queuesPage).toMatchObject({
      queues: expect.arrayContaining([
        expect.objectContaining({
          queue: queueName,
          paused: false,
          scheduled: 1,
          ready: 1,
          active: 1,
          succeeded: 0,
          failed: 0,
          terminalCountsApproximate: false,
          concurrencyPolicy: {
            namespace: "dashboard-test",
            maxActive: 1,
            utilizationKnown: true,
            active: 1,
            available: 0,
            blockedReady: 1,
            maxActivePerKey: 1,
            saturatedKeys: 1,
            highestKeyActive: 1,
          },
        }),
      ]),
      concurrencyPoliciesCapped: false,
    });
    expect(queuesPage.queues.find((row) => row.queue === "policy-only-demo")).toMatchObject({
      paused: false,
      scheduled: 0,
      ready: 0,
      active: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 3,
        utilizationKnown: true,
        active: 0,
        available: 3,
        blockedReady: 0,
      },
    });
    const systemPage = await client.dashboard.system({ window: "1h" });
    expect(systemPage.queues.find((row) => row.queue === "policy-only-demo")).toMatchObject({
      paused: false,
      ready: 0,
      active: 0,
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 3,
        utilizationKnown: true,
        active: 0,
        available: 3,
        blockedReady: 0,
      },
    });
    await expect(client.dashboard.jobDetail({ id: readyId })).resolves.toMatchObject({
      identity: { concurrencyKey: "tenant-secret" },
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 1,
        utilizationKnown: true,
        active: 1,
        available: 0,
        blockedReady: 1,
        maxActivePerKey: 1,
      },
    });
    // A finished task keeps the key it was enqueued with, and still reports its queue's policy as
    // it stands now. Nothing snapshots the limits it ran under, so the drawer labels this current.
    const terminalId = await workhorse.context.queue.enqueue(
      "terminal",
      {},
      { queue: "terminal-demo", concurrencyKey: "tenant-finished" },
    );
    const terminalClaim = await workhorse.context.queue.claim("terminal-worker", {
      queue: "terminal-demo",
    });
    expect(terminalClaim?.id).toBe(terminalId);
    await workhorse.context.queue.complete(terminalClaim!, "terminal-worker", { done: true });
    await expect(client.dashboard.jobDetail({ id: terminalId })).resolves.toMatchObject({
      identity: { state: "succeeded", concurrencyKey: "tenant-finished" },
      current: { runtime: null },
      concurrencyPolicy: {
        namespace: "dashboard-test",
        maxActive: 2,
        maxActivePerKey: 1,
        utilizationKnown: false,
        active: 0,
      },
    });
    // The raw key still never leaves task detail.
    expect(
      JSON.stringify(
        await client.dashboard.tasks({
          filter: "all",
          page: 1,
          pageSize: 25,
          queue: "terminal-demo",
        }),
      ),
    ).not.toContain("tenant-finished");
    const taskList = await client.dashboard.tasks({
      filter: "all",
      page: 1,
      pageSize: 25,
      queue: queueName,
    });
    const eventList = await client.dashboard.events({
      window: "1h",
      pageSize: 100,
      jobId: readyId,
    });
    expect(JSON.stringify(taskList)).not.toContain("tenant-secret");
    expect(JSON.stringify(eventList)).not.toContain("tenant-secret");
    const enqueuedEvent = eventList.events.find((event) => event.type === "enqueued");
    expect(enqueuedEvent).toBeDefined();
    expect(
      JSON.stringify(await client.dashboard.eventDetail({ id: enqueuedEvent!.id })),
    ).not.toContain("tenant-secret");
    const system = await client.dashboard.system({ window: "15m" });
    expect(system.status.reasons).toContainEqual(
      expect.objectContaining({
        code: "concurrency-blocked",
        severity: "degraded",
        queue: queueName,
      }),
    );
    expect(system.queues.find((row) => row.queue === queueName)?.concurrencyPolicy).toMatchObject({
      available: 0,
      blockedReady: 1,
    });
    expect(system.concurrencyPoliciesCapped).toBe(false);
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
    await expect(workhorse.context.admin.getJob(activeId)).resolves.toMatchObject({
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
        actor: "local-demo",
        reason: "pause queue",
        request_id: "queue-pause",
        before: { paused: false },
        after: { paused: true },
        status: "succeeded",
      },
      {
        action: "setQueuePaused",
        target: `queue:${queueName}`,
        actor: "local-demo",
        reason: "resume queue",
        request_id: "queue-resume",
        before: { paused: true },
        after: { paused: false },
        status: "succeeded",
      },
      {
        action: "purgeQueue",
        target: `queue:${queueName}`,
        actor: "local-demo",
        reason: "clear queue",
        request_id: "queue-purge",
        before: { purgeable_jobs: 2 },
        after: { deletedCount: 2 },
        status: "succeeded",
      },
    ]);
  });

  it("reads exact policy without inventing live utilization beyond the health summary cap", async () => {
    const { app, workhorse } = createTestApplication();
    const client = dashboardClient(app);
    const queue = workhorse.context.queue;
    const terminalQueue = "zz-terminal-policy";
    await queue.syncConcurrencyPolicies("dashboard-cap-test", [
      ...Array.from({ length: 101 }, (_, index) => ({
        queue: `policy-${String(index).padStart(3, "0")}`,
        maxActive: 1,
      })),
      { queue: terminalQueue, maxActive: 7, maxActivePerKey: 3 },
    ]);

    const health = await queue.health();
    expect(health.concurrencyPolicies.capped).toBe(true);
    expect(health.concurrencyPolicies.policies).toHaveLength(100);
    expect(health.concurrencyPolicies.policies.map((policy) => policy.queue)).not.toContain(
      terminalQueue,
    );

    const jobId = await queue.enqueue(
      "terminal-beyond-policy-cap",
      {},
      { queue: terminalQueue, concurrencyKey: "tenant-private" },
    );
    // The ceiling is read from this queue's own policy row, so it is exact even past the cap. The
    // counts beside it were never measured, and none of them may be defaulted into a claim: an
    // `available` of 7 here would tell an operator the whole budget is free.
    await expect(client.dashboard.jobDetail({ id: jobId })).resolves.toMatchObject({
      identity: {
        state: "ready",
        concurrencyKey: "tenant-private",
      },
      current: { runtime: { state: "ready" } },
      concurrencyPolicy: {
        namespace: "dashboard-cap-test",
        maxActive: 7,
        maxActivePerKey: 3,
        utilizationKnown: false,
        active: 0,
        available: 0,
        blockedReady: 0,
        saturatedKeys: 0,
        highestKeyActive: 0,
      },
    });

    // A finished task in the same queue keeps its exact ceiling and the same unmeasured signal.
    const claim = await queue.claim("terminal-policy-worker", { queue: terminalQueue });
    expect(claim?.id).toBe(jobId);
    await queue.complete(claim!, "terminal-policy-worker", { done: true });
    await expect(client.dashboard.jobDetail({ id: jobId })).resolves.toMatchObject({
      identity: { state: "succeeded", concurrencyKey: "tenant-private" },
      current: { runtime: null },
      concurrencyPolicy: {
        namespace: "dashboard-cap-test",
        maxActive: 7,
        maxActivePerKey: 3,
        utilizationKnown: false,
        available: 0,
      },
    });

    // A queue inside the health sample still reports measured utilization, so the flag marks the
    // capped read specifically rather than every task detail.
    const measuredId = await queue.enqueue("inside-policy-cap", {}, { queue: "policy-000" });
    await expect(client.dashboard.jobDetail({ id: measuredId })).resolves.toMatchObject({
      concurrencyPolicy: {
        namespace: "dashboard-cap-test",
        maxActive: 1,
        utilizationKnown: true,
        active: 0,
        available: 1,
      },
    });
    expect(
      JSON.stringify(
        await client.dashboard.tasks({
          filter: "all",
          page: 1,
          pageSize: 25,
          queue: terminalQueue,
        }),
      ),
    ).not.toContain("tenant-private");
  });

  it("reconciles local schedule toggles with worker-owned schedule definitions", async () => {
    await syncDemoSchedules(pool);
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      scheduleController: createLocalScheduleController(database),
    });
    const client = dashboardClient(app);

    const cron = await client.dashboard.cron();
    expect(cron.maintenance).toMatchObject({
      cadences: { tickIntervalMs: 1_000 },
      policy: {
        timezone: "UTC",
        partitionPreparationIntervalMs: 21_600_000,
        terminalCleanupIntervalMs: 300_000,
        historyRetentionLocalTime: "03:00",
      },
      tasks: expect.arrayContaining([
        expect.objectContaining({ task: "history_partitions" }),
        expect.objectContaining({ task: "history_retention" }),
        expect.objectContaining({ task: "terminal_storage" }),
      ]),
    });
    expect(cron.schedules).toEqual(
      expect.arrayContaining([
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
    // A timestamp older than every daily partition lands in the catch-all partition, which is
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
    expect(system.status.reasons).toEqual([
      expect.objectContaining({
        code: "default-history-rows",
        severity: "degraded",
        observed: 1,
      }),
    ]);
    expect(system.integrity.retention.defaultHistoryRows).toEqual({
      jobEvents: 1,
      attemptHistory: 0,
    });
    // The row predates every partition cutoff, so it is spill rather than an un-dropped day.
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
    expect(system.status.reasons).toEqual([
      expect.objectContaining({
        code: "retention-lag",
        severity: "degraded",
        category: "scheduleOccurrences",
      }),
    ]);

    const scheduleRuns = system.integrity.retention.categories.find(
      (row) => row.category === "scheduleOccurrences",
    );
    expect(scheduleRuns).toMatchObject({
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
    // Retention never escalates past degraded, and nothing spilled outside daily storage.
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
      "statistics",
    ]);
    expect(
      system.integrity.retention.categories.find((row) => row.category === "scheduleOccurrences")
        ?.retentionDays,
    ).toBe(health.retentionPolicy.scheduleOccurrenceRetentionDays);
  });

  it("runs workers without mounting dashboard routes", async () => {
    const { app, workhorse } = createTestApplication({ dashboard: false });
    workhorse.start();

    try {
      expect((await app.request("/")).status).toBe(404);
      expect((await app.request("/workhorse/rpc/dashboard/tasks")).status).toBe(404);
      expect((await app.request("/workhorse/events")).status).toBe(404);
      const jobId = await workhorse.context.queue.enqueue(
        "demo.recurring",
        { source: "headless-test" },
        { maxAttempts: 1, tags: ["demo-test"] },
      );
      const job = await waitFor(
        () => workhorse.context.admin.getJob(jobId),
        (candidate) => candidate?.state === "succeeded",
      );
      expect(job?.state).toBe("succeeded");
    } finally {
      await workhorse.stop();
    }
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

  it("releases a future-scheduled task now with audit and refuses durable waits", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const admin = new Admin(pool, "demo");
    const originalRunAt = new Date(Date.now() + 3_600_000);
    const jobId = await queue.enqueue(
      "demo.success",
      { label: "run-now" },
      { queue: "run-now-release", runAt: originalRunAt },
    );

    const released = await client.dashboard.runTaskNow({
      id: jobId,
      audit: { actor: "operator", reason: "Needed for incident recovery", requestId: "run-now-1" },
    });
    expect(released).toMatchObject({ status: "released", id: jobId, state: "ready" });
    expect(new Date(released.runAt!).getTime()).toBeLessThan(originalRunAt.getTime());
    await expect(
      client.dashboard.runTaskNow({
        id: jobId,
        audit: { actor: "operator", reason: "Retry click", requestId: "run-now-2" },
      }),
    ).resolves.toMatchObject({ status: "already_ready", id: jobId, state: "ready" });

    const waitingId = await queue.enqueue(
      "demo.success",
      { label: "waiting" },
      { queue: "run-now-wait" },
    );
    const claimed = await queue.claim("run-now-wait-worker", { queue: "run-now-wait" });
    expect(claimed?.id).toBe(waitingId);
    await queue.scheduleWait(claimed!, "run-now-wait-worker", "approval", {
      wakeAt: new Date(Date.now() + 3_600_000),
    });
    const waitingBefore = await admin.getJob(waitingId);
    await expect(
      client.dashboard.runTaskNow({
        id: waitingId,
        audit: { actor: "operator", reason: "Unsafe override attempt", requestId: "run-now-wait" },
      }),
    ).resolves.toMatchObject({
      status: "waiting",
      id: waitingId,
      state: "scheduled",
      runAt: waitingBefore!.runAt.toISOString(),
    });
    await expect(admin.getJob(waitingId)).resolves.toMatchObject({
      state: "scheduled",
      runAt: waitingBefore!.runAt,
    });

    const audit = await pool.query<{
      request_id: string;
      action: string;
      target: string;
      status: string;
      reason: string;
      before: { state: string | null; runAt: string | null; waitName: string | null };
      after: { status: string; id: string; state: string | null; runAt: string | null };
    }>(
      `SELECT request_id, action, target, status, reason, before, after
         FROM public.workhorse_demo_audit
        WHERE request_id IN ('run-now-1', 'run-now-2', 'run-now-wait')
        ORDER BY id`,
    );
    expect(audit.rows).toMatchObject([
      {
        request_id: "run-now-1",
        action: "runTaskNow",
        target: `job:${jobId}`,
        status: "succeeded",
        reason: "Needed for incident recovery",
        before: { state: "scheduled", runAt: originalRunAt.toISOString(), waitName: null },
        after: { status: "released", id: jobId, state: "ready" },
      },
      {
        request_id: "run-now-2",
        action: "runTaskNow",
        target: `job:${jobId}`,
        status: "succeeded",
        after: { status: "already_ready", id: jobId, state: "ready" },
      },
      {
        request_id: "run-now-wait",
        action: "runTaskNow",
        target: `job:${waitingId}`,
        status: "failed",
        before: { state: "scheduled", waitName: "approval" },
        after: { status: "waiting", id: waitingId, state: "scheduled" },
      },
    ]);
  });

  it("cancels an unstarted task immediately, as a distinct terminal state with a recorded audit", async () => {
    // No workers are started, so this task is provably still waiting to be claimed. Cancelling it
    // must be immediate and final, because no handler ever observed it.
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const jobId = await queue.enqueue("demo.success", { label: "cancel-ready" }, {});

    const result = await client.dashboard.cancelTask({
      id: jobId,
      audit: { actor: "operator", reason: "Superseded by a newer request", requestId: "cancel-1" },
    });
    expect(result).toMatchObject({
      status: "canceled",
      jobId,
      state: "canceled",
      requestedBy: "local-demo",
      reason: "Superseded by a newer request",
    });
    expect(result.finishedAt).toEqual(expect.any(String));

    // Canceled is its own terminal state. It must never be reported as failed or discarded.
    const detail = await client.dashboard.jobDetail({ id: jobId });
    expect(detail.identity.state).toBe("canceled");
    expect(detail.current.outcome).toMatchObject({ state: "canceled" });
    expect(detail.current.runtime).toBeNull();

    const audit = await pool.query<{
      action: string;
      target: string;
      status: string;
      reason: string;
      before: { state: string | null };
      after: { status: string; state: string | null };
    }>(
      `SELECT action, target, status, reason, before, after FROM public.workhorse_demo_audit
          WHERE request_id = $1`,
      ["cancel-1"],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: "cancelTask",
      target: `job:${jobId}`,
      status: "succeeded",
      reason: "Superseded by a newer request",
      before: { state: "ready" },
      after: { status: "canceled", state: "canceled" },
    });
  });

  it("allows canceling a task without a reason", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const jobId = await new Queue(pool, "demo").enqueue(
      "demo.success",
      { label: "cancel-without-reason" },
      {},
    );

    await expect(
      client.dashboard.cancelTask({
        id: jobId,
        audit: { actor: "operator", requestId: "cancel-without-reason" },
      }),
    ).resolves.toMatchObject({ status: "canceled", state: "canceled", reason: null });
    await expect(
      pool.query(`SELECT reason FROM public.workhorse_demo_audit WHERE request_id = $1`, [
        "cancel-without-reason",
      ]),
    ).resolves.toMatchObject({ rows: [{ reason: null }] });
  });

  it("cancels a future-scheduled task without waiting for its run time", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const jobId = await queue.enqueue(
      "demo.success",
      { label: "cancel-scheduled" },
      { runAt: new Date(Date.now() + 3_600_000) },
    );
    await expect(client.dashboard.jobDetail({ id: jobId })).resolves.toMatchObject({
      current: { runtime: { state: "scheduled" } },
    });

    await expect(
      client.dashboard.cancelTask({
        id: jobId,
        audit: { actor: "operator", reason: "No longer needed", requestId: "cancel-scheduled" },
      }),
    ).resolves.toMatchObject({ status: "canceled", state: "canceled" });
    await expect(client.dashboard.jobDetail({ id: jobId })).resolves.toMatchObject({
      identity: { state: "canceled" },
    });
  });

  it("records a cooperative request for a running task and finalizes it once the handler stops", async () => {
    // The handler is long enough that cancellation lands mid-flight, and the short heartbeat is
    // what actually delivers the signal to the running worker.
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningJobMs: 800,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: { actor: "operator", reason: "cooperative cancel", requestId: "cancel-active-seed" },
      });
      await waitFor(
        () => client.dashboard.jobDetail({ id: enqueued.jobId }),
        (detail) => detail.current.runtime?.state === "active",
      );

      const requested = await client.dashboard.cancelTask({
        id: enqueued.jobId,
        audit: { actor: "operator", reason: "Runaway task", requestId: "cancel-active" },
      });
      // While the handler still owns the lease, PostgreSQL can only record the request.
      expect(requested).toMatchObject({
        status: "cancel_requested",
        state: "active",
        requestedBy: "local-demo",
        reason: "Runaway task",
      });
      expect(requested.requestedAt).toEqual(expect.any(String));
      expect(requested.finishedAt).toBeNull();

      // The request is visible on the live task before the outcome exists, so an operator is not
      // left staring at an apparently untouched running task.
      const pending = await client.dashboard.jobDetail({ id: enqueued.jobId });
      expect(pending.current.runtime).toMatchObject({
        state: "active",
        cancellation: { requestedBy: "local-demo", reason: "Runaway task" },
      });

      // The handler owns when it stops, so the wait must outlast the whole handler duration.
      const finished = await waitFor(
        () => client.dashboard.jobDetail({ id: enqueued.jobId }),
        (detail) => detail.identity.state === "canceled",
        600,
      );
      expect(finished.current.outcome).toMatchObject({ state: "canceled" });
      // A cooperative cancellation closes the attempt as canceled, never as a failure.
      expect(finished.attempts.map((attempt) => attempt.outcome)).toEqual(["canceled"]);

      const events = await pool.query<{ event_type: string; details: Record<string, unknown> }>(
        `SELECT event_type, details FROM workhorse.job_event
          WHERE job_id = $1 AND event_type IN ('cancel_requested', 'canceled')
          ORDER BY occurred_at, event_id`,
        [enqueued.jobId],
      );
      expect(events.rows.map((row) => row.event_type)).toEqual(["cancel_requested", "canceled"]);
      expect(events.rows[0]?.details).toMatchObject({
        requested_by: "local-demo",
        reason: "Runaway task",
      });
      expect(events.rows[1]?.details).toMatchObject({ source: "acknowledged" });
    } finally {
      await workhorse.stop();
    }
  });

  it("leaves a task that already finished exactly as it was", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();
    let jobId: string;

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "success",
        audit: { actor: "operator", reason: "terminal cancel", requestId: "cancel-terminal-seed" },
      });
      jobId = enqueued.jobId;
      await waitFor(
        () => client.dashboard.jobDetail({ id: jobId }),
        (detail) => detail.identity.state === "succeeded",
      );
    } finally {
      await workhorse.stop();
    }

    const before = await client.dashboard.jobDetail({ id: jobId! });
    const result = await client.dashboard.cancelTask({
      id: jobId!,
      audit: { actor: "operator", reason: "Too late", requestId: "cancel-terminal" },
    });
    expect(result).toMatchObject({ status: "already_terminal", state: "succeeded" });
    // A terminal outcome is immutable: the recorded success must survive the attempt untouched.
    await expect(client.dashboard.jobDetail({ id: jobId! })).resolves.toMatchObject({
      identity: { state: "succeeded" },
      current: { outcome: { state: before.current.outcome?.state } },
    });
    await expect(
      pool.query(`SELECT status FROM public.workhorse_demo_audit WHERE request_id = $1`, [
        "cancel-terminal",
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "succeeded" }] });
  });

  it("reports a missing task as not found rather than a silent success", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    await expect(
      client.dashboard.cancelTask({
        id: "00000000-0000-4000-8000-000000000000",
        audit: { actor: "operator", reason: "Ghost task", requestId: "cancel-missing" },
      }),
    ).rejects.toThrow(/not found/i);
    // The failed attempt is still audited, so an operator action never disappears.
    await expect(
      pool.query(`SELECT status, action FROM public.workhorse_demo_audit WHERE request_id = $1`, [
        "cancel-missing",
      ]),
    ).resolves.toMatchObject({ rows: [{ status: "failed", action: "cancelTask" }] });
  });

  it("refuses cancellation from a read-only operator", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const jobId = await new Queue(pool, "demo").enqueue("demo.success", { label: "read-only" }, {});

    await expect(
      client.dashboard.cancelTask({
        id: jobId,
        audit: { actor: "viewer", reason: "Not permitted", requestId: "cancel-read-only" },
      }),
    ).rejects.toThrow(/read-only/i);
    await expect(client.dashboard.jobDetail({ id: jobId })).resolves.toMatchObject({
      identity: { state: "ready" },
    });
    await expect(
      pool.query(`SELECT count(*)::integer AS count FROM public.workhorse_demo_audit`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("counts and filters canceled tasks separately from failed and discarded work", async () => {
    const { app } = createTestApplication({ operator: createLocalOperator(database) });
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const canceledId = await queue.enqueue("demo.success", { label: "counted-cancel" }, {});
    const readyId = await queue.enqueue("demo.success", { label: "left-alone" }, {});
    await client.dashboard.cancelTask({
      id: canceledId,
      audit: { actor: "operator", reason: "Counted", requestId: "cancel-counted" },
    });

    const counts = await client.dashboard.taskCounts();
    expect(counts.canceled).toBe(1);
    // The demo's terminal-failure bucket is "discarded". Cancellation must not land in it, nor in
    // the completed bucket, because a canceled task neither failed nor succeeded.
    expect(counts.discarded).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.queued).toBe(1);

    const canceledPage = await client.dashboard.tasks({
      filter: "canceled",
      page: 1,
      pageSize: 25,
    });
    expect(canceledPage.total).toBe(1);
    expect(canceledPage.jobs.map((job) => job.id)).toEqual([canceledId]);
    expect(canceledPage.jobs[0]).toMatchObject({ state: "canceled" });

    const discardedPage = await client.dashboard.tasks({
      filter: "discarded",
      page: 1,
      pageSize: 25,
    });
    expect(discardedPage.jobs.map((job) => job.id)).not.toContain(canceledId);
    const queuedPage = await client.dashboard.tasks({ filter: "queued", page: 1, pageSize: 25 });
    expect(queuedPage.jobs.map((job) => job.id)).toEqual([readyId]);
  });

  it("counts and filters blocked tasks with their prerequisite reason", async () => {
    const { app } = createTestApplication();
    const client = dashboardClient(app);
    const queue = new Queue(pool, "demo");
    const prerequisiteId = await queue.enqueue("demo.success", { label: "prerequisite" });
    const blockedId = await queue.enqueue(
      "demo.success",
      { label: "dependent" },
      { prerequisiteJobId: prerequisiteId },
    );

    await expect(client.dashboard.taskCounts()).resolves.toMatchObject({ all: 2, blocked: 1 });
    const page = await client.dashboard.tasks({ filter: "blocked", page: 1, pageSize: 25 });
    expect(page).toMatchObject({
      filter: "blocked",
      total: 1,
      jobs: [
        {
          id: blockedId,
          state: "blocked",
          blockedReason: "prerequisite_pending",
          prerequisiteJobIds: [prerequisiteId],
        },
      ],
    });
  });

  it("cancels one recurring occurrence without disabling its schedule", async () => {
    const { app } = createTestApplication({
      operator: createLocalOperator(database),
      scheduleController: createLocalScheduleController(database),
    });
    const client = dashboardClient(app);
    await syncDemoSchedules(pool);
    const stored = await new Queue(pool, "demo").schedules([DEMO_SCHEDULE_NAMESPACE]);
    const heartbeat = stored.find((schedule) => schedule.name === HEARTBEAT_SCHEDULE_NAME)!;
    // Materialize one occurrence directly so the test does not depend on wall-clock cron timing.
    const occurrenceJobId = (await new Queue(pool, "demo").fireSchedule(
      DEMO_SCHEDULE_NAMESPACE,
      HEARTBEAT_SCHEDULE_NAME,
      heartbeat.revision,
      new Date(),
    ))!;
    expect(occurrenceJobId).toEqual(expect.any(String));
    await client.dashboard.cancelTask({
      id: occurrenceJobId,
      audit: { actor: "operator", reason: "Skip this run", requestId: "cancel-occurrence" },
    });

    await expect(client.dashboard.jobDetail({ id: occurrenceJobId })).resolves.toMatchObject({
      identity: { state: "canceled" },
    });
    // Cancelling one materialized run says nothing about the schedule, which stays enabled and
    // keeps its next occurrence.
    const cron = await client.dashboard.cron();
    for (const schedule of cron.schedules) expect(schedule.enabled).toBe(true);
    expect(
      (
        await pool.query<{ enabled: boolean }>(
          `SELECT enabled FROM workhorse.schedule_definition WHERE namespace = $1`,
          [DEMO_SCHEDULE_NAMESPACE],
        )
      ).rows.every((row) => row.enabled),
    ).toBe(true);
  });

  it("counts a canceled attempt as its own outcome rather than as an error", async () => {
    // Only a task that actually started produces an attempt, so the system chart is exercised
    // through a running task rather than one canceled before dispatch.
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
      longRunningJobMs: 800,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const enqueued = await client.dashboard.enqueueTest({
        kind: "long-running",
        audit: { actor: "operator", reason: "metrics", requestId: "cancel-metrics-seed" },
      });
      await waitFor(
        () => client.dashboard.jobDetail({ id: enqueued.jobId }),
        (detail) => detail.current.runtime?.state === "active",
      );
      await client.dashboard.cancelTask({
        id: enqueued.jobId,
        audit: { actor: "operator", reason: "Metrics", requestId: "cancel-metrics" },
      });
      await waitFor(
        () => client.dashboard.jobDetail({ id: enqueued.jobId }),
        (detail) => detail.identity.state === "canceled",
        600,
      );

      const system = await client.dashboard.system({ window: "1h" });
      expect(system.outcomes.reduce((total, point) => total + point.canceled, 0)).toBe(1);
      // An operator stopping a task is not a system error. It must not appear as a failed or
      // lease-expired attempt, and it must not raise the error rate.
      expect(system.outcomes.reduce((total, point) => total + point.failed, 0)).toBe(0);
      expect(system.outcomes.reduce((total, point) => total + point.leaseExpired, 0)).toBe(0);
      expect(system.kpis.errorRate.current).toBe(0);
    } finally {
      await workhorse.stop();
    }
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
    expect(tasks.jobs.filter((job) => job.keyed).map((job) => job.id)).toContain(seededJobId);
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

/**
 * The events feed is the only dashboard surface that reads the append-only history directly, and
 * the only one whose correctness question is "does it show what actually happened". These tests run
 * real work through a real worker and then assert the feed against it, rather than against fixtures.
 */
describe("Workhorse dashboard events feed", () => {
  it("merges lifecycle events and closed attempts for work a worker really ran", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { jobId } = await enqueueDemoTest("success");
      const page = await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100 }),
        (value) =>
          value.events.some(
            (event) =>
              event.jobId === jobId && event.kind === "attempt" && event.type === "succeeded",
          ),
      );

      const rows = page.events.filter((event) => event.jobId === jobId);
      // Both history tables reach the same feed, and the row says which one it came from.
      expect(rows.map((event) => `${event.kind}:${event.type}`)).toEqual(
        expect.arrayContaining(["event:enqueued", "attempt:succeeded"]),
      );
      // The job identity is joined in, so a feed row names the task rather than only its uuid.
      for (const row of rows) {
        expect(row.queue).toBe("demo");
        expect(row.jobType).toMatch(/^demo\./);
      }
      const attempt = rows.find((event) => event.kind === "attempt")!;
      expect(attempt.workerId).toEqual(expect.any(String));
      expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
      expect(attempt.attempt).toBe(1);
      // Drawer links address the history record itself, so they remain valid after a moving feed
      // pushes the row onto another page.
      const detail = await client.dashboard.eventDetail({ id: attempt.id });
      expect(detail).toMatchObject(attempt);
      expect(detail.startedAt).toEqual(expect.any(String));
      expect(detail.claimedAt).toEqual(expect.any(String));
      expect(detail.finishedAt).toEqual(expect.any(String));

      // Newest first, with lifecycle and attempt rows interleaved by time rather than by table.
      const timestamps = page.events.map((event) => Date.parse(event.occurredAt));
      expect(
        timestamps.every((value, index) => index === 0 || timestamps[index - 1]! >= value),
      ).toBe(true);
    } finally {
      await workhorse.stop();
    }
  });

  it("filters by source table, event type, and the queue the job belongs to", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { jobId } = await enqueueDemoTest("success");
      await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100, kind: "attempt" }),
        (value) => value.events.some((event) => event.jobId === jobId),
      );

      const attempts = await client.dashboard.events({
        window: "1h",
        pageSize: 100,
        kind: "attempt",
      });
      expect(attempts.events.length).toBeGreaterThan(0);
      expect(attempts.events.every((event) => event.kind === "attempt")).toBe(true);

      const enqueues = await client.dashboard.events({
        window: "1h",
        pageSize: 100,
        types: ["enqueued"],
      });
      expect(enqueues.events.length).toBeGreaterThan(0);
      expect(enqueues.events.every((event) => event.type === "enqueued")).toBe(true);

      // Queue and task filters are matched through the job the history row points at.
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, queue: "demo" })).events
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, queue: "not-a-queue" }))
          .events,
      ).toEqual([]);
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, jobId })).events.every(
          (event) => event.jobId === jobId,
        ),
      ).toBe(true);
    } finally {
      await workhorse.stop();
    }
  });

  it("loads complete structured attempt errors for the event drawer", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { jobId } = await enqueueDemoTest("retry");
      const page = await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100, jobId }),
        (value) =>
          value.events.some((event) => event.kind === "attempt" && event.errorMessage !== null),
      );
      const attempt = page.events.find(
        (event) => event.kind === "attempt" && event.errorMessage !== null,
      )!;
      const detail = await client.dashboard.eventDetail({ id: attempt.id });
      expect(detail.error).not.toBeNull();
      expect(detail.errorMessage).toBe(attempt.errorMessage);
      expect(detail.startedAt).toEqual(expect.any(String));
      expect(detail.claimedAt).toEqual(expect.any(String));
      expect(detail.finishedAt).toEqual(expect.any(String));
    } finally {
      await workhorse.stop();
    }
  });

  it("pages through a busy window and reports retention depth", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      // Enough work that the window certainly holds more than one page, so the paging assertions
      // below are about the feed rather than about how fast the fleet drained.
      for (let index = 0; index < 20; index += 1) await enqueueDemoTest("success");
      await waitFor(
        () => client.dashboard.events({ window: "1h", pageSize: 100 }),
        (value) => value.total > 50,
      );
      // Stop writing before comparing two pages: fresh rows arriving between the reads shift every
      // offset behind them, which would show up as an overlap that has nothing to do with paging.
      await workhorse.stop();

      const first = await client.dashboard.events({ window: "1h", pageSize: 25, page: 1 });
      const second = await client.dashboard.events({ window: "1h", pageSize: 25, page: 2 });
      expect(first.page).toBe(1);
      expect(second.page).toBe(2);
      expect(first.events).toHaveLength(25);
      expect(second.events).toHaveLength(25);
      expect(first.total).toBeGreaterThan(50);
      expect(second.total).toBe(first.total);
      // A later page continues the ordering rather than repeating what the page above it showed.
      const shown = new Set(first.events.map((event) => event.id));
      expect(second.events.filter((event) => shown.has(event.id))).toEqual([]);
      expect(second.events[0]!.occurredAt <= first.events.at(-1)!.occurredAt).toBe(true);

      const full = await client.dashboard.events({ window: "1h", pageSize: 100 });
      expect(full.total).toBe(first.total);
      expect(full.windowSeconds).toBe(3_600);
      // Depth is bounded by retention, so the page carries the policy rather than leaving an
      // operator to infer it from a feed that simply stops.
      const policy = await pool.query<{ days: number | null }>(
        "SELECT job_event_retention_days AS days FROM workhorse.retention_policy WHERE singleton",
      );
      expect(full.retention.jobEventDays).toBe(policy.rows[0]?.days ?? null);
    } finally {
      await workhorse.stop();
    }
  });

  it("excludes work that finished before the requested window", async () => {
    const { app, workhorse } = createTestApplication({
      operator: createLocalOperator(database),
      workerPollMs: 5,
    });
    const client = dashboardClient(app);
    workhorse.start();

    try {
      const { jobId } = await enqueueDemoTest("success");
      await waitFor(
        () => client.dashboard.events({ window: "15m", pageSize: 100, jobId }),
        (value) => value.events.some((event) => event.kind === "attempt"),
      );
      // Stop the fleet before rewriting history: a worker still claiming work would write fresh
      // rows for this job after the aging update and the window assertion would race it.
      await workhorse.stop();

      // Age the history past the shortest window without touching the clock the queue runs on.
      await pool.query(
        "UPDATE workhorse.job_event SET occurred_at = occurred_at - interval '20 minutes' WHERE job_id = $1",
        [jobId],
      );
      await pool.query(
        "UPDATE workhorse.attempt_history SET occurred_at = occurred_at - interval '20 minutes' WHERE job_id = $1",
        [jobId],
      );

      expect(
        (await client.dashboard.events({ window: "15m", pageSize: 100, jobId })).events,
      ).toEqual([]);
      expect(
        (await client.dashboard.events({ window: "1h", pageSize: 100, jobId })).events.length,
      ).toBeGreaterThan(0);
    } finally {
      await workhorse.stop();
    }
  });

  it("releases and cancels dependents according to their prerequisite outcomes", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("job-dependencies");

    const releasedPrerequisite = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("job-dependencies", "test-release", "success", { role: "prerequisite" }),
      { maxAttempts: 1 },
    );
    const releasedDependent = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("job-dependencies", "test-release", "success", { role: "dependent" }),
      {
        maxAttempts: 1,
        dependencies: {
          prerequisiteJobIds: [releasedPrerequisite],
          onSuccess: "release",
          onFailure: "fail",
          onCancellation: "cancel",
        },
      },
    );
    const failingPrerequisite = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("job-dependencies", "test-cancel", "always-fail", {
        role: "prerequisite",
      }),
      { maxAttempts: 1 },
    );
    const canceledDependent = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("job-dependencies", "test-cancel", "success", { role: "dependent" }),
      {
        maxAttempts: 1,
        dependencies: {
          prerequisiteJobIds: [failingPrerequisite],
          onSuccess: "release",
          onFailure: "cancel",
          onCancellation: "cancel",
        },
      },
    );
    workhorse.start();

    try {
      await waitForJobState(workhorse.context.admin, releasedDependent, "succeeded");
      await waitForJobState(workhorse.context.admin, canceledDependent, "canceled");
      const lineage = await workhorse.context.admin.getDependencyLineage(releasedDependent);
      expect(lineage.records).toMatchObject([
        {
          dependentJobId: releasedDependent,
          prerequisiteJobId: releasedPrerequisite,
          resolution: "release",
        },
      ]);
    } finally {
      await workhorse.stop();
    }
  });

  it("joins named children and retains their results for the suspended parent", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("child-workflows");

    const parentJobId = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("child-workflows", "test-fan-out", "fan-out-join", { childCount: 2 }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      await waitForJobState(workhorse.context.admin, parentJobId, "succeeded");
      expect(await jobResult(parentJobId)).toMatchObject({
        scenario: "test-fan-out",
        childCount: 2,
        children: {
          "shard-1": { step: "shard-1", completedOnAttempt: 1 },
          "shard-2": { step: "shard-2", completedOnAttempt: 1 },
        },
      });
      const lineage = await workhorse.context.admin.getChildLineage(parentJobId);
      expect(lineage.records).toHaveLength(2);
      expect(lineage.records.every((record) => record.outcomeState === "succeeded")).toBe(true);
    } finally {
      await workhorse.stop();
    }
  });

  it("resumes a signal wait when its companion sender task delivers", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("signals");

    const waiterJobId = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("signals", "test-handoff", "signal-handoff", {
        waitTimeoutMs: 60_000,
      }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      await waitForJobState(workhorse.context.admin, waiterJobId, "succeeded");
      expect(await jobResult(waiterJobId)).toMatchObject({
        scenario: "test-handoff",
        behavior: "signal-handoff",
        signal: { scenario: "test-handoff", sentBy: "showcase-sender" },
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("lists a pending operator signal wait and resumes it on delivery", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("signals");

    const waiterJobId = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("signals", "test-operator", "signal-operator", {
        waitTimeoutMs: 60_000,
      }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      await waitFor(
        () => workhorse.context.admin.listSignalWaits(),
        (page) => page.items.some((wait) => wait.jobId === waiterJobId),
        1_600,
      );
      const delivery = await queue.sendSignal(
        waiterJobId,
        DEMO_SIGNAL_NAME,
        { approved: true },
        { idempotencyKey: "test-operator-signal", requestedBy: "integration-test" },
      );
      expect(delivery.status).toBe("delivered");
      await waitForJobState(workhorse.context.admin, waiterJobId, "succeeded");
      expect(await jobResult(waiterJobId)).toMatchObject({ signal: { approved: true } });
    } finally {
      await workhorse.stop();
    }
  });

  it("completes a pending human decision and resumes the suspended handler", async () => {
    const { app, workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("human-decisions");

    const jobId = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("human-decisions", "test-approval", "human-pending", {
        waitTimeoutMs: 60_000,
      }),
      { maxAttempts: 1 },
    );
    workhorse.start();

    try {
      const pending = await waitFor(
        () => workhorse.context.admin.listHumanWaits(),
        (page) => page.items.some((wait) => wait.jobId === jobId),
        1_600,
      );
      expect(pending.items.find((wait) => wait.jobId === jobId)).toMatchObject({
        name: DEMO_HUMAN_WAIT_NAME,
        context: {
          scenario: "test-approval",
          dashboard: {
            quickAction: { label: "Approve", result: { approved: true } },
          },
        },
      });
      const waiting = await dashboardClient(app).dashboard.tasks({
        filter: "waiting",
        page: 1,
        pageSize: 25,
      });
      expect(waiting).toMatchObject({
        filter: "waiting",
        total: 1,
        jobs: [{ id: jobId, state: "scheduled", waitName: DEMO_HUMAN_WAIT_NAME }],
      });
      const completion = await queue.completeHumanWait(
        jobId,
        DEMO_HUMAN_WAIT_NAME,
        { approved: true, note: "looks good" },
        { idempotencyKey: "test-human-decision", requestedBy: "integration-test" },
      );
      expect(completion.status).toBe("completed");
      await waitForJobState(workhorse.context.admin, jobId, "succeeded");
      expect(await jobResult(jobId)).toMatchObject({
        scenario: "test-approval",
        decision: { approved: true, note: "looks good" },
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("settles batch digest members independently within one invocation", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("batch-handlers");

    const [succeedingJobId, failingJobId] = await queue.enqueueMany([
      {
        type: family.jobType,
        payload: showcaseTestPayload("batch-handlers", "test-batch", "batch-member", {
          memberIndex: 1,
        }),
        options: { maxAttempts: 1 },
      },
      {
        type: family.jobType,
        payload: showcaseTestPayload("batch-handlers", "test-batch", "batch-member", {
          memberIndex: 2,
          shouldFail: true,
        }),
        options: { maxAttempts: 1 },
      },
    ]);

    workhorse.start();
    try {
      await waitForJobState(workhorse.context.admin, succeedingJobId!, "succeeded");
      await waitForJobState(workhorse.context.admin, failingJobId!, "failed");
      expect(await jobResult(succeedingJobId!)).toMatchObject({
        scenario: "test-batch",
        memberIndex: 1,
        digestId: expect.any(String),
      });
    } finally {
      await workhorse.stop();
    }
  });

  it("captures the contract version, rejects an invalid result, and reports a payload refusal", async () => {
    const { workhorse } = createTestApplication();
    const queue = workhorse.context.queue;
    const family = demoFeatureShowcaseFamily("payload-contracts");

    const acceptedJobId = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("payload-contracts", "test-accepted", "contract-valid", {
        invoiceId: "INV-test-accepted",
      }),
      { maxAttempts: 1 },
    );
    const rejectedResultJobId = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("payload-contracts", "test-rejected", "contract-result-invalid", {
        invoiceId: "INV-test-rejected",
      }),
      { maxAttempts: 1 },
    );
    const probeJobId = await queue.enqueue(
      family.jobType,
      showcaseTestPayload("payload-contracts", "test-probe", "contract-payload-probe", {
        invoiceId: "INV-test-probe",
      }),
      { maxAttempts: 1 },
    );
    await expect(
      queue.enqueue(
        family.jobType,
        showcaseTestPayload("payload-contracts", "test-refused", "contract-valid"),
      ),
    ).rejects.toThrow(/contract/i);

    workhorse.start();
    try {
      await waitForJobState(workhorse.context.admin, acceptedJobId, "succeeded");
      expect(await jobResult(acceptedJobId)).toMatchObject({
        approved: true,
        invoiceId: "INV-test-accepted",
        contractVersion: "v1",
      });
      await waitForJobState(workhorse.context.admin, rejectedResultJobId, "failed");
      const failure = await pool.query<{ message: string }>(
        "SELECT error->>'message' AS message FROM workhorse.job_outcome WHERE job_id = $1",
        [rejectedResultJobId],
      );
      expect(failure.rows[0]!.message).toMatch(/contract/i);
      await waitForJobState(workhorse.context.admin, probeJobId, "succeeded");
      expect(await jobResult(probeJobId)).toMatchObject({
        approved: true,
        probedRejection: { name: "JobContractValidationError" },
      });
    } finally {
      await workhorse.stop();
    }
  });
});

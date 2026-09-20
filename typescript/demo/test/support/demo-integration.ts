import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Admin, Queue, type Json, type Worker } from "@stablemates/workhorse";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { assertLocalDatabasePurpose } from "../../../core/src/local-database.js";
import { createDatabaseTestHarness } from "../../../core/test/support/db.js";
import {
  createDemoApplication,
  createDemoDatabase,
  createLocalOperator,
  DEMO_MAINTENANCE_INTERVAL_MS,
  DEMO_MAINTENANCE_ROUTINE_POLL_MS,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_WORKER_CONCURRENCY,
  DEMO_WORKER_POLL_MS,
  installDemoSchema,
} from "../../src/app.js";
import type { CreateDemoApplicationOptions } from "../../src/app.js";
import type { DashboardRouter } from "@stablemates/workhorse-dashboard/server";
import { DEMO_QUEUE_OPTIONS } from "../../src/contracts.js";
import { durableDemoScenarios } from "../../src/durable-demo.js";
import {
  DEMO_FEATURE_SHOWCASE_SOURCE,
  type DemoFeatureBehavior,
  type DemoFeatureFamily,
  type DemoFeaturePayload,
} from "../../src/feature-showcase.js";
import type { DashboardWorkerRow } from "@stablemates/workhorse-dashboard/wire";
import { createDemoWorkerDefinition } from "../../src/worker-definition.js";

/**
 * These tests exercise the demo application, but they must never run against the demo database.
 *
 * Each file drops and reinstalls the schema, truncates every table between tests, and drops the
 * demo's own tables at the end. Pointed at the demo database that is destructive to a demo someone
 * is watching: its data disappears mid-session and its tables are gone when the run ends. Worse in
 * the other direction, a running demo registers three workers of its own, and any assertion about
 * the fleet then sees extra workers beyond the demo workers the test started.
 *
 * The suite therefore takes its database from `createDatabaseTestHarness`, which derives a scratch
 * database from the checkout's guarded `test` URL and refuses any URL that is not marked for tests.
 * A scratch database per file also lets the pieces of this suite run in parallel: two files sharing
 * one database would truncate each other's rows.
 */
export const hasDashboardBrowserBundle = existsSync(
  new URL("../../../dashboard-server/dist/app/index.html", import.meta.url),
);
export const dashboardBrowserTest = hasDashboardBrowserBundle ? it : it.skip;
export const settingsDashboardTestName =
  "loads the settings dashboard route and its read model (requires the built dashboard browser bundle)";
export const workspaceDashboardTestName =
  "serves two switchable workspaces when a staging database is configured (requires the built dashboard browser bundle)";

/**
 * Slot use and operator pause both travel through the durable worker registry, so these tests need
 * a refresh cadence far shorter than the work they observe.
 */
export const TEST_REGISTRY_INTERVAL_MS = 100;

/**
 * The identity shape a worker generates for itself: `<hostname>-<pid>-<8 hex>`.
 *
 * The demo names no workers, so tests assert the shape of a generated identity rather than a
 * literal an application chose.
 */
export const GENERATED_WORKER_ID = /^\S+-\d+-[\da-f]{8}$/;

/**
 * Duration for tasks whose *transient* in-flight state a test asserts on.
 *
 * Reported slot use is only as fresh as the registry cadence, so a test that wants to observe
 * overlapping handlers has to keep them overlapping for many refresh cycles. Tuning this close to
 * the cadence makes the test race with load on the machine rather than with the behavior it checks.
 *
 * It also has to stay comfortably inside `waitFor`'s polling budget, because the same tests then
 * wait for those tasks to succeed. Ten registry refreshes is enough headroom for the first
 * constraint without approaching the second.
 */
export const TEST_OBSERVABLE_TASK_MS = TEST_REGISTRY_INTERVAL_MS * 10;

/** Keep handlers active long enough for a loaded CI runner to observe and act on transient state. */
export const TEST_CONTROL_WINDOW_TASK_MS = TEST_REGISTRY_INTERVAL_MS * 50;

/**
 * Budget for a wait that cannot resolve until a running handler returns.
 *
 * The long-running demo handler sleeps without a signal, so cancelling its task does not shorten
 * it: the task reaches `canceled` only once the attempt it is already serving finishes. A wait on
 * that outcome has to outlast the handler itself, not a poll interval.
 */
export const TEST_UNCANCELLABLE_HANDLER_WAIT_MS = TEST_CONTROL_WINDOW_TASK_MS * 3;

export function dashboardClient(
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

/**
 * Poll a read model until it satisfies a predicate. The demo has no synchronous hook into worker
 * slot transitions, so the tests bound the wait instead of sleeping for a fixed guessed duration.
 *
 * A poll count alone bounds nothing a test can rely on. Each pass costs the fixed sleep plus a
 * read whose latency moves with load, so the same count covers several seconds on a loaded runner
 * and a fraction of one on an idle machine. That is fine for a wait on a state change the demo
 * makes within a poll interval, which is what almost every caller wants.
 *
 * A caller waiting on work of a known duration needs `minimumBudgetMs` as well, because no count
 * can promise to outlast that work. The wait then ends when both bounds are spent.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  attempts = 200,
  minimumBudgetMs = 0,
): Promise<T> {
  const deadline = Date.now() + minimumBudgetMs;
  let latest = await read();
  for (
    let attempt = 0;
    (attempt < attempts || Date.now() < deadline) && !matches(latest);
    attempt += 1
  ) {
    await sleep(5);
    latest = await read();
  }
  expect(matches(latest)).toBe(true);
  return latest;
}

export async function waitForWorker(
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
export async function waitForRegisteredWorker(
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

export function showcaseTestPayload(
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

export const waitForTaskState = (admin: Admin, taskId: string, state: string) =>
  waitFor(
    async () => (await admin.getTask(taskId))?.state,
    (value) => value === state,
    1_600,
  );

export interface DemoTestRuntimeOptions {
  workers?: boolean;
  rateLimitWorker?: boolean;
  onWorkerError?: (error: unknown) => void;
  workerPollMs?: number;
  registryIntervalMs?: number;
  maintenanceRoutinePollMs?: number;
  longRunningTaskMs?: number;
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

export type TestApplicationOptions = CreateDemoApplicationOptions & DemoTestRuntimeOptions;

/**
 * Build one piece of the demo integration suite: a scratch database with the demo schema on it,
 * the lifecycle hooks that keep each test isolated, and the helpers the tests share.
 *
 * Call it once at the top of a test file with `import.meta.url`, because the harness names the
 * scratch database after the file that asked for it.
 */
export function createDemoIntegrationSuite(fileUrl: string) {
  const harness = createDatabaseTestHarness(fileUrl, { max: 4 });
  assertLocalDatabasePurpose(harness.databaseUrl, "test");
  const pool = harness.pool;
  const database = createDemoDatabase(pool);

  /**
   * Applications created by the current test, stopped before the next one truncates.
   *
   * Worker registration is durable, so a worker still running from a previous test would
   * re-register itself after the truncation and pollute the next test's fleet view. Stopping is
   * idempotent, so tests that already stop their own runtime in a `finally` are unaffected. The
   * list belongs to this file alone, so no other file's straggler can reach this fleet view.
   */
  const runningApplications: Array<{ stop: () => Promise<void> }> = [];

  function createTestWorkerRuntime(options: DemoTestRuntimeOptions) {
    // The worker runtime shares the demo's queue options so contracted task types stay completable.
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
              maintenanceRoutinePollMs:
                options.maintenanceRoutinePollMs ?? DEMO_MAINTENANCE_ROUTINE_POLL_MS,
              registryIntervalMs: options.registryIntervalMs,
              durableStepMs: options.durableStepMs,
              durableTimerWaitMs: options.durableTimerWaitMs,
              longRunningTaskMs: options.longRunningTaskMs,
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
      longRunningTaskMs: 25,
      durableStepMs: 0,
      ...options,
    };
    const application = createDemoApplication(database, resolved);
    const workhorse = createTestWorkerRuntime(resolved);
    runningApplications.push(workhorse);
    return { ...application, workhorse };
  }

  beforeAll(async () => {
    await harness.setup();
    await installDemoSchema(database);
  });

  beforeEach(async () => {
    // Stop any worker left running by the previous test before truncating, so a straggler cannot
    // re-register itself into the fleet view this test is about to assert on.
    await Promise.all(runningApplications.splice(0).map((workhorse) => workhorse.stop()));
    await harness.reset();
    // The demo owns its own tables in `public`, which the workhorse-scoped reset leaves alone.
    // `workhorse_demo_schema_version` is deliberately absent: the installed version is schema, not
    // per-test state, and `assertDemoSchemaCompatible` reads it.
    await pool.query(`TRUNCATE public.workhorse_demo_audit, public.workhorse_demo_seed,
      public.workhorse_demo_order RESTART IDENTITY CASCADE`);
    await pool.query(`UPDATE workhorse.task_stat_state SET
      rolled_up_through = date_bin('1 minute', clock_timestamp(), timestamp '2000-01-01' AT TIME ZONE 'UTC'),
      last_run_at = NULL, updated_at = clock_timestamp()`);
    await new Queue(pool).syncRetentionPolicy({
      taskIdentityRetentionDays: null,
      terminalOutcomeRetentionDays: null,
      taskEventRetentionDays: null,
      attemptHistoryRetentionDays: null,
      scheduleOccurrenceRetentionDays: 30,
      statisticsRetentionDays: 14,
      terminalTaskPruneLimit: 1_000,
      historyPartitionsPerPass: 4,
      defaultPartitionRowsPerPass: 10_000,
      occurrenceRowsPerPass: 10_000,
      statisticsRowsPerPass: 10_000,
    });
  });

  afterAll(async () => {
    await harness.teardown();
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

  async function taskResult(taskId: string): Promise<Json | null> {
    const rows = await pool.query<{ result: Json | null }>(
      "SELECT result FROM workhorse.task_outcome WHERE task_id = $1",
      [taskId],
    );
    return rows.rows[0]?.result ?? null;
  }

  return {
    pool,
    database,
    createTestApplication,
    dashboardClient,
    enqueueDemoTest,
    waitFor,
    waitForWorker,
    waitForRegisteredWorker,
    showcaseTestPayload,
    taskResult,
    waitForTaskState,
  };
}

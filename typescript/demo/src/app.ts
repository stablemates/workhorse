import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import {
  createDashboardHost,
  createDashboardOperatorControllers,
  normalizeDashboardPublicOrigin,
  type DashboardOperatorAction,
  type DashboardSingleAdminOptions,
} from "@stablemates/workhorse-dashboard/server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  Admin,
  type EnqueueOptions,
  Queue,
  type CancelStatus,
  type Json,
  type TaskState,
  type MaintenancePolicyDefinition,
  type MaintenancePolicySetting,
  type RetentionPolicyDefinition,
  type RetentionPolicySetting,
  isMissingDatabaseRelationError,
} from "@stablemates/workhorse";
import type { Pool } from "pg";
import {
  DURABLE_DEMO_TASK_TYPE,
  type DurableDemoScenario,
  durableDemoPlanForTask,
  durableDemoScenarios,
} from "./durable-demo.js";
import {
  DEMO_FEATURE_MENU_EXAMPLES,
  DEMO_FEATURE_OPERATOR_SOURCE,
  DEMO_FEATURE_RECURRING_SOURCE,
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  DEMO_FEATURE_SHOWCASE_SEED_NAME,
  DEMO_FEATURE_SHOWCASE_SOURCE,
  demoFeatureShowcaseFamily,
  type DemoFeatureExample,
  type DemoFeatureFamily,
  type DemoFeaturePayload,
  type DemoFeatureShowcaseFamily,
} from "./feature-showcase.js";
import { DEMO_QUEUE_OPTIONS } from "./contracts.js";
import type { DemoDatabase } from "./database.js";

import {
  DEMO_CONCURRENCY_MAX_ACTIVE,
  DEMO_CONCURRENCY_MAX_ACTIVE_PER_KEY,
  DEMO_CONCURRENCY_POLICY_NAMESPACE,
  DEMO_IDEMPOTENCY_TTL_MS,
  DEMO_LONG_RUNNING_SEED_DELAY_MS,
  DEMO_LONG_RUNNING_SEED_TASKS,
  DEMO_MAINTENANCE_INTERVAL_MS,
  DEMO_OPERATOR_IDEMPOTENCY_KEY,
  DEMO_OPERATOR_IDEMPOTENCY_SCOPE,
  DEMO_GO_QUEUE,
  DEMO_PERSISTENT_RETRY_DELAYS_MS,
  DEMO_PERSISTENT_RETRY_POLICIES,
  DEMO_PYTHON_QUEUE,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT,
  DEMO_RATE_LIMIT_PER_KEY,
  DEMO_RATE_LIMIT_POLICY_NAMESPACE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_RATE_LIMIT_SEED_TASKS,
  DEMO_RATE_LIMIT_SEED_NAME,
  DEMO_RECOVERABLE_RETRY_POLICY,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_SEED_IDEMPOTENCY_KEY,
  DEMO_SEED_IDEMPOTENCY_SCOPE,
  DEMO_SHARED_QUEUE,
  DEMO_TIMING_HANDLER_MS,
  DEMO_TIMING_POLICY_TIMEOUT_MS,
  DEMO_TIMING_TIMEOUT_MS,
  DURABLE_TIMER_TASK_TYPE,
  FAILURE_TASK_TYPE,
  HEARTBEAT_SCHEDULE_NAME,
  GO_WORKER_SCHEDULE_NAME,
  HISTORICAL_TASK_COUNT,
  HISTORICAL_SEED_NAME,
  HISTORICAL_WORKER_IDS,
  LONG_RUNNING_TASK_TYPE,
  LANGUAGE_WORKER_TASK_TYPE,
  LONG_RUNNING_SCHEDULE_NAME,
  LONG_RUNNING_SEED_NAME,
  ORDER_TASK_TYPE,
  PYTHON_WORKER_SCHEDULE_NAME,
  RECURRING_TASK_TYPE,
  REPORT_TASK_TYPE,
  REPORT_SCHEDULE_NAME,
  REPRESENTATIVE_SEED_NAME,
  RETRY_TASK_TYPE,
  SHARED_WORKER_TASK_TYPE,
  SHARED_WORKER_SCHEDULE_NAME,
  TIMING_TASK_TYPE,
  TYPESCRIPT_WORKER_SCHEDULE_NAME,
} from "./constants.js";
import { orders } from "./schema.js";

export * from "./constants.js";

/**
 * The ceiling on demo tasks ready to run or running when a public operator admission arrives.
 *
 * The operator surface is unauthenticated, so admission is bounded by the work itself rather
 * than by the caller: once this many tasks compete for the demo's worker slots, admissions refuse
 * until the backlog drains. Scheduled, blocked, and terminal tasks do not count — only work the
 * fleet could claim right now.
 */
export const DEMO_OPERATOR_MAX_PENDING_TASKS = 50;

/**
 * Refuse a new operator-admitted task while the demo's pending-work budget is saturated.
 *
 * Every RPC that creates tasks — `enqueueTest`, `redriveTask`, and `redriveDeadLetters` — checks
 * the same ceiling. The count is approximate under concurrency, and the HTTP-layer mutation
 * guard bounds how far a wave can overshoot it.
 */
async function assertDemoOperatorWorkBudget(
  executor: Pick<DemoDatabase, "execute">,
): Promise<void> {
  const result = await executor.execute<{ pending: number }>(sql`
    SELECT count(*)::integer AS pending
      FROM workhorse.task_runtime
     WHERE state IN ('ready', 'active')
  `);
  if ((result.rows[0]?.pending ?? 0) >= DEMO_OPERATOR_MAX_PENDING_TASKS) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message:
        "The demo is already running its limit of operator-admitted work; try again once the backlog drains",
    });
  }
}

const GOOGLE_ANALYTICS_TAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-9NC8FKZPVB"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-9NC8FKZPVB');
</script>`;

const DEMO_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.google-analytics.com https://www.google-analytics.com",
  "font-src 'self'",
  "connect-src 'self' ws: wss: https://*.google-analytics.com https://www.google-analytics.com",
].join("; ");

async function addGoogleAnalytics(response: Response): Promise<Response> {
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const html = (await response.text()).replace("</head>", `${GOOGLE_ANALYTICS_TAG}\n</head>`);
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

interface DemoIdempotency {
  key: string;
  scope: string;
  ttlMs: number;
}

export interface CreateDemoApplicationOptions {
  dashboard?: boolean;
  /**
   * Serve the dashboard from source with hot reload instead of the packaged bundle.
   *
   * Supplied by the development entry point. The HTML still goes through the packaged host, so this
   * changes where modules come from, not how the page is assembled.
   */
  dev?: {
    readTemplate(): Promise<string>;
    transformHtml(url: string, html: string): Promise<string>;
  };
  /** Display-only deployment environment label shown in the dashboard header. */
  environment?: string;
  operator?: DashboardOperator;
  scheduleController?: ScheduleController;
  queueController?: QueueController;
  taskController?: TaskController;
  workerController?: WorkerController;
  settingsController?: SettingsController;
  maintenanceIntervalMs?: number;
  /** Exact browser-visible origin when a TLS-terminating proxy fronts the demo. */
  publicOrigin?: string;
  /**
   * Protect the dashboard with the packaged single-administrator login instead of the demo's
   * default open access. Supplied by the entry point when the operator credentials are configured.
   */
  singleAdmin?: DashboardSingleAdminOptions;
  /**
   * Serve a second, read-only "staging" workspace from this database, next to the busy
   * "production" workspace, so the dashboard's workspace switcher is demonstrable. The entry
   * point supplies it only when a staging database is provisioned; without it the demo serves the
   * familiar single-workspace dashboard at the same URLs it always had.
   */
  stagingDatabase?: DemoDatabase;
  /** Display-only label of the production database host, shown in the workspace switcher. */
  databaseHost?: string;
  /** Display-only name of the production database, shown in the workspace switcher. */
  databaseName?: string;
  /** Display-only label of the staging database host, shown in the workspace switcher. */
  stagingDatabaseHost?: string;
  /** Display-only name of the staging database, shown in the workspace switcher. */
  stagingDatabaseName?: string;
}

interface AuditContext {
  actor: string;
  reason: string;
  requestId: string;
  occurredAt?: string;
}

interface CancellationAuditContext extends Omit<AuditContext, "reason"> {
  reason: string | null;
}

export interface DashboardOperator {
  mode: "read-only" | "writable";
  enqueueTest?: (
    kind:
      | "success"
      | "retry"
      | "durable"
      | "timer"
      | "failure"
      | "idempotent"
      | "long-running"
      | "redrive"
      | "feature",
    audit: AuditContext,
    scenario?: DurableDemoScenario,
    priority?: number,
    feature?: DemoFeatureFamily,
  ) => Promise<{ taskId: string; outcome?: "accepted" | "replayed" }>;
}

export interface ScheduleController {
  setScheduleEnabled?: (
    namespace: string,
    name: string,
    enabled: boolean,
    audit: AuditContext,
  ) => Promise<{ enabled: boolean }>;
}

interface QueueController {
  setQueuePaused?: (
    queueName: string,
    paused: boolean,
    audit: AuditContext,
  ) => Promise<{ paused: boolean }>;
  purgeQueue?: (queueName: string, audit: AuditContext) => Promise<{ deletedCount: number }>;
}

export interface SettingsController {
  overrideMaintenancePolicy(
    definition: Partial<MaintenancePolicyDefinition>,
    audit: AuditContext,
  ): Promise<void>;
  revertMaintenancePolicy(
    settings: readonly MaintenancePolicySetting[],
    audit: AuditContext,
  ): Promise<void>;
  overrideRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
    audit: AuditContext,
  ): Promise<void>;
  revertRetentionPolicy(
    settings: readonly RetentionPolicySetting[],
    audit: AuditContext,
  ): Promise<void>;
}

/**
 * Result of one audited operator cancellation, projected for the dashboard.
 *
 * `status` is reported exactly as PostgreSQL returned it so the drawer can tell an operator the
 * truth: a scheduled or ready task is already canceled when this resolves, while an active task
 * has only been asked to stop and continues until its handler observes the signal.
 */
interface DemoCancelTaskResult {
  status: CancelStatus;
  taskId: string;
  state: TaskState | null;
  currentAttempt: number | null;
  requestedAt: string | null;
  requestedBy: string | null;
  reason: string | null;
  finishedAt: string | null;
}

interface TaskController {
  runTaskNow?: (
    taskId: string,
    audit: AuditContext,
  ) => Promise<{
    status: "released" | "already_ready" | "not_scheduled" | "waiting" | "not_found";
    id: string;
    state: string | null;
    runAt: string | null;
  }>;
  cancelTask?: (taskId: string, audit: CancellationAuditContext) => Promise<DemoCancelTaskResult>;
}

interface WorkerController {
  setWorkerPaused?: (
    workerId: string,
    paused: boolean,
    audit: AuditContext,
  ) => Promise<{ paused: boolean }>;
}

export { createDemoDatabase } from "./database.js";
export type { DemoDatabase } from "./database.js";

interface HistoricalTask {
  id: string;
  queueName: string;
  taskType: string;
  payload: Json;
  tags: string[];
  maxAttempts: number;
  createdAt: Date;
  state: "succeeded" | "failed";
  currentAttempt: number;
  fenceToken: number;
  runAt: Date;
  result: Json | null;
  error: Json | null;
  finishedAt: Date;
  workerId: (typeof HISTORICAL_WORKER_IDS)[number];
  attempts: HistoricalAttempt[];
}

interface HistoricalAttempt {
  attempt: number;
  fenceToken: number;
  workerId: (typeof HISTORICAL_WORKER_IDS)[number];
  outcome: "succeeded" | "failed" | "retry";
  startedAt: Date;
  finishedAt: Date;
  error: Json | null;
}

function createHistoricalRandom() {
  let state = 0x5eed_cafe;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function historicalTimestamps(now: Date, random: () => number): Date[] {
  const timestamps: Date[] = [];
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);

  // A steady business-hours baseline makes every day visible without looking mechanically uniform.
  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    for (let index = 0; index < 42; index += 1) {
      const businessHour = 8 + Math.floor(random() * 11);
      const timestamp = new Date(today);
      timestamp.setUTCDate(timestamp.getUTCDate() - dayOffset);
      timestamp.setUTCHours(businessHour, Math.floor(random() * 60), Math.floor(random() * 60), 0);
      if (timestamp < now && timestamp.getTime() >= now.getTime() - 7 * 24 * 60 * 60 * 1_000) {
        timestamps.push(timestamp);
      }
    }
  }

  // Two short campaign/order bursts provide recognisable spikes in the seven-day view.
  for (const [dayOffset, hour, count] of [
    [2, 14, 16],
    [5, 10, 12],
  ] as const) {
    for (let index = 0; index < count; index += 1) {
      const timestamp = new Date(today);
      timestamp.setUTCDate(timestamp.getUTCDate() - dayOffset);
      timestamp.setUTCHours(hour, Math.floor(random() * 25), Math.floor(random() * 60), 0);
      timestamps.push(timestamp);
    }
  }

  // Keep all shorter dashboard periods populated as well as the full historical window.
  const recentRanges = [
    { count: 8, minimumMinutesAgo: 1, maximumMinutesAgo: 14 },
    { count: 8, minimumMinutesAgo: 15, maximumMinutesAgo: 59 },
    { count: 12, minimumMinutesAgo: 60, maximumMinutesAgo: 6 * 60 - 1 },
    { count: 12, minimumMinutesAgo: 6 * 60, maximumMinutesAgo: 24 * 60 - 1 },
  ];
  for (const range of recentRanges) {
    for (let index = 0; index < range.count; index += 1) {
      const ageMinutes =
        range.minimumMinutesAgo + random() * (range.maximumMinutesAgo - range.minimumMinutesAgo);
      timestamps.push(new Date(now.getTime() - ageMinutes * 60 * 1_000));
    }
  }

  // Early UTC startup can leave today's business-hours baseline in the future. Fill to a stable size.
  while (timestamps.length < HISTORICAL_TASK_COUNT) {
    const ageMinutes = 24 * 60 + random() * 5.5 * 24 * 60;
    timestamps.push(new Date(now.getTime() - ageMinutes * 60 * 1_000));
  }
  return (
    timestamps
      .slice(0, HISTORICAL_TASK_COUNT)
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      .sort((left, right) => left.getTime() - right.getTime())
  );
}

function buildHistoricalTasks(now = new Date()): HistoricalTask[] {
  const random = createHistoricalRandom();
  const taskChoices = [
    { queueName: "demo", taskType: RECURRING_TASK_TYPE },
    { queueName: "demo", taskType: REPORT_TASK_TYPE },
    { queueName: "orders", taskType: ORDER_TASK_TYPE },
    { queueName: "orders", taskType: "order.refund" },
    { queueName: "emails", taskType: "email.send" },
    { queueName: "emails", taskType: "email.digest" },
  ] as const;
  const errors = [
    { name: "SMTPError", message: "upstream mail provider returned 451", code: "SMTP_451" },
    { name: "PaymentGatewayError", message: "payment authorization timed out", code: "ETIMEDOUT" },
    {
      name: "ReportError",
      message: "analytics replica was temporarily unavailable",
      code: "DB_REPLICA",
    },
  ] as const;

  return historicalTimestamps(now, random).map((createdAt, index) => {
    const task = taskChoices[Math.floor(random() * taskChoices.length)]!;
    const retried = index % 17 === 0;
    const failed = index % 23 === 0;
    const currentAttempt = retried ? 2 : 1;
    const maxAttempts = failed ? currentAttempt : retried ? 3 : 1;
    const runAt = new Date(createdAt.getTime() + (200 + random() * 8_000));
    const durationMs =
      task.taskType === REPORT_TASK_TYPE
        ? 8_000 + random() * 38_000
        : task.queueName === "emails"
          ? 300 + random() * 4_500
          : 500 + random() * 12_000;
    const finishedAt = new Date(runAt.getTime() + durationMs + (retried ? 4_000 : 0));
    const workerId = HISTORICAL_WORKER_IDS[index % HISTORICAL_WORKER_IDS.length]!;
    const fenceToken = index * 10 + currentAttempt + 1;
    const taskError =
      errors[task.queueName === "emails" ? 0 : task.queueName === "orders" ? 1 : 2]!;
    const error = failed ? taskError : null;
    const customer = ["acme", "globex", "initech", "umbrella"][index % 4]!;
    const context: Json =
      task.queueName === "emails"
        ? {
            recipient: `${customer}.${index + 1}@example.com`,
            template: task.taskType === "email.digest" ? "weekly-activity" : "order-confirmation",
            campaign: `autumn-${customer}`,
          }
        : task.queueName === "orders"
          ? {
              orderId: `ORD-${String(index + 1).padStart(5, "0")}`,
              customer,
              amountCents: 1_500 + Math.floor(random() * 45_000),
              currency: "USD",
              ...(task.taskType === "order.refund"
                ? { reason: "returned-item" }
                : { items: 1 + (index % 5) }),
            }
          : {
              report: task.taskType === REPORT_TASK_TYPE ? "queue-health" : "dependency-health",
              region: ["us-east", "eu-west", "ap-south"][index % 3]!,
              customer,
            };
    const attempts: HistoricalAttempt[] = [];

    if (retried) {
      const retryStartedAt = new Date(runAt);
      const retryFinishedAt = new Date(retryStartedAt.getTime() + 400 + random() * 2_500);
      attempts.push({
        attempt: 1,
        fenceToken: index * 10 + 1,
        workerId: HISTORICAL_WORKER_IDS[(index + 1) % HISTORICAL_WORKER_IDS.length]!,
        outcome: "retry",
        startedAt: retryStartedAt,
        finishedAt: retryFinishedAt,
        error: taskError,
      });
    }

    const finalStartedAt = retried ? new Date(finishedAt.getTime() - durationMs) : new Date(runAt);
    attempts.push({
      attempt: currentAttempt,
      fenceToken,
      workerId,
      outcome: failed ? "failed" : "succeeded",
      startedAt: finalStartedAt,
      finishedAt,
      error,
    });

    return {
      id: randomUUID(),
      queueName: task.queueName,
      taskType: task.taskType,
      payload: {
        demoSeed: HISTORICAL_SEED_NAME,
        sequence: index + 1,
        ...context,
        source: task.queueName === "emails" ? "campaign" : "historical-demo",
      },
      tags:
        task.queueName === "emails"
          ? index % 2 === 0
            ? ["email", "transactional"]
            : ["email", "campaign"]
          : task.taskType === REPORT_TASK_TYPE
            ? ["reports", "weekly"]
            : task.queueName === "orders"
              ? ["billing"]
              : index % 5 === 0
                ? ["demo-test"]
                : [],
      maxAttempts,
      createdAt,
      state: failed ? "failed" : "succeeded",
      currentAttempt,
      fenceToken,
      runAt,
      result: failed
        ? null
        : {
            ok: true,
            durationMs: Math.round(durationMs),
            ...(task.queueName === "emails"
              ? { provider: "demo-mail", delivered: 1 }
              : task.queueName === "orders"
                ? { customer, action: task.taskType === "order.refund" ? "refunded" : "fulfilled" }
                : {
                    rowsProcessed: 100 + index * 13,
                    region: ["us-east", "eu-west", "ap-south"][index % 3]!,
                  }),
          },
      error,
      finishedAt,
      workerId,
      attempts,
    };
  });
}

function heartbeatSchedule(enabled = true) {
  return {
    name: HEARTBEAT_SCHEDULE_NAME,
    schedule: "* * * * *",
    enabled,
    task: {
      type: RECURRING_TASK_TYPE,
      queue: DEMO_QUEUE,
      payload: { source: "worker" },
    },
  } as const;
}

function languageWorkerSchedule(
  name: string,
  schedule: string,
  language: "typescript" | "python" | "go",
  queue: string,
  enabled = true,
) {
  return {
    name,
    schedule,
    enabled,
    task: {
      type: LANGUAGE_WORKER_TASK_TYPE,
      queue,
      payload: { language },
      maxAttempts: 1,
      tags: ["language-worker", language],
    },
  } as const;
}

function sharedWorkerSchedule(enabled = true) {
  return {
    name: SHARED_WORKER_SCHEDULE_NAME,
    schedule: "* * * * *",
    enabled,
    task: {
      type: SHARED_WORKER_TASK_TYPE,
      queue: DEMO_SHARED_QUEUE,
      payload: { source: "schedule" },
      tags: ["shared-worker"],
    },
  } as const;
}

function reportSchedule(enabled = true) {
  return {
    name: REPORT_SCHEDULE_NAME,
    schedule: "*/5 * * * *",
    enabled,
    task: {
      type: REPORT_TASK_TYPE,
      queue: DEMO_QUEUE,
      payload: { report: "queue-health", source: "schedule" },
    },
  } as const;
}

function longRunningSchedule(enabled = true) {
  return {
    name: LONG_RUNNING_SCHEDULE_NAME,
    schedule: "* * * * *",
    enabled,
    task: {
      type: LONG_RUNNING_TASK_TYPE,
      queue: DEMO_QUEUE,
      payload: { source: "schedule", label: "recurring-lightweight-maintenance" },
      maxAttempts: 1,
    },
  } as const;
}

function featureShowcaseSchedules(enabledByName: ReadonlyMap<string, boolean>) {
  return DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => ({
    name: family.scheduleName,
    schedule: family.schedule,
    enabled: enabledByName.get(family.scheduleName) ?? true,
    task: {
      type: family.taskType,
      queue: DEMO_QUEUE,
      payload: {
        source: DEMO_FEATURE_RECURRING_SOURCE,
        family: family.key,
        scenario: "rotating",
        behavior: "rotating",
        label: `${family.title} recurring showcase`,
        durationMs: null,
        waitMs: null,
        checkpointCount: null,
        waitMode: null,
        waitTimeoutMs: null,
        childCount: null,
        role: null,
        memberIndex: null,
        shouldFail: null,
        invoiceId: family.key === "payload-contracts" ? "INV-recurring" : null,
      } satisfies DemoFeaturePayload,
      maxAttempts: family.recurringMaxAttempts,
      retryPolicy: family.recurringRetryPolicy,
    },
  }));
}

async function migrateLegacyFeatureShowcaseTaskTypes(database: DemoDatabase): Promise<void> {
  const featureTaskTypeByFamilyJson = JSON.stringify(
    Object.fromEntries(
      DEMO_FEATURE_SHOWCASE_FAMILIES.map((family) => [family.key, family.taskType]),
    ),
  );
  await database.execute(sql`
    UPDATE workhorse.task AS task
       SET task_type = mapping.replacement_type
      FROM jsonb_each_text(${featureTaskTypeByFamilyJson}::jsonb)
        AS mapping(family, replacement_type)
     WHERE task.task_type = 'demo.feature-showcase'
       AND task.payload->>'source' IN (
         ${DEMO_FEATURE_SHOWCASE_SOURCE},
         ${DEMO_FEATURE_RECURRING_SOURCE}
       )
       AND task.payload->>'family' = mapping.family
  `);
}

const DEMO_SCHEMA_VERSION = 1;

/** Check the demo-owned tables without changing schema state in a long-running process. */
export async function assertDemoSchemaCompatible(database: DemoDatabase): Promise<void> {
  let version: number | undefined;
  try {
    const result = await database.execute<{ version: number }>(sql`
      SELECT version
        FROM public.workhorse_demo_schema_version
       WHERE singleton = true
    `);
    version = result.rows[0]?.version;
    await database.execute(sql`
      SELECT demo_order.id,
             demo_order.customer_email,
             demo_order.description,
             demo_order.status,
             demo_order.created_at,
             demo_order.processed_at,
             demo_seed.name,
             demo_seed.created_at,
             demo_audit.id,
             demo_audit.actor,
             demo_audit.reason,
             demo_audit.request_id,
             demo_audit.occurred_at,
             demo_audit.action,
             demo_audit.target,
             demo_audit.before,
             demo_audit.after,
             demo_audit.status
        FROM public.workhorse_demo_order AS demo_order
        CROSS JOIN public.workhorse_demo_seed AS demo_seed
        CROSS JOIN public.workhorse_demo_audit AS demo_audit
       WHERE false
    `);
  } catch (error) {
    throw new Error(
      isMissingDatabaseRelationError(error)
        ? "The demo schema is not installed. Run the demo schema preparation step before starting the application."
        : "Unable to verify demo schema compatibility because the database query failed.",
      { cause: error },
    );
  }
  if (version !== DEMO_SCHEMA_VERSION) {
    throw new Error(
      `Demo schema version ${String(version)} is incompatible with runtime version ${DEMO_SCHEMA_VERSION}`,
    );
  }
}

export async function installDemoSchema(database: DemoDatabase): Promise<void> {
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.workhorse_demo_order (
      id uuid PRIMARY KEY,
      customer_email text NOT NULL,
      description text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      processed_at timestamptz
    )
  `);
  await database.execute(sql`
    CREATE INDEX IF NOT EXISTS workhorse_demo_order_created_at_idx
    ON public.workhorse_demo_order (created_at DESC)
  `);
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.workhorse_demo_seed (
      name text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.workhorse_demo_audit (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor text NOT NULL CHECK (actor <> ''),
      reason text CONSTRAINT workhorse_demo_audit_reason_check CHECK (
        reason IS NULL OR reason <> ''
      ),
      request_id text NOT NULL CHECK (request_id <> ''),
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      action text NOT NULL CHECK (action <> ''),
      target text NOT NULL CHECK (target <> ''),
      before jsonb,
      after jsonb,
      status text NOT NULL CHECK (status IN ('succeeded', 'failed'))
    )
  `);
  // Cancellation can be intentionally reasonless. Other operator RPCs still require a reason at
  // their contract boundary, while this shared audit table permits null for cancellation rows.
  await database.execute(sql`
    ALTER TABLE public.workhorse_demo_audit
      ALTER COLUMN reason DROP NOT NULL,
      DROP CONSTRAINT IF EXISTS workhorse_demo_audit_reason_check,
      ADD CONSTRAINT workhorse_demo_audit_reason_check CHECK (reason IS NULL OR reason <> '')
  `);
  await database.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS workhorse_demo_audit_request_id_idx
    ON public.workhorse_demo_audit (request_id)
  `);
  await database.execute(sql`
    CREATE INDEX IF NOT EXISTS workhorse_demo_audit_occurred_at_idx
    ON public.workhorse_demo_audit (occurred_at, id)
  `);
  await migrateLegacyFeatureShowcaseTaskTypes(database);
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.workhorse_demo_schema_version (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      version integer NOT NULL
    )
  `);
  await database.execute(sql`
    INSERT INTO public.workhorse_demo_schema_version (singleton, version)
    VALUES (true, ${DEMO_SCHEMA_VERSION})
    ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version
  `);
}

export async function syncDemoSchedules(database: Pool): Promise<void> {
  const queue = new Queue(database, DEMO_QUEUE);
  const existing = await database.query<{ name: string; enabled: boolean }>(
    `SELECT schedule_name AS name, enabled
       FROM workhorse.schedule_definition
      WHERE namespace = $1`,
    [DEMO_SCHEDULE_NAMESPACE],
  );
  const enabledByName = new Map(existing.rows.map((schedule) => [schedule.name, schedule.enabled]));
  await queue.syncSchedules(DEMO_SCHEDULE_NAMESPACE, [
    heartbeatSchedule(enabledByName.get(HEARTBEAT_SCHEDULE_NAME) ?? true),
    languageWorkerSchedule(
      TYPESCRIPT_WORKER_SCHEDULE_NAME,
      "*/3 * * * *",
      "typescript",
      DEMO_QUEUE,
      enabledByName.get(TYPESCRIPT_WORKER_SCHEDULE_NAME) ?? true,
    ),
    languageWorkerSchedule(
      PYTHON_WORKER_SCHEDULE_NAME,
      "1-59/3 * * * *",
      "python",
      DEMO_PYTHON_QUEUE,
      enabledByName.get(PYTHON_WORKER_SCHEDULE_NAME) ?? true,
    ),
    languageWorkerSchedule(
      GO_WORKER_SCHEDULE_NAME,
      "2-59/3 * * * *",
      "go",
      DEMO_GO_QUEUE,
      enabledByName.get(GO_WORKER_SCHEDULE_NAME) ?? true,
    ),
    sharedWorkerSchedule(enabledByName.get(SHARED_WORKER_SCHEDULE_NAME) ?? true),
    reportSchedule(enabledByName.get(REPORT_SCHEDULE_NAME) ?? true),
    longRunningSchedule(enabledByName.get(LONG_RUNNING_SCHEDULE_NAME) ?? true),
    ...featureShowcaseSchedules(enabledByName),
  ]);
}

/** Synchronize the fleet-wide dispatch budget showcased by the seeded long-running tasks. */
export async function syncDemoConcurrencyPolicies(database: Pool): Promise<void> {
  const queue = new Queue(database, DEMO_QUEUE);
  await queue.syncConcurrencyPolicies(DEMO_CONCURRENCY_POLICY_NAMESPACE, [
    {
      queue: DEMO_QUEUE,
      maxActive: DEMO_CONCURRENCY_MAX_ACTIVE,
      maxActivePerKey: DEMO_CONCURRENCY_MAX_ACTIVE_PER_KEY,
    },
  ]);
}

/** Synchronize the token bucket shown by the dedicated partner API queue. */
export async function syncDemoRateLimitPolicies(database: Pool): Promise<void> {
  const queue = new Queue(database, DEMO_QUEUE);
  await queue.syncRateLimitPolicies(DEMO_RATE_LIMIT_POLICY_NAMESPACE, [
    {
      queue: DEMO_RATE_LIMIT_QUEUE,
      rate: DEMO_RATE_LIMIT,
      perKey: DEMO_RATE_LIMIT_PER_KEY,
    },
  ]);
}

function createReadOnlyOperator(): DashboardOperator {
  return { mode: "read-only" };
}

function demoTestTask(
  kind: Parameters<NonNullable<DashboardOperator["enqueueTest"]>>[0],
  scenarioInput?: DurableDemoScenario,
): {
  type: string;
  payload: Json;
  maxAttempts?: number;
  tags: string[];
  idempotency?: DemoIdempotency;
} {
  if (kind === "success") {
    return {
      type: RECURRING_TASK_TYPE,
      payload: { source: "operator" },
      tags: ["demo-test"],
    };
  }
  if (kind === "idempotent") {
    // A fixed key and a payload with no timestamp or random field keep every repeat of this menu
    // action byte-identical, so PostgreSQL returns the first task instead of accepting another.
    // The key is deliberately shared across operators — the dashboard reports the replay through
    // the response's `outcome`, which is what makes the reuse visible rather than a silent no-op.
    return {
      type: RECURRING_TASK_TYPE,
      payload: { source: "operator-idempotent" },
      tags: ["demo-test", "idempotent"],
      idempotency: {
        key: DEMO_OPERATOR_IDEMPOTENCY_KEY,
        scope: DEMO_OPERATOR_IDEMPOTENCY_SCOPE,
        ttlMs: DEMO_IDEMPOTENCY_TTL_MS,
      },
    };
  }
  if (kind === "retry") {
    return {
      type: RETRY_TASK_TYPE,
      payload: { label: "operator-retry", failUntilAttempt: 1 },
      maxAttempts: 3,
      tags: ["demo-test", "durable-checkpoint"],
    };
  }
  if (kind === "durable") {
    const scenario = scenarioInput ?? "order-fulfillment";
    return {
      type: DURABLE_DEMO_TASK_TYPE,
      payload: { scenario },
      maxAttempts: 2,
      tags: ["demo-test", "durable-checkpoint", scenario],
    };
  }
  if (kind === "timer") {
    return {
      type: DURABLE_TIMER_TASK_TYPE,
      payload: { source: "operator" },
      maxAttempts: 1,
      tags: ["demo-test", "durable-checkpoint", "durable-timer"],
    };
  }
  if (kind === "failure") {
    return {
      type: FAILURE_TASK_TYPE,
      payload: { label: "operator-failure" },
      maxAttempts: 1,
      tags: ["demo-test"],
    };
  }
  return {
    type: LONG_RUNNING_TASK_TYPE,
    payload: { label: "operator-long-running" },
    tags: ["demo-test"],
  };
}

/**
 * Redrive the newest unredriven demo dead letter on the operator's behalf.
 *
 * This is the only operator "enqueue" that creates its task through redrive lineage rather than a
 * fresh acceptance, so a visitor can trigger and then inspect a live redrive instead of only the
 * pre-seeded one.
 */
async function redriveLatestDeadLetter(
  database: DemoDatabase,
  audit: AuditContext,
): Promise<{ taskId: string }> {
  return database.transaction(async (transaction) => {
    const workhorse = createDrizzleAdapter(transaction, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const deadLetters = await workhorse.admin.listDeadLetters({ queue: DEMO_QUEUE, limit: 50 });
    const candidate = deadLetters.items.find((deadLetter) => deadLetter.redriveCount === 0);
    if (!candidate) {
      throw new Error("No demo dead letter is awaiting redrive; enqueue a terminal failure first");
    }
    const result = await workhorse.admin.redrive(candidate.taskId, {
      actor: audit.actor,
      reason: audit.reason,
      requestId: audit.requestId,
    });
    if (!result.targetTaskId) {
      throw new Error(`Redrive of ${candidate.taskId} was refused: ${result.status}`);
    }
    await transaction.execute(sql`
      INSERT INTO public.workhorse_demo_audit
        (actor, reason, request_id, occurred_at, action, target, before, after, status)
      VALUES
        (${audit.actor}, ${audit.reason}, ${audit.requestId},
         ${audit.occurredAt ?? new Date().toISOString()}, 'redriveDeadLetter',
         ${`task:${candidate.taskId}`}, ${JSON.stringify({ state: "failed" })}::jsonb,
         ${JSON.stringify({ status: result.status, targetTaskId: result.targetTaskId })}::jsonb,
         'succeeded')
    `);
    return { taskId: result.targetTaskId };
  });
}

/**
 * Enqueue the one live example the dashboard menu declares for a showcase feature family.
 *
 * Every example runs through the ordinary worker path — nothing is claimed or failed on the
 * operator's behalf — so a repeat click always produces a fresh, inspectable demonstration. The
 * batch example enqueues its whole member group in one acceptance so the digest is visible from a
 * single click.
 */
async function enqueueFeatureMenuExample(
  queue: Queue,
  feature: DemoFeatureFamily | undefined,
  priority: number,
): Promise<{ taskId: string; outcome: "accepted" | "replayed"; record: unknown }> {
  if (feature === undefined) throw new Error("The feature demo kind requires a feature family");
  const family = demoFeatureShowcaseFamily(feature);
  const example = DEMO_FEATURE_MENU_EXAMPLES[feature];
  const payload = showcaseSeedPayload(family, example, DEMO_FEATURE_OPERATOR_SOURCE);
  const now = Date.now();
  const options: EnqueueOptions = {
    maxAttempts: example.maxAttempts,
    retryPolicy: example.retryPolicy,
    tags: example.tags,
    priority: example.priority ?? priority,
    ...(example.runAfterMs === undefined ? {} : { runAt: new Date(now + example.runAfterMs) }),
    ...(example.deadlineAfterMs === undefined
      ? {}
      : { deadline: new Date(now + example.deadlineAfterMs) }),
    ...(example.executionTimeoutMs === undefined
      ? {}
      : { executionTimeoutMs: example.executionTimeoutMs }),
  };
  const memberCount = example.seedCount ?? 1;
  const results =
    memberCount === 1
      ? [await queue.enqueueWithResult(family.taskType, payload, options)]
      : await queue.enqueueManyWithResults(
          Array.from({ length: memberCount }, (_, index) => ({
            type: family.taskType,
            payload: { ...payload, memberIndex: index + 1 },
            options,
          })),
        );
  const first = results[0]!;
  return {
    taskId: first.taskId,
    outcome: first.outcome === "replayed" ? ("replayed" as const) : ("accepted" as const),
    record: {
      taskId: first.taskId,
      family: feature,
      scenario: example.scenario,
      type: family.taskType,
      priority: example.priority ?? priority,
      memberCount,
    },
  };
}

async function enqueueOutcomeTestTask(
  queue: Queue,
  kind: Parameters<typeof demoTestTask>[0],
  scenario: DurableDemoScenario | undefined,
  priority: number,
): Promise<{ taskId: string; outcome: "accepted" | "replayed"; record: unknown }> {
  const definition = demoTestTask(kind, scenario);
  const result = await queue.enqueueWithResult(definition.type, definition.payload, {
    ...(definition.maxAttempts === undefined ? {} : { maxAttempts: definition.maxAttempts }),
    ...(definition.idempotency === undefined ? {} : { idempotency: definition.idempotency }),
    priority,
    tags: definition.tags,
  });
  const outcome = result.outcome === "replayed" ? ("replayed" as const) : ("accepted" as const);
  return {
    taskId: result.taskId,
    outcome,
    record: { taskId: result.taskId, ...definition, priority, outcome },
  };
}

export function createLocalOperator(database: DemoDatabase): DashboardOperator {
  return {
    mode: "writable",
    async enqueueTest(kind, audit, scenario, priority = 0, feature) {
      await assertDemoOperatorWorkBudget(database);
      if (kind === "redrive") return redriveLatestDeadLetter(database, audit);
      const target = kind === "feature" ? `task:feature:${feature}` : `task:${kind}`;
      return database.transaction(async (transaction) => {
        const workhorse = createDrizzleAdapter(transaction, {
          defaultQueue: DEMO_QUEUE,
          queueOptions: DEMO_QUEUE_OPTIONS,
        });
        const { taskId, outcome, record } =
          kind === "feature"
            ? await enqueueFeatureMenuExample(workhorse.queue, feature, priority)
            : await enqueueOutcomeTestTask(workhorse.queue, kind, scenario, priority);
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'enqueueTest', ${target},
             NULL, ${JSON.stringify(record)}::jsonb, 'succeeded')
        `);
        return { taskId, outcome };
      });
    },
  };
}

export function createLocalScheduleController(database: DemoDatabase): ScheduleController {
  return {
    async setScheduleEnabled(namespace, name, enabled, audit) {
      const rows = await database.transaction(async (transaction) => {
        const before = await transaction.execute<{ enabled: boolean }>(sql`
          SELECT enabled FROM workhorse.schedule_definition
           WHERE namespace = ${namespace} AND schedule_name = ${name}
           FOR UPDATE
        `);
        if (before.rows.length === 0) throw new Error(`Schedule ${namespace}/${name} not found`);
        const updated = await transaction.execute<{ enabled: boolean }>(sql`
          UPDATE workhorse.schedule_definition
             SET enabled = ${enabled}, revision = revision + 1, updated_at = clock_timestamp()
           WHERE namespace = ${namespace} AND schedule_name = ${name}
           RETURNING enabled
        `);
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'setScheduleEnabled', ${`schedule:${namespace}:${name}`},
             ${JSON.stringify(before.rows[0])}::jsonb, ${JSON.stringify({ enabled })}::jsonb, 'succeeded')
        `);
        return updated.rows;
      });
      return { enabled: rows[0]!.enabled };
    },
  };
}

function isoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function operatorAuditStatus(
  action: DashboardOperatorAction,
  result: unknown,
): "failed" | "succeeded" {
  const status =
    typeof result === "object" && result !== null && "status" in result ? result.status : undefined;
  if (action.kind === "runTaskNow" && (status === "not_found" || status === "waiting")) {
    return "failed";
  }
  if (action.kind === "cancelTask" && status === "not_found") return "failed";
  if (action.kind === "redriveTask" && (status === "not_found" || status === "not_failed")) {
    return "failed";
  }
  return "succeeded";
}

/**
 * Run a shared Admin- and Queue-backed controller action inside the demo's audit transaction.
 *
 * The shared factory owns the Queue calls and result projection. This runner owns only the demo's
 * before snapshot and audit row, preserving the atomic audit boundary without copying controller
 * behavior into the demo host.
 */
export function createLocalOperatorControllers(database: DemoDatabase) {
  return createDashboardOperatorControllers({
    run: (action, operation) =>
      database.transaction(async (transaction) => {
        // Redrives are the only controller actions that admit new tasks; the rest act on existing
        // ones, so they stay available while the budget is saturated (canceling even drains it).
        if (action.kind === "redriveTask" || action.kind === "redriveDeadLetters") {
          await assertDemoOperatorWorkBudget(transaction);
        }
        let before: Json;
        let target: string;
        switch (action.kind) {
          case "setQueuePaused": {
            const rows = await transaction.execute<{ paused: boolean }>(sql`
              SELECT paused FROM workhorse.queue_control
               WHERE queue_name = ${action.queueName} FOR UPDATE
            `);
            before = { paused: rows.rows[0]?.paused ?? false };
            target = `queue:${action.queueName}`;
            break;
          }
          case "purgeQueue": {
            const rows = await transaction.execute<{ purgeable_tasks: number }>(sql`
              SELECT count(*)::integer AS purgeable_tasks
                FROM workhorse.task_runtime
               WHERE queue_name = ${action.queueName} AND state IN ('ready', 'scheduled')
            `);
            before = rows.rows[0] ?? { purgeable_tasks: 0 };
            target = `queue:${action.queueName}`;
            break;
          }
          case "runTaskNow": {
            const rows = await transaction.execute<{
              state: string | null;
              run_at: Date | string | null;
              wait_name: string | null;
            }>(sql`
              SELECT COALESCE(r.state, o.state) AS state,
                     COALESCE(r.run_at, o.run_at) AS run_at,
                     r.wait_name
                FROM workhorse.task j
                LEFT JOIN workhorse.task_runtime r ON r.task_id = j.id
                LEFT JOIN workhorse.task_outcome o ON o.task_id = j.id
               WHERE j.id = ${action.taskId}
            `);
            const row = rows.rows[0];
            before = {
              state: row?.state ?? null,
              runAt: isoTimestamp(row?.run_at ?? null),
              waitName: row?.wait_name ?? null,
            };
            target = `task:${action.taskId}`;
            break;
          }
          case "cancelTask": {
            const rows = await transaction.execute<{ state: string | null }>(sql`
              SELECT COALESCE(r.state, o.state) AS state
                FROM workhorse.task j
                LEFT JOIN workhorse.task_runtime r ON r.task_id = j.id
                LEFT JOIN workhorse.task_outcome o ON o.task_id = j.id
               WHERE j.id = ${action.taskId}
            `);
            before = { state: rows.rows[0]?.state ?? null };
            target = `task:${action.taskId}`;
            break;
          }
          case "signalTask":
          case "completeHumanWait": {
            const rows = await transaction.execute<{ state: string | null }>(sql`
              SELECT COALESCE(r.state, o.state) AS state
                FROM workhorse.task j
                LEFT JOIN workhorse.task_runtime r ON r.task_id = j.id
                LEFT JOIN workhorse.task_outcome o ON o.task_id = j.id
               WHERE j.id = ${action.taskId}
            `);
            before = { state: rows.rows[0]?.state ?? null, name: action.name };
            target = `task:${action.taskId}`;
            break;
          }
          case "redriveTask": {
            const rows = await transaction.execute<{ state: string | null }>(sql`
              SELECT COALESCE(r.state, o.state) AS state
                FROM workhorse.task j
                LEFT JOIN workhorse.task_runtime r ON r.task_id = j.id
                LEFT JOIN workhorse.task_outcome o ON o.task_id = j.id
               WHERE j.id = ${action.taskId}
            `);
            before = { state: rows.rows[0]?.state ?? null };
            target = `task:${action.taskId}`;
            break;
          }
          case "redriveDeadLetters": {
            const { queue, taskType, tags } = action.filter;
            const selectedTags = [...tags];
            const rows = await transaction.execute<{ dead_letters: number }>(sql`
              SELECT count(*)::integer AS dead_letters
                FROM workhorse.task_outcome o
                JOIN workhorse.task j ON j.id = o.task_id
               WHERE o.state = 'failed'
                 AND (${queue}::text IS NULL OR j.queue_name = ${queue})
                 AND (${taskType}::text IS NULL OR j.task_type = ${taskType})
                 AND (cardinality(${selectedTags}::text[]) = 0
                      OR j.tags @> ${selectedTags}::text[])
            `);
            // The whole selection, not the page: the audit row then shows how much of the backlog
            // this bounded request could reach.
            before = {
              deadLetters: rows.rows[0]?.dead_letters ?? 0,
              limit: action.limit,
              continued: action.cursor !== null,
            };
            target = `dead-letters:${queue ?? "*"}/${taskType ?? "*"}`;
            break;
          }
          case "setWorkerPaused": {
            const rows = await transaction.execute<{ paused: boolean }>(sql`
              SELECT paused FROM workhorse.worker_registry
               WHERE worker_id = ${action.workerId} FOR UPDATE
            `);
            before = { paused: rows.rows[0]?.paused ?? false };
            target = `worker:${action.workerId}`;
            break;
          }
        }
        const workhorse = createDrizzleAdapter(transaction, {
          defaultQueue: DEMO_QUEUE,
          queueOptions: DEMO_QUEUE_OPTIONS,
        });
        const result = await operation({
          admin: new Admin(workhorse.database),
          queue: workhorse.queue,
        });
        const status = operatorAuditStatus(action, result);
        const audit = action.audit;
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, ${action.kind},
             ${target}, ${JSON.stringify(before)}::jsonb,
             ${JSON.stringify(result)}::jsonb, ${status})
        `);
        return result;
      }),
  });
}

function createLocalSettingsController(database: DemoDatabase): SettingsController {
  async function mutate(
    action: string,
    target: string,
    audit: AuditContext,
    change: (queue: Queue) => Promise<unknown>,
  ): Promise<void> {
    await database.transaction(async (transaction) => {
      const workhorse = createDrizzleAdapter(transaction, {
        defaultQueue: DEMO_QUEUE,
        queueOptions: DEMO_QUEUE_OPTIONS,
      });
      const before = {
        maintenance: await workhorse.queue.getMaintenancePolicy(),
        retention: await workhorse.queue.getRetentionPolicy(),
      };
      await change(workhorse.queue);
      const after = {
        maintenance: await workhorse.queue.getMaintenancePolicy(),
        retention: await workhorse.queue.getRetentionPolicy(),
      };
      await transaction.execute(sql`
        INSERT INTO public.workhorse_demo_audit
          (actor, reason, request_id, occurred_at, action, target, before, after, status)
        VALUES
          (${audit.actor}, ${audit.reason}, ${audit.requestId},
           ${audit.occurredAt ?? new Date().toISOString()}, ${action}, ${target},
           ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, 'succeeded')
      `);
    });
  }
  return {
    overrideMaintenancePolicy: (definition, audit) =>
      mutate("overrideMaintenancePolicy", "maintenance-policy", audit, (queue) =>
        queue.overrideMaintenancePolicy(definition),
      ),
    revertMaintenancePolicy: (settings, audit) =>
      mutate("revertMaintenancePolicy", "maintenance-policy", audit, (queue) =>
        queue.revertMaintenancePolicy(settings),
      ),
    overrideRetentionPolicy: (definition, audit) =>
      mutate("overrideRetentionPolicy", "retention-policy", audit, (queue) =>
        queue.overrideRetentionPolicy(definition),
      ),
    revertRetentionPolicy: (settings, audit) =>
      mutate("revertRetentionPolicy", "retention-policy", audit, (queue) =>
        queue.revertRetentionPolicy(settings),
      ),
  };
}

export function createDemoApplication(
  database: DemoDatabase,
  options: CreateDemoApplicationOptions = {},
) {
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEMO_MAINTENANCE_INTERVAL_MS;
  const environment = options.environment ?? "development";
  const publicOrigin = options.publicOrigin
    ? normalizeDashboardPublicOrigin(options.publicOrigin)
    : undefined;
  const localControllers = createLocalOperatorControllers(database);
  // Worker pause state is durable and fleet-wide; it survives restarts and reaches remote workers.
  const workerController = options.workerController ?? localControllers.workerController;
  // Cancellation is offered only where the rest of the mutating operator surface is. A read-only
  // deployment keeps exactly the dashboard it had, with no cancel action anywhere.
  const taskController =
    options.taskController ??
    (options.operator?.mode === "writable" ? localControllers.taskController : undefined);
  const settingsController =
    options.settingsController ??
    (options.operator?.mode === "writable" ? createLocalSettingsController(database) : undefined);
  const adapter = createDrizzleAdapter(database, {
    defaultQueue: DEMO_QUEUE,
    queueOptions: DEMO_QUEUE_OPTIONS,
  });
  const app = new Hono();

  app.use("*", async (context, next) => {
    await next();
    context.res.headers.set("Content-Security-Policy", DEMO_CONTENT_SECURITY_POLICY);
    context.res.headers.set("X-Content-Type-Options", "nosniff");
    context.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    context.res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  });

  app.get("/robots.txt", (context) => context.text("User-agent: *\nDisallow: /\n"));

  // Kamal keeps the previous container on traffic until this process has prepared its schema and
  // opened the HTTP listener. Keep the probe outside dashboard authentication and database reads.
  app.get("/up", (context) => context.json({ status: "ok" }));

  if (options.dashboard !== false) {
    const production = {
      database: adapter.database,
      environment,
      operator: options.operator ?? createReadOnlyOperator(),
      scheduleController: options.scheduleController,
      queueController: options.queueController,
      taskController,
      workerController,
      settingsController,
    };
    const stagingAdapter = options.stagingDatabase
      ? createDrizzleAdapter(options.stagingDatabase, {
          defaultQueue: DEMO_QUEUE,
          queueOptions: DEMO_QUEUE_OPTIONS,
        })
      : undefined;
    const dashboard = createDashboardHost({
      path: "/",
      // Open access is the local default; configured credentials switch the host to the packaged
      // single-administrator login so the authentication flow itself is demonstrable.
      ...(options.singleAdmin ? { singleAdmin: options.singleAdmin } : { authorize: () => true }),
      ...(stagingAdapter
        ? {
            workspaces: {
              production: {
                ...production,
                ...(options.databaseHost ? { databaseHost: options.databaseHost } : {}),
                ...(options.databaseName ? { databaseName: options.databaseName } : {}),
              },
              // Staging stays read-only with no controllers: the switcher should show a visibly
              // different workspace, and a quiet seeded database is the demonstration.
              staging: {
                database: stagingAdapter.database,
                environment: "staging",
                operator: createReadOnlyOperator(),
                ...(options.stagingDatabaseHost
                  ? { databaseHost: options.stagingDatabaseHost }
                  : {}),
                ...(options.stagingDatabaseName
                  ? { databaseName: options.stagingDatabaseName }
                  : {}),
              },
            },
            defaultWorkspace: "production",
          }
        : production),
      maintenanceLoops: { tickIntervalMs: maintenanceIntervalMs },
      projectDurability: durableDemoPlanForTask,
      // Visitors can intentionally fail tasks, so task details must not reveal container paths.
      redactErrorStacks: true,
      auditActor: "local-demo",
      dev: options.dev,
    });
    app.all("*", async (context) => {
      const request = context.req.raw;
      const requestUrl = new URL(request.url);
      const dashboardRequest = publicOrigin
        ? new Request(
            new URL(`${requestUrl.pathname}${requestUrl.search}`, `${publicOrigin}/`),
            request,
          )
        : request;
      const response = await dashboard.handle(dashboardRequest);
      return response ? addGoogleAnalytics(response) : context.notFound();
    });
  }

  return { app, queue: adapter.queue, workerController };
}

function jsonbValue(value: Json | null) {
  return value === null ? sql`NULL` : sql`${JSON.stringify(value)}::jsonb`;
}

function textArrayValue(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

async function seedHistoricalDemoData(database: DemoDatabase): Promise<number> {
  return database.transaction(async (transaction) => {
    // Prepare every UTC day touched by the seven-day seed window so session-local current_date
    // cannot leave the previous UTC day in the default partition near midnight.
    await transaction.execute(sql`
      SELECT workhorse.create_history_day_v1(
               ((clock_timestamp() AT TIME ZONE 'UTC')::date - day_offset)::date
             )
        FROM generate_series(0, 7) AS days(day_offset)
    `);
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${HISTORICAL_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) return 0;

    const tasks = buildHistoricalTasks();
    await transaction.execute(sql`
      INSERT INTO workhorse.task
        (id, queue_name, task_type, payload, tags, max_attempts, created_at)
      VALUES ${sql.join(
        tasks.map(
          (task) => sql`(
            ${task.id}, ${task.queueName}, ${task.taskType}, ${JSON.stringify(task.payload)}::jsonb,
            ${textArrayValue(task.tags)},
            ${task.maxAttempts}, ${task.createdAt}
          )`,
        ),
        sql`, `,
      )}
    `);
    await transaction.execute(sql`
      INSERT INTO workhorse.task_outcome
        (task_id, state, current_attempt, fence_token, run_at, result, error, finished_at, updated_at)
      VALUES ${sql.join(
        tasks.map(
          (task) => sql`(
            ${task.id}, ${task.state}, ${task.currentAttempt}, ${task.fenceToken}, ${task.runAt},
            ${jsonbValue(task.result)}, ${jsonbValue(task.error)}, ${task.finishedAt}, ${task.finishedAt}
          )`,
        ),
        sql`, `,
      )}
    `);
    await transaction.execute(sql`
      INSERT INTO workhorse.attempt_history
        (task_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at)
      VALUES ${sql.join(
        tasks.flatMap((task) =>
          task.attempts.map(
            (attempt) => sql`(
              ${task.id}, ${attempt.attempt}, ${attempt.fenceToken}, ${attempt.workerId},
              ${attempt.outcome}, ${attempt.startedAt}, ${attempt.startedAt}, ${attempt.finishedAt},
              ${jsonbValue(attempt.error)}, ${attempt.finishedAt}
            )`,
          ),
        ),
        sql`, `,
      )}
    `);
    return tasks.length;
  });
}

async function seedLongRunningDemoData(database: DemoDatabase): Promise<string[]> {
  return database.transaction(async (transaction) => {
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${LONG_RUNNING_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) return [];

    const workhorse = createDrizzleAdapter(transaction, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const taskIds: string[] = [];
    const runAt = new Date(Date.now() + DEMO_LONG_RUNNING_SEED_DELAY_MS);
    for (const task of DEMO_LONG_RUNNING_SEED_TASKS) {
      taskIds.push(
        await workhorse.queue.enqueue(
          LONG_RUNNING_TASK_TYPE,
          { source: "long-running-seed", label: task.label },
          {
            concurrencyKey: task.concurrencyKey,
            maxAttempts: 1,
            runAt,
            tags: ["demo-test", "long-running", "low-resource", "concurrency-policy"],
          },
        ),
      );
    }
    return taskIds;
  });
}

async function seedRateLimitDemoData(database: DemoDatabase): Promise<string[]> {
  return database.transaction(async (transaction) => {
    const workhorse = createDrizzleAdapter(transaction, {
      defaultQueue: DEMO_RATE_LIMIT_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    await workhorse.queue.syncRateLimitPolicies(DEMO_RATE_LIMIT_POLICY_NAMESPACE, [
      {
        queue: DEMO_RATE_LIMIT_QUEUE,
        rate: DEMO_RATE_LIMIT,
        perKey: DEMO_RATE_LIMIT_PER_KEY,
      },
    ]);
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${DEMO_RATE_LIMIT_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) return [];

    const taskIds: string[] = [];
    for (const task of DEMO_RATE_LIMIT_SEED_TASKS) {
      taskIds.push(
        await workhorse.queue.enqueue(
          RECURRING_TASK_TYPE,
          { source: "rate-limit-seed", label: task.label },
          {
            concurrencyKey: task.concurrencyKey,
            maxAttempts: 1,
            tags: ["demo-test", "rate-limit", "partner-api"],
          },
        ),
      );
    }

    // Consume the initial burst through the public claim path. Two customers start immediately;
    // the remaining tasks stay ready so the queue page visibly explains why they are throttled.
    for (const workerId of ["rate-limit-seed-a", "rate-limit-seed-b"]) {
      const claimed = await workhorse.queue.claim(workerId, { queue: DEMO_RATE_LIMIT_QUEUE });
      if (!claimed) throw new Error("Expected the demo rate-limit burst to admit two tasks");
      await workhorse.queue.complete(claimed, workerId, { seeded: true });
    }
    return taskIds;
  });
}

function showcaseSeedPayload(
  family: DemoFeatureShowcaseFamily,
  example: DemoFeatureExample,
  source: DemoFeaturePayload["source"] = DEMO_FEATURE_SHOWCASE_SOURCE,
): DemoFeaturePayload {
  return {
    source,
    family: family.key,
    scenario: example.scenario,
    behavior: example.behavior,
    label: example.label,
    durationMs: example.durationMs ?? null,
    waitMs: example.waitMs ?? null,
    checkpointCount: example.checkpointCount ?? null,
    waitMode: example.waitMode ?? null,
    waitTimeoutMs: example.waitTimeoutMs ?? null,
    childCount: example.childCount ?? null,
    role: null,
    memberIndex: null,
    shouldFail: null,
    // The v1 contract requires a non-empty invoiceId on every accepted payload of this type.
    invoiceId: family.key === "payload-contracts" ? `INV-${example.scenario}` : null,
  };
}

/** Enqueue the declared prerequisites, then the dependent gated on all of them. */
async function seedDependencyChain(
  queue: Queue,
  family: DemoFeatureShowcaseFamily,
  example: DemoFeatureExample,
  payload: DemoFeaturePayload,
): Promise<string[]> {
  const spec = example.seedDependency!;
  const prerequisiteTaskIds: string[] = [];
  for (const prerequisite of spec.prerequisites) {
    prerequisiteTaskIds.push(
      await queue.enqueue(
        family.taskType,
        {
          ...payload,
          behavior: prerequisite.behavior,
          label: prerequisite.label,
          role: "prerequisite",
        },
        {
          maxAttempts: prerequisite.maxAttempts ?? 1,
          tags: [...example.tags, "prerequisite"],
          ...(prerequisite.runAt === undefined ? {} : { runAt: prerequisite.runAt }),
        },
      ),
    );
  }
  const dependentTaskId = await queue.enqueue(
    family.taskType,
    { ...payload, role: "dependent" },
    {
      maxAttempts: example.maxAttempts,
      tags: [...example.tags, "dependent"],
      dependencies: {
        prerequisiteTaskIds,
        onSuccess: "release",
        onFailure: spec.onFailure,
        onCancellation: spec.onCancellation,
      },
    },
  );
  return [...prerequisiteTaskIds, dependentTaskId];
}

/** One keyed debounce acceptance plus its declared replacements; one retained task survives. */
async function seedDebouncedScenario(
  queue: Queue,
  family: DemoFeatureShowcaseFamily,
  example: DemoFeatureExample,
  payload: DemoFeaturePayload,
): Promise<string> {
  const spec = example.seedDebounce!;
  const debounce = {
    key: `showcase-${example.scenario}`,
    scope: "workhorse-demo:feature-showcase",
    windowMs: spec.windowMs,
    schedule: spec.schedule,
  };
  const first = await queue.enqueueWithResult(family.taskType, payload, {
    maxAttempts: example.maxAttempts,
    tags: example.tags,
    debounce,
  });
  if (first.outcome !== "accepted") {
    throw new Error(`Expected ${example.scenario} to be accepted, got ${first.outcome}`);
  }
  for (let replacement = 1; replacement <= spec.replacements; replacement += 1) {
    const replaced = await queue.enqueueWithResult(
      family.taskType,
      { ...payload, label: `${example.label} (replacement ${replacement})` },
      { maxAttempts: example.maxAttempts, tags: example.tags, debounce },
    );
    if (replaced.outcome !== "replaced" || replaced.taskId !== first.taskId) {
      throw new Error(`Expected ${example.scenario} replacement, got ${replaced.outcome}`);
    }
  }
  return first.taskId;
}

/** Seed one keyed throttle shape and assert the coalesced dispositions PostgreSQL reports. */
async function seedThrottledScenario(
  queue: Queue,
  family: DemoFeatureShowcaseFamily,
  example: DemoFeatureExample,
  payload: DemoFeaturePayload,
): Promise<string[]> {
  const spec = example.seedThrottle!;
  const scope = "workhorse-demo:feature-showcase";
  const options = (key: string): EnqueueOptions => ({
    maxAttempts: example.maxAttempts,
    tags: example.tags,
    throttle: { key, scope, windowMs: spec.windowMs },
  });
  if (spec.shape === "per-key") {
    const taskIds: string[] = [];
    for (const lane of ["lane-a", "lane-b"]) {
      const result = await queue.enqueueWithResult(
        family.taskType,
        { ...payload, label: `${example.label} (${lane})` },
        options(`showcase-${example.scenario}-${lane}`),
      );
      if (result.outcome !== "accepted") {
        throw new Error(`Expected independent ${lane} acceptance, got ${result.outcome}`);
      }
      taskIds.push(result.taskId);
    }
    return taskIds;
  }
  const key = `showcase-${example.scenario}`;
  if (spec.shape === "burst") {
    // Throttled repeats coalesce only when they are equivalent, so every burst member carries
    // the identical payload; a differing repeat would be a conflict, not a coalescence.
    const results = await queue.enqueueManyWithResults(
      Array.from({ length: 3 }, () => ({
        type: family.taskType,
        payload,
        options: options(key),
      })),
    );
    const [accepted, ...coalesced] = results;
    if (accepted!.outcome !== "accepted" || coalesced.some((r) => r.outcome !== "coalesced")) {
      throw new Error(`Expected one accepted burst member for ${example.scenario}`);
    }
    return [accepted!.taskId];
  }
  const first = await queue.enqueueWithResult(family.taskType, payload, options(key));
  if (first.outcome !== "accepted") {
    throw new Error(`Expected ${example.scenario} acceptance, got ${first.outcome}`);
  }
  const repeat = await queue.enqueueWithResult(family.taskType, payload, options(key));
  if (repeat.outcome !== "coalesced" || repeat.taskId !== first.taskId) {
    throw new Error(`Expected ${example.scenario} repeat to coalesce, got ${repeat.outcome}`);
  }
  return [first.taskId];
}

export async function seedDemoData(database: DemoDatabase) {
  const rateLimitTaskIds = await seedRateLimitDemoData(database);
  // These tasks are inserted first but start after a short grace period, so startup work is never
  // starved. Their handler only awaits a Node timer, occupying slots without burning CPU or memory.
  const longRunningTaskIds = await seedLongRunningDemoData(database);
  const featureShowcaseTaskIds = await database.transaction(async (transaction) => {
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${DEMO_FEATURE_SHOWCASE_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) return [] as string[];

    const workhorse = createDrizzleAdapter(transaction, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const taskIds: string[] = [];
    for (const family of DEMO_FEATURE_SHOWCASE_FAMILIES) {
      for (const example of family.examples) {
        const payload = showcaseSeedPayload(family, example);
        const now = Date.now();
        const enqueueOptions: EnqueueOptions = {
          maxAttempts: example.maxAttempts,
          retryPolicy: example.retryPolicy,
          tags: example.tags,
          ...(example.priority === undefined ? {} : { priority: example.priority }),
          ...(example.runAfterMs === undefined
            ? {}
            : { runAt: new Date(now + example.runAfterMs) }),
          ...(example.deadlineAfterMs === undefined
            ? {}
            : { deadline: new Date(now + example.deadlineAfterMs) }),
          ...(example.executionTimeoutMs === undefined
            ? {}
            : { executionTimeoutMs: example.executionTimeoutMs }),
          ...(example.idempotencyKey === undefined
            ? {}
            : {
                idempotency: {
                  key: example.idempotencyKey,
                  scope: "workhorse-demo:feature-showcase",
                  ttlMs: DEMO_IDEMPOTENCY_TTL_MS,
                },
              }),
        };

        if (example.seedTransition) {
          const queue = `showcase-${example.scenario}`;
          const isolated = createDrizzleAdapter(transaction, {
            defaultQueue: queue,
            queueOptions: DEMO_QUEUE_OPTIONS,
          });
          const sourceTaskId = await isolated.queue.enqueue(
            family.taskType,
            payload,
            enqueueOptions,
          );
          taskIds.push(sourceTaskId);
          const workerId = `showcase-seed-${example.scenario}`;
          const claimed = await isolated.queue.claim(workerId, { queue });
          if (!claimed || claimed.id !== sourceTaskId) {
            throw new Error(`Could not claim showcase dead letter ${example.scenario}`);
          }
          const failedState = await isolated.queue.fail(
            claimed,
            workerId,
            new Error(`Intentional seeded dead letter for ${example.scenario}`),
          );
          if (failedState !== "failed") {
            throw new Error(`Expected ${example.scenario} to become a dead letter`);
          }
          if (example.seedTransition !== "fail") {
            const request = {
              actor: "demo-seed",
              reason: `Show redrive lineage for ${example.scenario}`,
              requestId: `feature-showcase:${example.scenario}`,
            };
            const redrive = await isolated.admin.redrive(sourceTaskId, request);
            if (!redrive.targetTaskId)
              throw new Error(`Redrive did not create ${example.scenario}`);
            taskIds.push(redrive.targetTaskId);
            if (example.seedTransition === "fail-and-redrive-replay") {
              const replay = await isolated.admin.redrive(sourceTaskId, request);
              if (replay.status !== "replayed" || replay.targetTaskId !== redrive.targetTaskId) {
                throw new Error("Expected idempotent showcase redrive replay");
              }
            }
            const target = await isolated.queue.claim(workerId, { queue });
            if (!target || target.id !== redrive.targetTaskId) {
              throw new Error(`Could not claim redrive target ${example.scenario}`);
            }
            await isolated.queue.complete(target, workerId, {
              family: family.key,
              scenario: example.scenario,
              redriven: true,
            });
          }
          continue;
        }

        if (example.seedDependency) {
          taskIds.push(...(await seedDependencyChain(workhorse.queue, family, example, payload)));
          continue;
        }
        if (example.seedDebounce) {
          taskIds.push(await seedDebouncedScenario(workhorse.queue, family, example, payload));
          continue;
        }
        if (example.seedThrottle) {
          taskIds.push(...(await seedThrottledScenario(workhorse.queue, family, example, payload)));
          continue;
        }
        if (example.seedCount !== undefined) {
          const memberCount = example.seedCount;
          taskIds.push(
            ...(await workhorse.queue.enqueueMany(
              Array.from({ length: memberCount }, (_, index) => ({
                type: family.taskType,
                payload: {
                  ...payload,
                  memberIndex: index + 1,
                  ...(example.failLastMember && index === memberCount - 1
                    ? { shouldFail: true }
                    : {}),
                },
                options: enqueueOptions,
              })),
            )),
          );
          continue;
        }

        const taskId = await workhorse.queue.enqueue(family.taskType, payload, enqueueOptions);
        taskIds.push(taskId);
        if (example.idempotencyKey) {
          const replayedTaskId = await workhorse.queue.enqueue(
            family.taskType,
            payload,
            enqueueOptions,
          );
          if (replayedTaskId !== taskId) throw new Error("Expected showcase enqueue replay");
        }
        if (example.afterEnqueue === "cancel") {
          await workhorse.queue.cancel(taskId, {
            requestedBy: "demo-seed",
            reason: `Seeded ${example.scenario} cancellation`,
          });
        }
      }
    }
    return taskIds;
  });
  const representativeSeed = await database.transaction(async (transaction) => {
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${REPRESENTATIVE_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) {
      return { expiredDeadlineId: null, taskIds: [] as string[] };
    }

    const workhorse = createDrizzleAdapter(transaction, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    const seededTaskIds: string[] = [];
    const orderId = randomUUID();
    await transaction.insert(orders).values({
      id: orderId,
      customerEmail: "demo.operator@example.com",
      description: "Inspect a successful transactional order",
      status: "queued",
    });
    seededTaskIds.push(
      await workhorse.queue.enqueue(ORDER_TASK_TYPE, { orderId }, { tags: ["billing"] }),
    );
    seededTaskIds.push(
      await workhorse.queue.enqueue(
        DURABLE_TIMER_TASK_TYPE,
        { source: "representative-seed" },
        { maxAttempts: 1, tags: ["demo-test", "durable-checkpoint", "durable-timer"] },
      ),
    );
    seededTaskIds.push(
      await workhorse.queue.enqueue(
        RETRY_TASK_TYPE,
        { label: "recover-with-durable-checkpoint", failUntilAttempt: 1 },
        {
          maxAttempts: 3,
          // The recoverable seed keeps a fixed policy at the previous worker-side delay, so the
          // drawer shows a persisted policy without slowing the visible recovery.
          retryPolicy: DEMO_RECOVERABLE_RETRY_POLICY,
          tags: ["demo-test", "durable-checkpoint"],
        },
      ),
    );
    seededTaskIds.push(
      await workhorse.queue.enqueue(
        FAILURE_TASK_TYPE,
        { label: "terminal-failure" },
        { maxAttempts: 1, tags: ["demo-test"] },
      ),
    );
    // One representative keyed task so a fresh dashboard shows the deduplication surface without
    // an operator having to act first. It stays an ordinary successful task; nothing about the
    // seed pretends a conflict or a degraded state occurred.
    seededTaskIds.push(
      await workhorse.queue.enqueue(
        RECURRING_TASK_TYPE,
        { source: "keyed-seed" },
        {
          tags: ["demo-test", "idempotent"],
          idempotency: {
            key: DEMO_SEED_IDEMPOTENCY_KEY,
            scope: DEMO_SEED_IDEMPOTENCY_SCOPE,
            ttlMs: DEMO_IDEMPOTENCY_TTL_MS,
          },
        },
      ),
    );
    const expiredDeadlineId = await workhorse.queue.enqueue(
      TIMING_TASK_TYPE,
      { durationMs: 0, source: "expired-deadline-seed" },
      {
        deadline: new Date(Date.now() - 1_000),
        maxAttempts: 1,
        tags: ["demo-test", "deadline", "intentionally-expired"],
      },
    );
    seededTaskIds.push(expiredDeadlineId);
    seededTaskIds.push(
      await workhorse.queue.enqueue(
        TIMING_TASK_TYPE,
        { durationMs: DEMO_TIMING_HANDLER_MS, source: "execution-timeout-seed" },
        {
          executionTimeoutMs: DEMO_TIMING_TIMEOUT_MS,
          maxAttempts: 1,
          tags: ["demo-test", "execution-timeout", "intentionally-timed-out"],
        },
      ),
    );
    const timingPolicyRunAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    seededTaskIds.push(
      await workhorse.queue.enqueue(
        TIMING_TASK_TYPE,
        { durationMs: 10, source: "timing-policy-seed" },
        {
          runAt: timingPolicyRunAt,
          deadline: new Date(timingPolicyRunAt.getTime() + 24 * 60 * 60 * 1_000),
          executionTimeoutMs: DEMO_TIMING_POLICY_TIMEOUT_MS,
          maxAttempts: 1,
          tags: ["demo-test", "deadline", "execution-timeout", "deployment-safe"],
        },
      ),
    );
    for (const scenario of Object.keys(durableDemoScenarios) as DurableDemoScenario[]) {
      seededTaskIds.push(
        await workhorse.queue.enqueue(
          DURABLE_DEMO_TASK_TYPE,
          { scenario },
          { maxAttempts: 2, tags: ["demo-test", "durable-checkpoint", scenario] },
        ),
      );
    }
    for (const [index, scenario] of (
      Object.keys(durableDemoScenarios) as DurableDemoScenario[]
    ).entries()) {
      const retryDelayMs = DEMO_PERSISTENT_RETRY_DELAYS_MS[index]!;
      const retryPolicy = DEMO_PERSISTENT_RETRY_POLICIES[index]!;
      seededTaskIds.push(
        await workhorse.queue.enqueue(
          DURABLE_DEMO_TASK_TYPE,
          {
            scenario,
            failureMode: "continuous",
            source: "persistent-failure-seed",
          },
          {
            maxAttempts: 25,
            retryPolicy,
            tags: [
              "demo-test",
              "durable-checkpoint",
              "intentionally-failing",
              scenario,
              `retry-${retryDelayMs / 60_000}m`,
            ],
          },
        ),
      );
    }
    seededTaskIds.push(
      await workhorse.queue.enqueue(
        RECURRING_TASK_TYPE,
        { source: "scheduled-seed" },
        { runAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), tags: ["reports", "weekly"] },
      ),
    );
    return { expiredDeadlineId, taskIds: seededTaskIds };
  });

  if (representativeSeed.expiredDeadlineId !== null) {
    const workhorse = createDrizzleAdapter(database, {
      defaultQueue: DEMO_QUEUE,
      queueOptions: DEMO_QUEUE_OPTIONS,
    });
    await workhorse.queue.recoverExpired();
    const expiredDeadline = await workhorse.admin.getTask(representativeSeed.expiredDeadlineId);
    if (expiredDeadline?.state !== "failed") {
      throw new Error("Expected the representative expired deadline to be materialized");
    }
  }

  const historicalTaskCount = await seedHistoricalDemoData(database);
  const taskIds = [
    ...rateLimitTaskIds,
    ...longRunningTaskIds,
    ...featureShowcaseTaskIds,
    ...representativeSeed.taskIds,
  ];
  return {
    seeded: taskIds.length > 0 || historicalTaskCount > 0,
    taskIds,
    historicalTaskCount,
  };
}

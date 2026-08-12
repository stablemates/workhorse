import { randomUUID } from "node:crypto";
import { createDrizzleAdapter } from "@workhorse/drizzle";
import {
  createDashboardHost,
  createDashboardOperatorControllers,
  type DashboardOperatorAction,
} from "@workhorse/dashboard/server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type EnqueueOptions,
  Queue,
  type CancelStatus,
  type Json,
  type JobState,
  type MaintenancePolicyDefinition,
  type MaintenancePolicySetting,
  type RetentionPolicyDefinition,
  type RetentionPolicySetting,
} from "@workhorse/core";
import type { Pool } from "pg";
import {
  DURABLE_DEMO_JOB_TYPE,
  type DurableDemoScenario,
  durableDemoPlanForJob,
  durableDemoScenarios,
} from "./durable-demo.js";
import {
  DEMO_FEATURE_RECURRING_SOURCE,
  DEMO_FEATURE_SHOWCASE_FAMILIES,
  DEMO_FEATURE_SHOWCASE_JOB_TYPE,
  DEMO_FEATURE_SHOWCASE_SEED_NAME,
  DEMO_FEATURE_SHOWCASE_SOURCE,
  type DemoFeaturePayload,
} from "./feature-showcase.js";
import type { DemoDatabase } from "./database.js";

import {
  DEMO_CONCURRENCY_MAX_ACTIVE,
  DEMO_CONCURRENCY_MAX_ACTIVE_PER_KEY,
  DEMO_CONCURRENCY_POLICY_NAMESPACE,
  DEMO_IDEMPOTENCY_TTL_MS,
  DEMO_LONG_RUNNING_SEED_DELAY_MS,
  DEMO_LONG_RUNNING_SEED_JOBS,
  DEMO_MAINTENANCE_INTERVAL_MS,
  DEMO_OPERATOR_IDEMPOTENCY_KEY,
  DEMO_OPERATOR_IDEMPOTENCY_SCOPE,
  DEMO_PERSISTENT_RETRY_DELAYS_MS,
  DEMO_PERSISTENT_RETRY_POLICIES,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT,
  DEMO_RATE_LIMIT_PER_KEY,
  DEMO_RATE_LIMIT_POLICY_NAMESPACE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_RATE_LIMIT_SEED_JOBS,
  DEMO_RATE_LIMIT_SEED_NAME,
  DEMO_RECOVERABLE_RETRY_POLICY,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_SEED_IDEMPOTENCY_KEY,
  DEMO_SEED_IDEMPOTENCY_SCOPE,
  DEMO_TIMING_HANDLER_MS,
  DEMO_TIMING_POLICY_TIMEOUT_MS,
  DEMO_TIMING_TIMEOUT_MS,
  DURABLE_TIMER_JOB_TYPE,
  FAILURE_JOB_TYPE,
  HEARTBEAT_SCHEDULE_NAME,
  HISTORICAL_JOB_COUNT,
  HISTORICAL_SEED_NAME,
  HISTORICAL_WORKER_IDS,
  LONG_RUNNING_JOB_TYPE,
  LONG_RUNNING_SCHEDULE_NAME,
  LONG_RUNNING_SEED_NAME,
  ORDER_JOB_TYPE,
  RECURRING_JOB_TYPE,
  REPORT_JOB_TYPE,
  REPORT_SCHEDULE_NAME,
  REPRESENTATIVE_SEED_NAME,
  RETRY_JOB_TYPE,
  TIMING_JOB_TYPE,
} from "./constants.js";
import { orders } from "./schema.js";

export * from "./constants.js";

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
}

export interface AuditContext {
  actor: string;
  reason: string;
  requestId: string;
  occurredAt?: string;
}

export interface CancellationAuditContext extends Omit<AuditContext, "reason"> {
  reason: string | null;
}

export interface DashboardOperator {
  mode: "read-only" | "local";
  enqueueTest?: (
    kind: "success" | "retry" | "durable" | "timer" | "failure" | "idempotent" | "long-running",
    audit: AuditContext,
    scenario?: DurableDemoScenario,
  ) => Promise<{ jobId: string }>;
}

export interface ScheduleController {
  setScheduleEnabled?: (
    namespace: string,
    name: string,
    enabled: boolean,
    audit: AuditContext,
  ) => Promise<{ enabled: boolean }>;
}

export interface QueueController {
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
export interface DemoCancelTaskResult {
  status: CancelStatus;
  jobId: string;
  state: JobState | null;
  currentAttempt: number | null;
  requestedAt: string | null;
  requestedBy: string | null;
  reason: string | null;
  finishedAt: string | null;
}

export interface TaskController {
  runTaskNow?: (
    jobId: string,
    audit: AuditContext,
  ) => Promise<{
    status: "released" | "already_ready" | "not_scheduled" | "waiting" | "not_found";
    id: string;
    state: string | null;
    runAt: string | null;
  }>;
  cancelTask?: (jobId: string, audit: CancellationAuditContext) => Promise<DemoCancelTaskResult>;
}

export interface WorkerController {
  setWorkerPaused?: (
    workerId: string,
    paused: boolean,
    audit: AuditContext,
  ) => Promise<{ paused: boolean }>;
}

export { createDemoDatabase } from "./database.js";
export type { DemoDatabase } from "./database.js";

interface HistoricalJob {
  id: string;
  queueName: string;
  jobType: string;
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
  while (timestamps.length < HISTORICAL_JOB_COUNT) {
    const ageMinutes = 24 * 60 + random() * 5.5 * 24 * 60;
    timestamps.push(new Date(now.getTime() - ageMinutes * 60 * 1_000));
  }
  return (
    timestamps
      .slice(0, HISTORICAL_JOB_COUNT)
      // oxlint-disable-next-line unicorn/no-array-sort -- ES2022 lacks Array.prototype.toSorted.
      .sort((left, right) => left.getTime() - right.getTime())
  );
}

function buildHistoricalJobs(now = new Date()): HistoricalJob[] {
  const random = createHistoricalRandom();
  const taskChoices = [
    { queueName: "demo", jobType: RECURRING_JOB_TYPE },
    { queueName: "demo", jobType: REPORT_JOB_TYPE },
    { queueName: "orders", jobType: ORDER_JOB_TYPE },
    { queueName: "orders", jobType: "order.refund" },
    { queueName: "emails", jobType: "email.send" },
    { queueName: "emails", jobType: "email.digest" },
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
      task.jobType === REPORT_JOB_TYPE
        ? 8_000 + random() * 38_000
        : task.queueName === "emails"
          ? 300 + random() * 4_500
          : 500 + random() * 12_000;
    const finishedAt = new Date(runAt.getTime() + durationMs + (retried ? 4_000 : 0));
    const workerId = HISTORICAL_WORKER_IDS[index % HISTORICAL_WORKER_IDS.length]!;
    const fenceToken = index * 10 + currentAttempt + 1;
    const error = failed ? errors[index % errors.length]! : null;
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
        error: {
          name: "TransientError",
          message: "dependency unavailable; retrying",
          code: "EAGAIN",
        },
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
      jobType: task.jobType,
      payload: {
        demoSeed: HISTORICAL_SEED_NAME,
        sequence: index + 1,
        source: task.queueName === "emails" ? "campaign" : "historical-demo",
      },
      tags:
        task.queueName === "emails"
          ? index % 2 === 0
            ? ["email", "transactional"]
            : ["email", "campaign"]
          : task.jobType === REPORT_JOB_TYPE
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
      result: failed ? null : { ok: true, durationMs: Math.round(durationMs) },
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
    job: {
      type: RECURRING_JOB_TYPE,
      queue: DEMO_QUEUE,
      payload: { source: "worker" },
    },
  } as const;
}

function reportSchedule(enabled = true) {
  return {
    name: REPORT_SCHEDULE_NAME,
    schedule: "*/5 * * * *",
    enabled,
    job: {
      type: REPORT_JOB_TYPE,
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
    job: {
      type: LONG_RUNNING_JOB_TYPE,
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
    job: {
      type: DEMO_FEATURE_SHOWCASE_JOB_TYPE,
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
      } satisfies DemoFeaturePayload,
      maxAttempts: family.recurringMaxAttempts,
      retryPolicy: family.recurringRetryPolicy,
    },
  }));
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
    reportSchedule(enabledByName.get(REPORT_SCHEDULE_NAME) ?? true),
    longRunningSchedule(enabledByName.get(LONG_RUNNING_SCHEDULE_NAME) ?? true),
    ...featureShowcaseSchedules(enabledByName),
  ]);
}

/** Synchronize the fleet-wide dispatch budget showcased by the seeded long-running jobs. */
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

export function createReadOnlyOperator(): DashboardOperator {
  return { mode: "read-only" };
}

function demoTestJob(
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
      type: RECURRING_JOB_TYPE,
      payload: { source: "operator" },
      tags: ["demo-test"],
    };
  }
  if (kind === "idempotent") {
    // A fixed key and a payload with no timestamp or random field keep every repeat of this menu
    // action byte-identical, so PostgreSQL returns the first task instead of accepting another.
    return {
      type: RECURRING_JOB_TYPE,
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
      type: RETRY_JOB_TYPE,
      payload: { label: "operator-retry", failUntilAttempt: 1 },
      maxAttempts: 3,
      tags: ["demo-test", "durable-checkpoint"],
    };
  }
  if (kind === "durable") {
    const scenario = scenarioInput ?? "order-fulfillment";
    return {
      type: DURABLE_DEMO_JOB_TYPE,
      payload: { scenario },
      maxAttempts: 2,
      tags: ["demo-test", "durable-checkpoint", scenario],
    };
  }
  if (kind === "timer") {
    return {
      type: DURABLE_TIMER_JOB_TYPE,
      payload: { source: "operator" },
      maxAttempts: 1,
      tags: ["demo-test", "durable-checkpoint", "durable-timer"],
    };
  }
  if (kind === "failure") {
    return {
      type: FAILURE_JOB_TYPE,
      payload: { label: "operator-failure" },
      maxAttempts: 1,
      tags: ["demo-test"],
    };
  }
  return {
    type: LONG_RUNNING_JOB_TYPE,
    payload: { label: "operator-long-running" },
    tags: ["demo-test"],
  };
}

export function createLocalOperator(database: DemoDatabase): DashboardOperator {
  return {
    mode: "local",
    async enqueueTest(kind, audit, scenario) {
      const target = `job:${kind}`;
      return database.transaction(async (transaction) => {
        const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
        const definition = demoTestJob(kind, scenario);
        const jobId = await workhorse.queue.enqueue(definition.type, definition.payload, {
          ...(definition.maxAttempts === undefined ? {} : { maxAttempts: definition.maxAttempts }),
          ...(definition.idempotency === undefined ? {} : { idempotency: definition.idempotency }),
          tags: definition.tags,
        });
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'enqueueTest', ${target},
             NULL, ${JSON.stringify({ jobId, ...definition })}::jsonb, 'succeeded')
        `);
        return { jobId };
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
  return "succeeded";
}

/**
 * Run a shared Queue-backed controller action inside the demo's audit transaction.
 *
 * The shared factory owns the Queue calls and result projection. This runner owns only the demo's
 * before snapshot and audit row, preserving the atomic audit boundary without copying controller
 * behavior into the demo host.
 */
export function createLocalOperatorControllers(database: DemoDatabase) {
  return createDashboardOperatorControllers({
    run: (action, operation) =>
      database.transaction(async (transaction) => {
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
            const rows = await transaction.execute<{ purgeable_jobs: number }>(sql`
              SELECT count(*)::integer AS purgeable_jobs
                FROM workhorse.job_runtime
               WHERE queue_name = ${action.queueName} AND state IN ('ready', 'scheduled')
            `);
            before = rows.rows[0] ?? { purgeable_jobs: 0 };
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
                FROM workhorse.job j
                LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
                LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
               WHERE j.id = ${action.jobId}
            `);
            const row = rows.rows[0];
            before = {
              state: row?.state ?? null,
              runAt: isoTimestamp(row?.run_at ?? null),
              waitName: row?.wait_name ?? null,
            };
            target = `job:${action.jobId}`;
            break;
          }
          case "cancelTask": {
            const rows = await transaction.execute<{ state: string | null }>(sql`
              SELECT COALESCE(r.state, o.state) AS state
                FROM workhorse.job j
                LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
                LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
               WHERE j.id = ${action.jobId}
            `);
            before = { state: rows.rows[0]?.state ?? null };
            target = `job:${action.jobId}`;
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
        const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
        const result = await operation(workhorse.queue);
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

export function createLocalSettingsController(database: DemoDatabase): SettingsController {
  async function mutate(
    action: string,
    target: string,
    audit: AuditContext,
    change: (queue: Queue) => Promise<unknown>,
  ): Promise<void> {
    await database.transaction(async (transaction) => {
      const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
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
  const localControllers = createLocalOperatorControllers(database);
  // Worker pause state is durable and fleet-wide; it survives restarts and reaches remote workers.
  const workerController = options.workerController ?? localControllers.workerController;
  // Cancellation is offered only where the rest of the mutating operator surface is. A read-only
  // deployment keeps exactly the dashboard it had, with no cancel action anywhere.
  const taskController =
    options.taskController ??
    (options.operator?.mode === "local" ? localControllers.taskController : undefined);
  const settingsController =
    options.settingsController ??
    (options.operator?.mode === "local" ? createLocalSettingsController(database) : undefined);
  const adapter = createDrizzleAdapter(database, { defaultQueue: DEMO_QUEUE });
  const app = new Hono();

  if (options.dashboard !== false) {
    const dashboard = createDashboardHost({
      path: "/",
      database: adapter.database,
      authorize: () => true,
      environment,
      maintenanceLoops: { tickIntervalMs: maintenanceIntervalMs },
      operator: options.operator ?? createReadOnlyOperator(),
      scheduleController: options.scheduleController,
      queueController: options.queueController,
      taskController,
      workerController,
      settingsController,
      projectDurability: durableDemoPlanForJob,
      auditActor: "local-demo",
      dev: options.dev,
    });
    app.all(
      "*",
      async (context) => (await dashboard.handle(context.req.raw)) ?? context.notFound(),
    );
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

    const jobs = buildHistoricalJobs();
    await transaction.execute(sql`
      INSERT INTO workhorse.job
        (id, queue_name, job_type, payload, tags, max_attempts, created_at)
      VALUES ${sql.join(
        jobs.map(
          (job) => sql`(
            ${job.id}, ${job.queueName}, ${job.jobType}, ${JSON.stringify(job.payload)}::jsonb,
            ${textArrayValue(job.tags)},
            ${job.maxAttempts}, ${job.createdAt}
          )`,
        ),
        sql`, `,
      )}
    `);
    await transaction.execute(sql`
      INSERT INTO workhorse.job_outcome
        (job_id, state, current_attempt, fence_token, run_at, result, error, finished_at, updated_at)
      VALUES ${sql.join(
        jobs.map(
          (job) => sql`(
            ${job.id}, ${job.state}, ${job.currentAttempt}, ${job.fenceToken}, ${job.runAt},
            ${jsonbValue(job.result)}, ${jsonbValue(job.error)}, ${job.finishedAt}, ${job.finishedAt}
          )`,
        ),
        sql`, `,
      )}
    `);
    await transaction.execute(sql`
      INSERT INTO workhorse.attempt_history
        (job_id, attempt, fence_token, worker_id, outcome, started_at, claimed_at,
         finished_at, error, occurred_at)
      VALUES ${sql.join(
        jobs.flatMap((job) =>
          job.attempts.map(
            (attempt) => sql`(
              ${job.id}, ${attempt.attempt}, ${attempt.fenceToken}, ${attempt.workerId},
              ${attempt.outcome}, ${attempt.startedAt}, ${attempt.startedAt}, ${attempt.finishedAt},
              ${jsonbValue(attempt.error)}, ${attempt.finishedAt}
            )`,
          ),
        ),
        sql`, `,
      )}
    `);
    return jobs.length;
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

    const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
    const jobIds: string[] = [];
    const runAt = new Date(Date.now() + DEMO_LONG_RUNNING_SEED_DELAY_MS);
    for (const job of DEMO_LONG_RUNNING_SEED_JOBS) {
      jobIds.push(
        await workhorse.queue.enqueue(
          LONG_RUNNING_JOB_TYPE,
          { source: "long-running-seed", label: job.label },
          {
            concurrencyKey: job.concurrencyKey,
            maxAttempts: 1,
            runAt,
            tags: ["demo-test", "long-running", "low-resource", "concurrency-policy"],
          },
        ),
      );
    }
    return jobIds;
  });
}

async function seedRateLimitDemoData(database: DemoDatabase): Promise<string[]> {
  return database.transaction(async (transaction) => {
    const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_RATE_LIMIT_QUEUE });
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

    const jobIds: string[] = [];
    for (const job of DEMO_RATE_LIMIT_SEED_JOBS) {
      jobIds.push(
        await workhorse.queue.enqueue(
          RECURRING_JOB_TYPE,
          { source: "rate-limit-seed", label: job.label },
          {
            concurrencyKey: job.concurrencyKey,
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
    return jobIds;
  });
}

export async function seedDemoData(database: DemoDatabase) {
  const rateLimitJobIds = await seedRateLimitDemoData(database);
  // These jobs are inserted first but start after a short grace period, so startup work is never
  // starved. Their handler only awaits a Node timer, occupying slots without burning CPU or memory.
  const longRunningJobIds = await seedLongRunningDemoData(database);
  const featureShowcaseJobIds = await database.transaction(async (transaction) => {
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${DEMO_FEATURE_SHOWCASE_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) return [] as string[];

    const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
    const jobIds: string[] = [];
    for (const family of DEMO_FEATURE_SHOWCASE_FAMILIES) {
      for (const example of family.examples) {
        const payload: DemoFeaturePayload = {
          source: DEMO_FEATURE_SHOWCASE_SOURCE,
          family: family.key,
          scenario: example.scenario,
          behavior: example.behavior,
          label: example.label,
          durationMs: example.durationMs ?? null,
          waitMs: example.waitMs ?? null,
          checkpointCount: example.checkpointCount ?? null,
        };
        const now = Date.now();
        const enqueueOptions: EnqueueOptions = {
          maxAttempts: example.maxAttempts,
          retryPolicy: example.retryPolicy,
          tags: example.tags,
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
          const isolated = createDrizzleAdapter(transaction, { defaultQueue: queue });
          const sourceJobId = await isolated.queue.enqueue(
            DEMO_FEATURE_SHOWCASE_JOB_TYPE,
            payload,
            enqueueOptions,
          );
          jobIds.push(sourceJobId);
          const workerId = `showcase-seed-${example.scenario}`;
          const claimed = await isolated.queue.claim(workerId, { queue });
          if (!claimed || claimed.id !== sourceJobId) {
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
              requestedBy: "demo-seed",
              reason: `Show redrive lineage for ${example.scenario}`,
              requestId: `feature-showcase:${example.scenario}`,
            };
            const redrive = await isolated.queue.redrive(sourceJobId, request);
            if (!redrive.targetJobId) throw new Error(`Redrive did not create ${example.scenario}`);
            jobIds.push(redrive.targetJobId);
            if (example.seedTransition === "fail-and-redrive-replay") {
              const replay = await isolated.queue.redrive(sourceJobId, request);
              if (replay.status !== "replayed" || replay.targetJobId !== redrive.targetJobId) {
                throw new Error("Expected idempotent showcase redrive replay");
              }
            }
            const target = await isolated.queue.claim(workerId, { queue });
            if (!target || target.id !== redrive.targetJobId) {
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

        const jobId = await workhorse.queue.enqueue(
          DEMO_FEATURE_SHOWCASE_JOB_TYPE,
          payload,
          enqueueOptions,
        );
        jobIds.push(jobId);
        if (example.idempotencyKey) {
          const replayedJobId = await workhorse.queue.enqueue(
            DEMO_FEATURE_SHOWCASE_JOB_TYPE,
            payload,
            enqueueOptions,
          );
          if (replayedJobId !== jobId) throw new Error("Expected showcase enqueue replay");
        }
        if (example.afterEnqueue === "cancel") {
          await workhorse.queue.cancel(jobId, {
            requestedBy: "demo-seed",
            reason: `Seeded ${example.scenario} cancellation`,
          });
        }
      }
    }
    return jobIds;
  });
  const representativeSeed = await database.transaction(async (transaction) => {
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${REPRESENTATIVE_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) {
      return { expiredDeadlineId: null, jobIds: [] as string[] };
    }

    const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
    const seededJobIds: string[] = [];
    const orderId = randomUUID();
    await transaction.insert(orders).values({
      id: orderId,
      customerEmail: "demo.operator@example.com",
      description: "Inspect a successful transactional order",
      status: "queued",
    });
    seededJobIds.push(
      await workhorse.queue.enqueue(ORDER_JOB_TYPE, { orderId }, { tags: ["billing"] }),
    );
    seededJobIds.push(
      await workhorse.queue.enqueue(
        DURABLE_TIMER_JOB_TYPE,
        { source: "representative-seed" },
        { maxAttempts: 1, tags: ["demo-test", "durable-checkpoint", "durable-timer"] },
      ),
    );
    seededJobIds.push(
      await workhorse.queue.enqueue(
        RETRY_JOB_TYPE,
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
    seededJobIds.push(
      await workhorse.queue.enqueue(
        FAILURE_JOB_TYPE,
        { label: "terminal-failure" },
        { maxAttempts: 1, tags: ["demo-test"] },
      ),
    );
    // One representative keyed task so a fresh dashboard shows the deduplication surface without
    // an operator having to act first. It stays an ordinary successful task; nothing about the
    // seed pretends a conflict or a degraded state occurred.
    seededJobIds.push(
      await workhorse.queue.enqueue(
        RECURRING_JOB_TYPE,
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
      TIMING_JOB_TYPE,
      { durationMs: 0, source: "expired-deadline-seed" },
      {
        deadline: new Date(Date.now() - 1_000),
        maxAttempts: 1,
        tags: ["demo-test", "deadline", "intentionally-expired"],
      },
    );
    seededJobIds.push(expiredDeadlineId);
    seededJobIds.push(
      await workhorse.queue.enqueue(
        TIMING_JOB_TYPE,
        { durationMs: DEMO_TIMING_HANDLER_MS, source: "execution-timeout-seed" },
        {
          executionTimeoutMs: DEMO_TIMING_TIMEOUT_MS,
          maxAttempts: 1,
          tags: ["demo-test", "execution-timeout", "intentionally-timed-out"],
        },
      ),
    );
    const timingPolicyRunAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    seededJobIds.push(
      await workhorse.queue.enqueue(
        TIMING_JOB_TYPE,
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
      seededJobIds.push(
        await workhorse.queue.enqueue(
          DURABLE_DEMO_JOB_TYPE,
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
      seededJobIds.push(
        await workhorse.queue.enqueue(
          DURABLE_DEMO_JOB_TYPE,
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
    seededJobIds.push(
      await workhorse.queue.enqueue(
        RECURRING_JOB_TYPE,
        { source: "scheduled-seed" },
        { runAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), tags: ["reports", "weekly"] },
      ),
    );
    return { expiredDeadlineId, jobIds: seededJobIds };
  });

  if (representativeSeed.expiredDeadlineId !== null) {
    const workhorse = createDrizzleAdapter(database, { defaultQueue: DEMO_QUEUE });
    await workhorse.queue.recoverExpired();
    const expiredDeadline = await workhorse.queue.getJob(representativeSeed.expiredDeadlineId);
    if (expiredDeadline?.state !== "failed") {
      throw new Error("Expected the representative expired deadline to be materialized");
    }
  }

  const historicalJobCount = await seedHistoricalDemoData(database);
  const jobIds = [
    ...rateLimitJobIds,
    ...longRunningJobIds,
    ...featureShowcaseJobIds,
    ...representativeSeed.jobIds,
  ];
  return {
    seeded: jobIds.length > 0 || historicalJobCount > 0,
    jobIds,
    historicalJobCount,
  };
}

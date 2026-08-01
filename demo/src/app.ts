import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createDrizzleAdapter } from "@workhorse/drizzle";
import { HonoWorkhorse, mountWorkhorseDashboard } from "@workhorse/hono";
import { DashboardRefreshHub } from "@workhorse/dashboard/server";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import {
  EnqueueIdempotencyConflictError,
  Queue,
  type CancelStatus,
  type Json,
  type JobState,
  type RetryPolicy,
  type Worker,
} from "@workhorse/core";
import type { Pool } from "pg";
import { z } from "zod";
import {
  DURABLE_DEMO_JOB_TYPE,
  type DurableDemoPayload,
  type DurableDemoScenario,
  durableDemoScenarios,
  durableDemoPlanForJob,
  parseDurableDemoScenario,
  persistentFailureFor,
} from "./durable-demo.js";
import { orders } from "./schema.js";

const ORDER_JOB_TYPE = "order.process";
const RETRY_JOB_TYPE = "demo.retry";
const RETRY_CHECKPOINT_NAME = "reserve-capacity";
const FAILURE_JOB_TYPE = "demo.failure";
const LONG_RUNNING_JOB_TYPE = "demo.long-running";
export const DURABLE_TIMER_JOB_TYPE = "demo.durable-timer";
export const DURABLE_TIMER_PREPARE_CHECKPOINT = "prepare-publication";
export const DURABLE_TIMER_WAIT_NAME = "publication-delay";
export const DURABLE_TIMER_PUBLISH_CHECKPOINT = "publish-after-wait";
const RECURRING_JOB_TYPE = "demo.recurring";
const REPORT_JOB_TYPE = "demo.report";
const DEMO_QUEUE = "demo";
const REPRESENTATIVE_SEED_NAME = "default-dashboard-v7";
const HISTORICAL_SEED_NAME = "historical-dashboard-v1";
const HISTORICAL_JOB_COUNT = 362;
export const DEMO_WORKERS = ["demo-worker-1", "demo-worker-2"] as const;
export const DEMO_WORKER_POLL_MS = 15_000;
/**
 * Declared execution slots per demo worker. The values are deliberately different and fixed so the
 * dashboard shows a heterogeneous, reproducible fleet: one worker overlaps handlers while the other
 * stays strictly serial. Concurrency is configuration, not a runtime control, so nothing mutates it.
 */
export const DEMO_WORKER_CONCURRENCY: Readonly<Record<(typeof DEMO_WORKERS)[number], number>> = {
  "demo-worker-1": 3,
  "demo-worker-2": 1,
};
export const DEMO_MAINTENANCE_INTERVAL_MS = 1_000;
export const DEMO_HOUSEKEEPING_INTERVAL_MS = 60_000;
export const DEMO_LONG_RUNNING_MS = 20_000;
export const DEMO_DURABLE_STEP_MS = 2_000;
export const DEMO_DURABLE_TIMER_WAIT_MS = 10_000;
export const DEMO_PERSISTENT_RETRY_DELAYS_MS = [5 * 60_000, 7 * 60_000, 10 * 60_000] as const;
/**
 * One persisted policy per intentionally failing seed. Each policy is chosen so the first
 * scheduled retry lands in the same 5, 7, and 10 minute analytic window the demo has always
 * shown, while PostgreSQL, not the worker, now owns the delay.
 */
export const DEMO_PERSISTENT_RETRY_POLICIES: readonly RetryPolicy[] = [
  { type: "fixed", delayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[0] },
  {
    type: "exponential",
    initialDelayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[1],
    multiplier: 2,
    maxDelayMs: 30 * 60_000,
  },
  // The jitter cap deliberately equals its base so the published ten minute window stays exact and
  // deterministic for the demo and its assertions while still exercising the jitter code path.
  {
    type: "decorrelated-jitter",
    baseDelayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[2],
    maxDelayMs: DEMO_PERSISTENT_RETRY_DELAYS_MS[2],
  },
] as const;
/** The recoverable retry seed stays fixed and fast so it still recovers while the demo is watched. */
export const DEMO_RECOVERABLE_RETRY_POLICY: RetryPolicy = { type: "fixed", delayMs: 100 };
export const DEMO_SCHEDULE_NAMESPACE = "workhorse-demo";
export const HEARTBEAT_SCHEDULE_NAME = "heartbeat";
export const REPORT_SCHEDULE_NAME = "demo.report";
/** Optional request headers that ask PostgreSQL to deduplicate this submission. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_SCOPE_HEADER = "Idempotency-Scope";
/**
 * The demo always asks for the documented 24 hour retention window so a repeated submission is
 * still recognised across a demo session and an operator can see one stable retention claim.
 */
export const DEMO_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
/** Namespace used by the dashboard operator path, kept distinct from HTTP caller namespaces. */
export const DEMO_OPERATOR_IDEMPOTENCY_SCOPE = "workhorse-demo:operator";
/**
 * One fixed operator key. Repeating the menu action is meant to return the same task rather than
 * creating another one, which is the whole point of the demonstration.
 */
export const DEMO_OPERATOR_IDEMPOTENCY_KEY = "operator-idempotent-task";
/** Namespace and key for the single deterministic keyed seed shown on a fresh demo database. */
export const DEMO_SEED_IDEMPOTENCY_SCOPE = "workhorse-demo:seed";
export const DEMO_SEED_IDEMPOTENCY_KEY = "representative-keyed-task";
/** Longest key the demo accepts, matching the core limit so callers fail fast with a clear 400. */
export const MAX_DEMO_IDEMPOTENCY_KEY_BYTES = 512;
export const MAX_DEMO_IDEMPOTENCY_SCOPE_BYTES = 256;
const DEMO_INDEX = {
  name: "Workhorse demo",
  endpoints: [
    "POST /orders",
    "POST /demo/retries",
    "POST /demo/durable",
    "POST /demo/timers",
    "POST /demo/failures",
    "GET /orders/:id",
    "GET /jobs/:id",
    "GET /health",
  ],
};

export interface DemoOrderRequest {
  customerEmail: string;
  description: string;
}

export interface CreateDemoApplicationOptions {
  close?: () => void | Promise<void>;
  onWorkerError?: (error: unknown) => void;
  dashboardRefresh?: DashboardRefreshHub;
  dashboard?: boolean;
  /** Display-only deployment environment label shown in the dashboard header. */
  environment?: string;
  operator?: DashboardOperator;
  scheduleController?: ScheduleController;
  queueController?: QueueController;
  taskController?: TaskController;
  workerController?: WorkerController;
  workerPollMs?: number;
  maintenanceIntervalMs?: number;
  housekeepingIntervalMs?: number;
  longRunningJobMs?: number;
  durableStepMs?: number;
  durableTimerWaitMs?: number;
  onDurableStepOperation?: (
    scenario: DurableDemoScenario,
    stepName: string,
    attempt: number,
  ) => void;
  onDurableTimerOperation?: (
    operation: "prepare" | "publish",
    attempt: number,
    fenceToken: bigint,
  ) => void;
}

export interface AuditContext {
  actor: string;
  reason: string;
  requestId: string;
  occurredAt?: string;
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
  cancelTask?: (jobId: string, audit: AuditContext) => Promise<DemoCancelTaskResult>;
}

export interface WorkerController {
  workerStates(): ReadonlyMap<string, DemoWorkerRuntimeState>;
  setWorkerPaused?: (
    workerId: string,
    paused: boolean,
    audit: AuditContext,
  ) => Promise<{ paused: boolean }>;
}

/**
 * Process-local view of one running worker. `concurrency` is the declared slot budget from startup
 * configuration, while `activeSlots` counts handlers currently executing inside this process. Both
 * are distinct from the SQL-observed active job count the read model reports separately.
 */
export interface DemoWorkerRuntimeState {
  paused: boolean;
  concurrency: number;
  activeSlots: number;
  draining: boolean;
}

const orderRequestSchema = z.object({
  customerEmail: z.email().transform((value) => value.trim()),
  description: z.string().trim().min(1),
});

export function createDemoDatabase(pool: Pool) {
  return drizzle({ client: pool, schema: { orders } });
}

export type DemoDatabase = ReturnType<typeof createDemoDatabase>;

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
  workerId: (typeof DEMO_WORKERS)[number];
  attempts: HistoricalAttempt[];
}

interface HistoricalAttempt {
  attempt: number;
  fenceToken: number;
  workerId: (typeof DEMO_WORKERS)[number];
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
    const workerId = DEMO_WORKERS[index % DEMO_WORKERS.length]!;
    const fenceToken = index * 10 + currentAttempt + 1;
    const error = failed ? errors[index % errors.length]! : null;
    const attempts: HistoricalAttempt[] = [];

    if (retried) {
      const retryStartedAt = new Date(runAt);
      const retryFinishedAt = new Date(retryStartedAt.getTime() + 400 + random() * 2_500);
      attempts.push({
        attempt: 1,
        fenceToken: index * 10 + 1,
        workerId: DEMO_WORKERS[(index + 1) % DEMO_WORKERS.length]!,
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
      reason text NOT NULL CHECK (reason <> ''),
      request_id text NOT NULL CHECK (request_id <> ''),
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      action text NOT NULL CHECK (action <> ''),
      target text NOT NULL CHECK (target <> ''),
      before jsonb,
      after jsonb,
      status text NOT NULL CHECK (status IN ('succeeded', 'failed'))
    )
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
  ]);
}

function parseOrderRequest(input: unknown): DemoOrderRequest | null {
  const parsed = orderRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** One caller-supplied deduplication identity, already validated against the core limits. */
export interface DemoIdempotency {
  key: string;
  scope: string;
  ttlMs: number;
}

/**
 * Read the optional idempotency headers for one route.
 *
 * Absent headers keep the historical behavior exactly: every submission creates a new identity.
 * A present but unusable key is rejected here rather than in SQL so the caller gets a plain 400
 * describing the limit instead of a database error string.
 */
export function readIdempotencyHeaders(
  headers: { key: string | null | undefined; scope: string | null | undefined },
  defaultScope: string,
): { idempotency: DemoIdempotency | null; error: string | null } {
  const key = headers.key?.trim() ?? "";
  const scopeHeader = headers.scope?.trim() ?? "";
  if (key === "") {
    if (scopeHeader !== "") {
      return {
        idempotency: null,
        error: `${IDEMPOTENCY_SCOPE_HEADER} requires ${IDEMPOTENCY_KEY_HEADER}`,
      };
    }
    return { idempotency: null, error: null };
  }
  if (Buffer.byteLength(key, "utf8") > MAX_DEMO_IDEMPOTENCY_KEY_BYTES) {
    return {
      idempotency: null,
      error: `${IDEMPOTENCY_KEY_HEADER} must contain at most ${MAX_DEMO_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes`,
    };
  }
  const scope = scopeHeader === "" ? defaultScope : scopeHeader;
  if (Buffer.byteLength(scope, "utf8") > MAX_DEMO_IDEMPOTENCY_SCOPE_BYTES) {
    return {
      idempotency: null,
      error: `${IDEMPOTENCY_SCOPE_HEADER} must contain at most ${MAX_DEMO_IDEMPOTENCY_SCOPE_BYTES} UTF-8 bytes`,
    };
  }
  return { idempotency: { key, scope, ttlMs: DEMO_IDEMPOTENCY_TTL_MS }, error: null };
}

/**
 * Derive a stable application row identity from the same scope and key PostgreSQL deduplicates on.
 *
 * The demo owns two effects per accepted order: an application row and a queued job. The queue
 * deduplicates the job, but the order insert is the demo's own effect and needs its own stable
 * identity, otherwise a repeated keyed submission would return one job and leave a second orphan
 * order row behind. Deriving the row ID from scope and key keeps both effects on one identity.
 */
export function deterministicOrderId(scope: string, key: string): string {
  const digest = createHash("sha256")
    .update(`workhorse-demo-order\u0000${scope}\u0000${key}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // RFC 9562 §5.8 name-based-from-hash layout: pin the version and variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Digest of the order fields the demo actually acts on.
 *
 * A keyed order carries this digest in its job payload so the queue's stored request fingerprint
 * reflects the submitted order, not only its derived row identity. Without it, reusing one key for
 * a different customer or description would look like an exact replay and be silently accepted.
 */
export function orderRequestDigest(request: DemoOrderRequest): string {
  return createHash("sha256")
    .update(`${request.customerEmail}\u0000${request.description}`)
    .digest("hex");
}

/**
 * Public shape of a rejected keyed submission.
 *
 * A conflict means the retained key already belongs to a materially different request. The response
 * deliberately carries no raw key: the caller already knows the key it sent, and every other reader
 * of this response, including logs and the dashboard, must not learn it.
 */
export interface DemoIdempotencyConflictBody {
  error: string;
  reason: "idempotency-conflict";
  scope: string;
  keyDigest: string;
  keyLength: number;
  existingJobId: string;
  /** Request fields that differ from the retained request, so a caller can see what changed. */
  conflictingFields: string[];
  storedRequestDigest: string;
  rejectedRequestDigest: string;
  retentionMs: number;
}

/** Translate a typed core conflict into a safe structured body, or null for any other error. */
export function idempotencyConflictBody(error: unknown): DemoIdempotencyConflictBody | null {
  if (!(error instanceof EnqueueIdempotencyConflictError)) return null;
  return {
    error:
      "This idempotency key is retained for a different request. Use a new key, or repeat the original request exactly.",
    reason: "idempotency-conflict",
    scope: error.scope,
    // `keyPreview` is deliberately omitted. Even a masked preview is unnecessary in a response
    // that every proxy and log can observe; the digest and length identify the key safely.
    keyDigest: error.keyDigest,
    keyLength: error.keyLength,
    existingJobId: error.existingJobId,
    conflictingFields: [...error.conflictingFields],
    storedRequestDigest: error.storedRequestDigest,
    rejectedRequestDigest: error.rejectedRequestDigest,
    retentionMs: DEMO_IDEMPOTENCY_TTL_MS,
  };
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

export function createLocalQueueController(database: DemoDatabase): QueueController {
  return {
    async setQueuePaused(queueName, paused, audit) {
      return database.transaction(async (transaction) => {
        const beforeRows = await transaction.execute<{ paused: boolean }>(sql`
          SELECT paused FROM workhorse.queue_control WHERE queue_name = ${queueName} FOR UPDATE
        `);
        const before = { paused: beforeRows.rows[0]?.paused ?? false };
        const workhorse = createDrizzleAdapter(transaction, { defaultQueue: queueName });
        if (paused) await workhorse.queue.pauseQueue(queueName);
        else await workhorse.queue.resumeQueue(queueName);
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'setQueuePaused', ${`queue:${queueName}`},
             ${JSON.stringify(before)}::jsonb, ${JSON.stringify({ paused })}::jsonb, 'succeeded')
        `);
        return { paused };
      });
    },
    async purgeQueue(queueName, audit) {
      return database.transaction(async (transaction) => {
        const beforeRows = await transaction.execute<{ purgeable_jobs: number }>(sql`
          SELECT count(*)::integer AS purgeable_jobs
            FROM workhorse.job_runtime
           WHERE queue_name = ${queueName} AND state IN ('ready', 'scheduled')
        `);
        const workhorse = createDrizzleAdapter(transaction, { defaultQueue: queueName });
        const deletedCount = await workhorse.queue.purgeQueue(queueName);
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'purgeQueue', ${`queue:${queueName}`},
             ${JSON.stringify(beforeRows.rows[0] ?? { purgeable_jobs: 0 })}::jsonb,
             ${JSON.stringify({ deletedCount })}::jsonb, 'succeeded')
        `);
        return { deletedCount };
      });
    },
  };
}

/**
 * Normalize a cancellation timestamp to ISO-8601.
 *
 * `CancelResult` is typed with `Date`, but a driver may hand back the raw `timestamptz` string
 * depending on how the transaction is issued. Both are accepted here so the projected result and
 * the audit row can never disagree about the shape of a recorded time.
 */
function isoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Audited cancellation of one task.
 *
 * The cancellation and its audit row share one transaction, so an operator action is never
 * recorded without the lifecycle transition it claims to describe, and never applied without a
 * recorded actor, reason, and request id. The stored `after` payload keeps the exact status
 * PostgreSQL returned, including `cancel_requested`, so a later reader can tell an immediate
 * cancellation apart from a cooperative request that an active handler still had to observe.
 * Canceling one occurrence of a recurring schedule cancels only that task; the schedule
 * definition is untouched and keeps firing.
 */
export function createLocalTaskController(database: DemoDatabase): TaskController {
  return {
    async cancelTask(jobId, audit) {
      return database.transaction(async (transaction) => {
        const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
        const beforeRows = await transaction.execute<{ state: string | null }>(sql`
          SELECT COALESCE(r.state, o.state) AS state
            FROM workhorse.job j
            LEFT JOIN workhorse.job_runtime r ON r.job_id = j.id
            LEFT JOIN workhorse.job_outcome o ON o.job_id = j.id
           WHERE j.id = ${jobId}
        `);
        const result = await workhorse.queue.cancel(jobId, {
          requestedBy: audit.actor,
          reason: audit.reason,
        });
        const projected: DemoCancelTaskResult = {
          status: result.status,
          jobId: result.jobId,
          state: result.state,
          currentAttempt: result.currentAttempt,
          requestedAt: isoTimestamp(result.requestedAt),
          requestedBy: result.requestedBy,
          reason: result.reason,
          finishedAt: isoTimestamp(result.finishedAt),
        };
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'cancelTask', ${`job:${jobId}`},
             ${JSON.stringify({ state: beforeRows.rows[0]?.state ?? null })}::jsonb,
             ${JSON.stringify(projected)}::jsonb,
             ${result.status === "not_found" ? "failed" : "succeeded"})
        `);
        return projected;
      });
    },
  };
}

export function createLocalWorkerController(
  database: DemoDatabase,
  workers: ReadonlyMap<string, Worker>,
): WorkerController {
  return {
    workerStates() {
      return new Map(
        [...workers].map(([workerId, worker]) => {
          const state = worker.runtimeState();
          return [
            workerId,
            {
              paused: state.paused,
              concurrency: state.concurrency,
              activeSlots: state.activeSlots,
              draining: state.draining,
            },
          ] as const;
        }),
      );
    },
    async setWorkerPaused(workerId, paused, audit) {
      const worker = workers.get(workerId);
      if (!worker) throw new Error(`Worker ${workerId} is not running in this demo process`);
      const before = { paused: worker.isPaused() };
      if (paused) worker.pause();
      else worker.resume();

      try {
        await database.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'setWorkerPaused', ${`worker:${workerId}`},
             ${JSON.stringify(before)}::jsonb, ${JSON.stringify({ paused })}::jsonb, 'succeeded')
        `);
      } catch (error) {
        if (before.paused) worker.pause();
        else worker.resume();
        throw error;
      }
      return { paused };
    },
  };
}

export function createDemoApplication(
  database: DemoDatabase,
  options: CreateDemoApplicationOptions = {},
) {
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEMO_MAINTENANCE_INTERVAL_MS;
  const housekeepingIntervalMs = options.housekeepingIntervalMs ?? DEMO_HOUSEKEEPING_INTERVAL_MS;
  const durableStepMs = options.durableStepMs ?? DEMO_DURABLE_STEP_MS;
  const durableTimerWaitMs = options.durableTimerWaitMs ?? DEMO_DURABLE_TIMER_WAIT_MS;
  const dashboardRefresh = options.dashboardRefresh ?? new DashboardRefreshHub();
  const environment = options.environment ?? "development";
  // Worker pause state belongs to this application process and intentionally resets on restart.
  const workerRegistry = new Map<string, Worker>();
  const workerController =
    options.workerController ?? createLocalWorkerController(database, workerRegistry);
  // Cancellation is offered only where the rest of the mutating operator surface is. A read-only
  // deployment keeps exactly the dashboard it had, with no cancel action anywhere.
  const taskController =
    options.taskController ??
    (options.operator?.mode === "local" ? createLocalTaskController(database) : undefined);
  const adapter = createDrizzleAdapter(database, {
    defaultQueue: DEMO_QUEUE,
    close: options.close,
  });
  const workhorse = new HonoWorkhorse(adapter, {
    workers: DEMO_WORKERS.map((workerId) => ({
      options: {
        queue: DEMO_QUEUE,
        workerId,
        scheduleNamespaces: [DEMO_SCHEDULE_NAMESPACE],
        pollMs: options.workerPollMs ?? DEMO_WORKER_POLL_MS,
        // Declared once at startup. The demo deliberately offers no runtime concurrency control.
        concurrency: DEMO_WORKER_CONCURRENCY[workerId],
        maintenanceIntervalMs,
        housekeepingIntervalMs,
        // Keep unconfigured demo jobs fast while persisted policies remain PostgreSQL-owned.
        // Returning undefined omits the worker override and lets SQL select the stored policy.
        retryDelayMs: (attempt, job) => (job.retryPolicy === null ? attempt * 100 : undefined),
      },
      configure(worker) {
        workerRegistry.set(workerId, worker);
        worker.handle<{ orderId: string }>(ORDER_JOB_TYPE, async ({ orderId }) => {
          const updated = await database
            .update(orders)
            .set({ status: "processed", processedAt: new Date() })
            .where(and(eq(orders.id, orderId), eq(orders.status, "queued")))
            .returning({ id: orders.id });

          if (updated.length === 0) throw new Error(`Order ${orderId} is not queued`);
          dashboardRefresh.publish("worker");
          return { orderId, processed: true };
        });
        worker.handle<{ label: string; failUntilAttempt?: number }>(
          RETRY_JOB_TYPE,
          async ({ label, failUntilAttempt }, { checkpoint, job }) => {
            const failuresBefore = failUntilAttempt ?? 1;
            const reservation = await checkpoint(RETRY_CHECKPOINT_NAME, () => ({
              reservationId: randomUUID(),
              reservedAt: new Date().toISOString(),
              reservedOnAttempt: job.attempt,
            }));
            dashboardRefresh.publish("worker");
            if (job.attempt <= failuresBefore) {
              throw new Error(`Intentional demo failure ${job.attempt}/${failuresBefore}`);
            }
            return {
              label,
              recovered: true,
              attempt: job.attempt,
              checkpointReused: reservation.reservedOnAttempt < job.attempt,
              reservation,
            };
          },
        );
        worker.handle<DurableDemoPayload>(
          DURABLE_DEMO_JOB_TYPE,
          async ({ scenario: scenarioInput, failureMode }, { checkpoint, job, signal }) => {
            const scenario = parseDurableDemoScenario(scenarioInput);
            if (!scenario)
              throw new Error(`Unknown durable demo scenario ${String(scenarioInput)}`);
            const definition = durableDemoScenarios[scenario];
            const artifacts: Record<
              string,
              {
                operationId: string;
                completedAt: string;
                completedOnAttempt: number;
                output: string;
              }
            > = {};
            const operationDelayMs = failureMode === "continuous" ? 0 : durableStepMs;
            const persistentFailAfterStep = persistentFailureFor(scenario).afterStepIndex;

            for (const [stepIndex, step] of definition.steps.entries()) {
              const artifact = await checkpoint(step.name, async () => {
                options.onDurableStepOperation?.(scenario, step.name, job.attempt);
                await sleep(operationDelayMs, undefined, { signal });
                return {
                  operationId: randomUUID(),
                  completedAt: new Date().toISOString(),
                  completedOnAttempt: job.attempt,
                  output: `${step.label} completed`,
                };
              });
              artifacts[step.name] = artifact;
              dashboardRefresh.publish("worker");

              if (failureMode === "continuous" && stepIndex === persistentFailAfterStep) {
                const nextStep = definition.steps[stepIndex + 1];
                throw new Error(
                  nextStep
                    ? `Intentional persistent demo failure between durable stages ${step.name} and ${nextStep.name}`
                    : `Intentional persistent demo failure at the boundary after durable stage ${step.name}`,
                );
              }

              if (
                failureMode !== "continuous" &&
                job.attempt === 1 &&
                stepIndex === definition.failAfterStep
              ) {
                throw new Error(`Intentional crash after durable step ${step.name}`);
              }
            }

            return {
              scenario,
              completed: true,
              attempt: job.attempt,
              reusedCheckpoints: definition.steps
                .filter((step) => artifacts[step.name]!.completedOnAttempt < job.attempt)
                .map((step) => step.name),
              artifacts,
            };
          },
        );
        worker.handle<{ source: string }>(DURABLE_TIMER_JOB_TYPE, async ({ source }, context) => {
          const currentFence = context.job.fenceToken.toString();
          const prepared = await context.checkpoint(DURABLE_TIMER_PREPARE_CHECKPOINT, () => {
            options.onDurableTimerOperation?.(
              "prepare",
              context.job.attempt,
              context.job.fenceToken,
            );
            return {
              artifactId: randomUUID(),
              preparedAt: new Date().toISOString(),
              preparedOnAttempt: context.job.attempt,
              preparedOnFence: currentFence,
            };
          });
          dashboardRefresh.publish("worker");

          const existingWait = await context.getWait(DURABLE_TIMER_WAIT_NAME);
          await context.sleep(DURABLE_TIMER_WAIT_NAME, durableTimerWaitMs);
          const durableWait = await context.getWait(DURABLE_TIMER_WAIT_NAME);
          if (!durableWait) throw new Error("Durable timer wait was not replayed");

          const publication = await context.checkpoint(DURABLE_TIMER_PUBLISH_CHECKPOINT, () => {
            options.onDurableTimerOperation?.(
              "publish",
              context.job.attempt,
              context.job.fenceToken,
            );
            return {
              publicationId: randomUUID(),
              publishedAt: new Date().toISOString(),
              publishedOnAttempt: context.job.attempt,
              publishedOnFence: currentFence,
            };
          });
          dashboardRefresh.publish("worker");

          return {
            source,
            completed: true,
            attempt: context.job.attempt,
            prepareCheckpointReused: prepared.preparedOnFence !== currentFence,
            waitReplayed: existingWait !== null,
            wait: {
              name: durableWait.name,
              wakeAt: new Date(durableWait.wakeAt).toISOString(),
              firstFence: durableWait.fenceToken.toString(),
            },
            prepared,
            publication,
          };
        });
        worker.handle<{ source: string }>(RECURRING_JOB_TYPE, async ({ source }, { job }) => {
          dashboardRefresh.publish("worker");
          return { source, recurring: true, attempt: job.attempt };
        });
        worker.handle<{ report: string; source: string }>(REPORT_JOB_TYPE, async (payload) => {
          dashboardRefresh.publish("worker");
          return { ...payload, generated: true };
        });
        worker.handle(FAILURE_JOB_TYPE, () => {
          throw new Error("Intentional terminal demo failure");
        });
        worker.handle(LONG_RUNNING_JOB_TYPE, async () => {
          dashboardRefresh.publish("worker");
          const durationMs = options.longRunningJobMs ?? DEMO_LONG_RUNNING_MS;
          await sleep(durationMs);
          dashboardRefresh.publish("worker");
          return { completed: true, durationMs };
        });
      },
    })),
    onWorkerError(error) {
      options.onWorkerError?.(error);
    },
  });
  const app = new Hono()
    .use("*", workhorse.middleware())
    .get("/", (context) =>
      options.dashboard === false ? context.json(DEMO_INDEX) : context.redirect("/workhorse/tasks"),
    )
    .get("/api", (context) => context.json(DEMO_INDEX))
    .post("/orders", async (context) => {
      const request = parseOrderRequest(await context.req.json().catch(() => null));
      if (!request) {
        return context.json({ error: "Expected customerEmail and a non-empty description" }, 400);
      }

      const headers = readIdempotencyHeaders(
        {
          key: context.req.header(IDEMPOTENCY_KEY_HEADER),
          scope: context.req.header(IDEMPOTENCY_SCOPE_HEADER),
        },
        "workhorse-demo:orders",
      );
      if (headers.error) return context.json({ error: headers.error }, 400);
      const idempotency = headers.idempotency;
      // The order row and its job stay in one transaction. A keyed submission derives the row
      // identity from the same scope and key the queue deduplicates on, so a repeat reuses the
      // original row and the original job instead of leaving a second order behind. A conflict
      // raised by the queue therefore rolls the whole statement back, including the order insert.
      const orderId =
        idempotency === null
          ? randomUUID()
          : deterministicOrderId(idempotency.scope, idempotency.key);
      let accepted: { orderId: string; jobId: string };
      try {
        const jobId = await database.transaction(async (transaction) => {
          await transaction
            .insert(orders)
            .values({
              id: orderId,
              customerEmail: request.customerEmail,
              description: request.description,
              status: "queued",
            })
            // Only a keyed repeat can collide here, and the queue is the authority on whether that
            // repeat is an exact replay, so the insert defers instead of failing or overwriting.
            .onConflictDoNothing({ target: orders.id });
          return context.var.workhorse
            .forTransaction(transaction)
            .enqueue(
              ORDER_JOB_TYPE,
              idempotency === null
                ? { orderId }
                : { orderId, requestDigest: orderRequestDigest(request) },
              {
                tags: ["billing"],
                ...(idempotency === null ? {} : { idempotency }),
              },
            );
        });
        accepted = { orderId, jobId };
      } catch (error) {
        const conflict = idempotencyConflictBody(error);
        if (!conflict) throw error;
        return context.json(conflict, 409);
      }
      dashboardRefresh.publish("enqueue");

      return context.json({ ...accepted, status: "queued" }, 202);
    })
    .post("/demo/retries", async (context) => {
      const body = (await context.req.json().catch(() => ({}))) as {
        failUntilAttempt?: number;
      };
      const requested = body.failUntilAttempt;
      const failUntilAttempt =
        typeof requested === "number" && Number.isInteger(requested) && requested >= 1
          ? Math.min(requested, 10)
          : 1;
      const headers = readIdempotencyHeaders(
        {
          key: context.req.header(IDEMPOTENCY_KEY_HEADER),
          scope: context.req.header(IDEMPOTENCY_SCOPE_HEADER),
        },
        "workhorse-demo:retries",
      );
      if (headers.error) return context.json({ error: headers.error }, 400);
      let jobId: string;
      try {
        jobId = await context.var.workhorse.queue.enqueue(
          RETRY_JOB_TYPE,
          { label: "recover-with-durable-checkpoint", failUntilAttempt },
          {
            maxAttempts: failUntilAttempt + 2,
            tags: ["demo-test", "durable-checkpoint"],
            ...(headers.idempotency === null ? {} : { idempotency: headers.idempotency }),
          },
        );
      } catch (error) {
        const conflict = idempotencyConflictBody(error);
        if (!conflict) throw error;
        return context.json(conflict, 409);
      }
      dashboardRefresh.publish("enqueue");
      return context.json(
        {
          jobId,
          status: "queued",
          expectedAttempts: failUntilAttempt + 1,
          expectedCheckpoint: RETRY_CHECKPOINT_NAME,
        },
        202,
      );
    })
    .post("/demo/durable", async (context) => {
      const body = (await context.req.json().catch(() => ({}))) as { scenario?: unknown };
      const scenario = body.scenario
        ? parseDurableDemoScenario(body.scenario)
        : ("order-fulfillment" as const);
      if (!scenario) {
        return context.json(
          { error: `Expected scenario: ${Object.keys(durableDemoScenarios).join(", ")}` },
          400,
        );
      }
      const definition = durableDemoScenarios[scenario];
      const headers = readIdempotencyHeaders(
        {
          key: context.req.header(IDEMPOTENCY_KEY_HEADER),
          scope: context.req.header(IDEMPOTENCY_SCOPE_HEADER),
        },
        "workhorse-demo:durable",
      );
      if (headers.error) return context.json({ error: headers.error }, 400);
      let jobId: string;
      try {
        jobId = await context.var.workhorse.queue.enqueue(
          DURABLE_DEMO_JOB_TYPE,
          { scenario },
          {
            maxAttempts: 2,
            tags: ["demo-test", "durable-checkpoint", scenario],
            ...(headers.idempotency === null ? {} : { idempotency: headers.idempotency }),
          },
        );
      } catch (error) {
        const conflict = idempotencyConflictBody(error);
        if (!conflict) throw error;
        return context.json(conflict, 409);
      }
      dashboardRefresh.publish("enqueue");
      return context.json(
        {
          jobId,
          status: "queued",
          scenario,
          checkpointPlan: definition.steps.map((step) => step.name),
          expectedAttempts: 2,
        },
        202,
      );
    })
    .post("/demo/timers", async (context) => {
      const headers = readIdempotencyHeaders(
        {
          key: context.req.header(IDEMPOTENCY_KEY_HEADER),
          scope: context.req.header(IDEMPOTENCY_SCOPE_HEADER),
        },
        "workhorse-demo:timers",
      );
      if (headers.error) return context.json({ error: headers.error }, 400);
      let jobId: string;
      try {
        jobId = await context.var.workhorse.queue.enqueue(
          DURABLE_TIMER_JOB_TYPE,
          { source: "http" },
          {
            maxAttempts: 1,
            tags: ["demo-test", "durable-checkpoint", "durable-timer"],
            ...(headers.idempotency === null ? {} : { idempotency: headers.idempotency }),
          },
        );
      } catch (error) {
        const conflict = idempotencyConflictBody(error);
        if (!conflict) throw error;
        return context.json(conflict, 409);
      }
      dashboardRefresh.publish("enqueue");
      return context.json(
        {
          jobId,
          status: "queued",
          expectedAttempt: 1,
          prepareCheckpoint: DURABLE_TIMER_PREPARE_CHECKPOINT,
          waitName: DURABLE_TIMER_WAIT_NAME,
          publishCheckpoint: DURABLE_TIMER_PUBLISH_CHECKPOINT,
        },
        202,
      );
    })
    .post("/demo/failures", async (context) => {
      const headers = readIdempotencyHeaders(
        {
          key: context.req.header(IDEMPOTENCY_KEY_HEADER),
          scope: context.req.header(IDEMPOTENCY_SCOPE_HEADER),
        },
        "workhorse-demo:failures",
      );
      if (headers.error) return context.json({ error: headers.error }, 400);
      let jobId: string;
      try {
        jobId = await context.var.workhorse.queue.enqueue(
          FAILURE_JOB_TYPE,
          { label: "terminal-failure" },
          {
            maxAttempts: 1,
            tags: ["demo-test"],
            ...(headers.idempotency === null ? {} : { idempotency: headers.idempotency }),
          },
        );
      } catch (error) {
        const conflict = idempotencyConflictBody(error);
        if (!conflict) throw error;
        return context.json(conflict, 409);
      }
      dashboardRefresh.publish("enqueue");
      return context.json({ jobId, status: "queued", expectedOutcome: "failed" }, 202);
    })
    .get("/orders/:id", async (context) => {
      const order = await database.query.orders.findFirst({
        where: eq(orders.id, context.req.param("id")),
      });
      if (!order) return context.json({ error: "Order not found" }, 404);
      return context.json({ order });
    })
    .get("/jobs/:id", async (context) => {
      const job = await context.var.workhorse.queue.getJob(context.req.param("id"));
      if (!job) return context.json({ error: "Job not found" }, 404);
      return context.json({ job: { ...job, fenceToken: job.fenceToken.toString() } });
    })
    .get("/health", async (context) =>
      context.json({ status: "ok", workhorse: await context.var.workhorse.queue.health() }),
    );

  if (options.dashboard !== false) {
    mountWorkhorseDashboard(app, {
      path: "/workhorse",
      workhorse,
      authorize: () => true,
      environment,
      configuredWorkers: DEMO_WORKERS,
      maintenanceLoops: { tickIntervalMs: maintenanceIntervalMs, housekeepingIntervalMs },
      operator: options.operator ?? createReadOnlyOperator(),
      scheduleController: options.scheduleController,
      queueController: options.queueController,
      taskController,
      workerController,
      projectDurability: durableDemoPlanForJob,
      refresh: dashboardRefresh,
      auditActor: "local-demo",
    });
  }

  return { app, workhorse, dashboardRefresh, workerController };
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
    // The seven-day window crosses into the previous ISO week. Use the core partition helper so
    // backdated attempts do not accumulate in the default partition.
    await transaction.execute(sql`
      SELECT workhorse.create_history_week_v1((current_date - interval '1 week')::date)
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

export async function seedDemoData(database: DemoDatabase) {
  const jobIds = await database.transaction(async (transaction) => {
    const marker = await transaction.execute<{ name: string }>(sql`
      INSERT INTO public.workhorse_demo_seed (name)
      VALUES (${REPRESENTATIVE_SEED_NAME})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `);
    if (marker.rows.length === 0) return [];

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
    return seededJobIds;
  });

  const historicalJobCount = await seedHistoricalDemoData(database);
  return {
    seeded: jobIds.length > 0 || historicalJobCount > 0,
    jobIds,
    historicalJobCount,
  };
}

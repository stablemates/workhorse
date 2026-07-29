import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createDrizzleAdapter } from "@workhorse/drizzle";
import { HonoWorkhorse } from "@workhorse/hono";
import { RPCHandler } from "@orpc/server/fetch";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Queue, type Json } from "@workhorse/core";
import type { Pool } from "pg";
import { z } from "zod";
import { DashboardRefreshHub } from "./dashboard-refresh.js";
import { dashboardRouter } from "./rpc.js";
import { orders } from "./schema.js";

const ORDER_JOB_TYPE = "order.process";
const RETRY_JOB_TYPE = "demo.retry";
const FAILURE_JOB_TYPE = "demo.failure";
const LONG_RUNNING_JOB_TYPE = "demo.long-running";
const RECURRING_JOB_TYPE = "demo.recurring";
const REPORT_JOB_TYPE = "demo.report";
const DEMO_QUEUE = "demo";
const REPRESENTATIVE_SEED_NAME = "default-dashboard-v2";
const HISTORICAL_SEED_NAME = "historical-dashboard-v1";
const HISTORICAL_JOB_COUNT = 362;
export const DEMO_WORKERS = ["demo-worker-1", "demo-worker-2"] as const;
export const DEMO_WORKER_POLL_MS = 15_000;
export const DEMO_MAINTENANCE_INTERVAL_MS = 1_000;
export const DEMO_HOUSEKEEPING_INTERVAL_MS = 60_000;
export const DEMO_LONG_RUNNING_MS = 20_000;
export const DEMO_SCHEDULE_NAMESPACE = "workhorse-demo";
export const HEARTBEAT_SCHEDULE_NAME = "heartbeat";
export const REPORT_SCHEDULE_NAME = "demo.report";
const DEMO_INDEX = {
  name: "Workhorse demo",
  endpoints: [
    "POST /orders",
    "POST /demo/retries",
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
  operator?: DashboardOperator;
  scheduleController?: ScheduleController;
  workerPollMs?: number;
  maintenanceIntervalMs?: number;
  housekeepingIntervalMs?: number;
  longRunningJobMs?: number;
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
    kind: "success" | "retry" | "failure" | "long-running",
    audit: AuditContext,
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

const orderRequestSchema = z.object({
  customerEmail: z
    .string()
    .email()
    .transform((value) => value.trim()),
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

export function createReadOnlyOperator(): DashboardOperator {
  return { mode: "read-only" };
}

export function createLocalOperator(database: DemoDatabase): DashboardOperator {
  return {
    mode: "local",
    async enqueueTest(kind, audit) {
      const target = `job:${kind}`;
      return database.transaction(async (transaction) => {
        const workhorse = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
        const type = {
          success: RECURRING_JOB_TYPE,
          retry: RETRY_JOB_TYPE,
          failure: FAILURE_JOB_TYPE,
          "long-running": LONG_RUNNING_JOB_TYPE,
        }[kind];
        const failUntilAttempt = kind === "retry" ? 1 + Math.floor(Math.random() * 10) : null;
        const maxAttempts =
          kind === "failure" ? 1 : failUntilAttempt !== null ? failUntilAttempt + 2 : undefined;
        const payload: Json =
          kind === "success"
            ? { source: "operator" }
            : failUntilAttempt !== null
              ? { label: `operator-${kind}`, failUntilAttempt }
              : { label: `operator-${kind}` };
        const jobId = await workhorse.queue.enqueue(
          type,
          payload,
          maxAttempts === undefined ? {} : { maxAttempts },
        );
        await transaction.execute(sql`
          INSERT INTO public.workhorse_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'enqueueTest', ${target},
             NULL, ${JSON.stringify({ jobId, type, payload, maxAttempts })}::jsonb, 'succeeded')
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

export function createDemoApplication(
  database: DemoDatabase,
  options: CreateDemoApplicationOptions = {},
) {
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEMO_MAINTENANCE_INTERVAL_MS;
  const housekeepingIntervalMs = options.housekeepingIntervalMs ?? DEMO_HOUSEKEEPING_INTERVAL_MS;
  const dashboardRefresh = options.dashboardRefresh ?? new DashboardRefreshHub();
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
        maintenanceIntervalMs,
        housekeepingIntervalMs,
        retryDelayMs: (attempt) => attempt * 100,
      },
      configure(worker) {
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
          async ({ label, failUntilAttempt }, { job }) => {
            const failuresBefore = failUntilAttempt ?? 1;
            if (job.attempt <= failuresBefore) {
              throw new Error(`Intentional demo failure ${job.attempt}/${failuresBefore}`);
            }
            dashboardRefresh.publish("worker");
            return { label, recovered: true, attempt: job.attempt };
          },
        );
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
  const rpcHandler = new RPCHandler(dashboardRouter);

  const app = new Hono()
    .use("*", workhorse.middleware())
    .get("/", (context) =>
      options.dashboard === false ? context.json(DEMO_INDEX) : context.redirect("/tasks"),
    )
    .get("/api", (context) => context.json(DEMO_INDEX))
    .post("/orders", async (context) => {
      const request = parseOrderRequest(await context.req.json().catch(() => null));
      if (!request) {
        return context.json({ error: "Expected customerEmail and a non-empty description" }, 400);
      }

      const orderId = randomUUID();
      const jobId = await database.transaction(async (transaction) => {
        await transaction.insert(orders).values({
          id: orderId,
          customerEmail: request.customerEmail,
          description: request.description,
          status: "queued",
        });
        return context.var.workhorse
          .forTransaction(transaction)
          .enqueue(ORDER_JOB_TYPE, { orderId });
      });
      dashboardRefresh.publish("enqueue");

      return context.json({ orderId, jobId, status: "queued" }, 202);
    })
    .post("/demo/retries", async (context) => {
      const body = (await context.req.json().catch(() => ({}))) as {
        failUntilAttempt?: number;
      };
      const requested = body.failUntilAttempt;
      const failUntilAttempt =
        typeof requested === "number" && Number.isInteger(requested) && requested >= 1
          ? Math.min(requested, 10)
          : 1 + Math.floor(Math.random() * 10);
      const jobId = await context.var.workhorse.queue.enqueue(
        RETRY_JOB_TYPE,
        { label: "recover-after-random-failures", failUntilAttempt },
        { maxAttempts: failUntilAttempt + 2 },
      );
      dashboardRefresh.publish("enqueue");
      return context.json({ jobId, status: "queued", expectedAttempts: failUntilAttempt + 1 }, 202);
    })
    .post("/demo/failures", async (context) => {
      const jobId = await context.var.workhorse.queue.enqueue(
        FAILURE_JOB_TYPE,
        { label: "terminal-failure" },
        { maxAttempts: 1 },
      );
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
    app.all("/rpc/*", async (context) => {
      const { response } = await rpcHandler.handle(context.req.raw, {
        prefix: "/rpc",
        context: {
          database,
          queue: context.var.workhorse.queue,
          configuredWorkers: DEMO_WORKERS,
          maintenanceLoops: { tickIntervalMs: maintenanceIntervalMs, housekeepingIntervalMs },
          operator: options.operator ?? createReadOnlyOperator(),
          scheduleController: options.scheduleController,
        },
      });
      return response ?? context.notFound();
    });
    app.get("/dashboard/events", (context) =>
      streamSSE(context, async (stream) => {
        let writes = Promise.resolve();
        const publish = (event: { reason: string; occurredAt: string }) => {
          writes = writes.then(() =>
            stream.writeSSE({ event: "refresh", data: JSON.stringify(event) }),
          );
        };
        const unsubscribe = dashboardRefresh.subscribe(publish);
        const fallback = setInterval(
          () => publish({ reason: "fallback", occurredAt: new Date().toISOString() }),
          15_000,
        );
        fallback.unref();
        publish({ reason: "connected", occurredAt: new Date().toISOString() });

        try {
          await new Promise<void>((resolve) => {
            context.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          clearInterval(fallback);
          unsubscribe();
          await writes.catch(() => undefined);
        }
      }),
    );
  }

  return { app, workhorse, dashboardRefresh };
}

function jsonbValue(value: Json | null) {
  return value === null ? sql`NULL` : sql`${JSON.stringify(value)}::jsonb`;
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
        (id, queue_name, job_type, payload, max_attempts, created_at)
      VALUES ${sql.join(
        jobs.map(
          (job) => sql`(
            ${job.id}, ${job.queueName}, ${job.jobType}, ${JSON.stringify(job.payload)}::jsonb,
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
        (job_id, attempt, fence_token, worker_id, outcome, started_at, finished_at, error, occurred_at)
      VALUES ${sql.join(
        jobs.flatMap((job) =>
          job.attempts.map(
            (attempt) => sql`(
              ${job.id}, ${attempt.attempt}, ${attempt.fenceToken}, ${attempt.workerId},
              ${attempt.outcome}, ${attempt.startedAt}, ${attempt.finishedAt},
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

export async function seedDemoData(
  database: DemoDatabase,
  app: ReturnType<typeof createDemoApplication>["app"],
) {
  const marker = await database.execute<{ name: string }>(sql`
    INSERT INTO public.workhorse_demo_seed (name)
    VALUES (${REPRESENTATIVE_SEED_NAME})
    ON CONFLICT (name) DO NOTHING
    RETURNING name
  `);
  const jobIds: string[] = [];

  if (marker.rows.length > 0) {
    try {
      const orderResponse = await app.request("/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerEmail: "demo.operator@example.com",
          description: "Inspect a successful transactional order",
        }),
      });
      const retryResponse = await app.request("/demo/retries", { method: "POST" });
      const failureResponse = await app.request("/demo/failures", { method: "POST" });
      const responses = [orderResponse, retryResponse, failureResponse];
      if (responses.some((response) => response.status !== 202)) {
        throw new Error(
          `Demo seed requests failed with statuses ${responses.map((response) => response.status).join(", ")}`,
        );
      }

      const order = (await orderResponse.json()) as { jobId: string };
      const retry = (await retryResponse.json()) as { jobId: string };
      const failure = (await failureResponse.json()) as { jobId: string };
      const workhorse = createDrizzleAdapter(database, { defaultQueue: DEMO_QUEUE });
      const scheduledJobId = await workhorse.queue.enqueue(
        RECURRING_JOB_TYPE,
        { source: "scheduled-seed" },
        { runAt: new Date(Date.now() + 24 * 60 * 60 * 1_000) },
      );
      jobIds.push(order.jobId, retry.jobId, failure.jobId, scheduledJobId);
    } catch (error) {
      await database.execute(sql`
        DELETE FROM public.workhorse_demo_seed WHERE name = ${REPRESENTATIVE_SEED_NAME}
      `);
      throw error;
    }
  }

  const historicalJobCount = await seedHistoricalDemoData(database);
  return {
    seeded: marker.rows.length > 0 || historicalJobCount > 0,
    jobIds,
    historicalJobCount,
  };
}

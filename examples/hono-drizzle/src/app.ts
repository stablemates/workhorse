import { randomUUID } from "node:crypto";
import { createDrizzleAdapter } from "@ironshift/drizzle";
import { HonoIronshift } from "@ironshift/hono";
import { RPCHandler } from "@orpc/server/fetch";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { PgCronScheduler, type Json, type PgCronSyncResult } from "ironshift";
import type { Pool } from "pg";
import { z } from "zod";
import { DashboardRefreshHub } from "./dashboard-refresh.js";
import { dashboardRouter } from "./rpc.js";
import { orders } from "./schema.js";

const ORDER_JOB_TYPE = "order.process";
const RETRY_JOB_TYPE = "demo.retry";
const FAILURE_JOB_TYPE = "demo.failure";
const RECURRING_JOB_TYPE = "demo.recurring";
const DEMO_QUEUE = "demo";
export const DEMO_WORKERS = ["demo-worker-1", "demo-worker-2"] as const;
export const DEMO_WORKER_POLL_MS = 15_000;
export const DEMO_SCHEDULE_NAMESPACE = "ironshift-hono-drizzle-demo";
export const HEARTBEAT_SCHEDULE_NAME = "heartbeat";
export const DEMO_MAINTENANCE = {
  schedule: "1 second",
  batchSize: 1_000,
  occurrenceRetentionDays: 30,
  occurrencePruneLimit: 10_000,
} as const;
const DEMO_INDEX = {
  name: "Ironshift Hono + Drizzle demo",
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
  schedulerStatusProvider?: SchedulerStatusProvider;
  workerMaintenance?: "worker" | "external";
  workerPollMs?: number;
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
    kind: "success" | "retry" | "failure",
    audit: AuditContext,
  ) => Promise<{ jobId: string }>;
}

export interface ScheduleController {
  setScheduleEnabled?: (
    name: string,
    enabled: boolean,
    audit: AuditContext,
  ) => Promise<{ enabled: boolean }>;
}

export type SchedulerStatusProvider = () => Promise<PgCronSyncResult | null>;

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

function heartbeatSchedule(enabled = true) {
  return {
    name: HEARTBEAT_SCHEDULE_NAME,
    schedule: "* * * * *",
    enabled,
    job: {
      type: RECURRING_JOB_TYPE,
      queue: DEMO_QUEUE,
      payload: { source: "pg_cron" },
      maxAttempts: 3,
    },
  } as const;
}

export async function installDemoSchema(database: DemoDatabase): Promise<void> {
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.ironshift_demo_order (
      id uuid PRIMARY KEY,
      customer_email text NOT NULL,
      description text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      processed_at timestamptz
    )
  `);
  await database.execute(sql`
    CREATE INDEX IF NOT EXISTS ironshift_demo_order_created_at_idx
    ON public.ironshift_demo_order (created_at DESC)
  `);
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.ironshift_demo_seed (
      name text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS public.ironshift_demo_audit (
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
    CREATE UNIQUE INDEX IF NOT EXISTS ironshift_demo_audit_request_id_idx
    ON public.ironshift_demo_audit (request_id)
  `);
}

export async function syncDemoSchedules(database: Pool, cronDatabase: Pool) {
  const scheduler = new PgCronScheduler(database, cronDatabase, {
    namespace: DEMO_SCHEDULE_NAMESPACE,
  });
  const result = await scheduler.sync([heartbeatSchedule()], { maintenance: DEMO_MAINTENANCE });
  return { scheduler, result };
}

export function createPgCronSchedulerStatusProvider(
  scheduler: PgCronScheduler | undefined,
): SchedulerStatusProvider | undefined {
  if (!scheduler) return undefined;
  return async () => scheduler.status();
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
        const ironshift = createDrizzleAdapter(transaction, { defaultQueue: DEMO_QUEUE });
        const type =
          kind === "success"
            ? RECURRING_JOB_TYPE
            : kind === "failure"
              ? FAILURE_JOB_TYPE
              : RETRY_JOB_TYPE;
        const maxAttempts = kind === "failure" ? 1 : 3;
        const payload: Json =
          kind === "success" ? { source: "operator" } : { label: `operator-${kind}` };
        const jobId = await ironshift.queue.enqueue(type, payload, { maxAttempts });
        await transaction.execute(sql`
          INSERT INTO public.ironshift_demo_audit
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

export function createLocalScheduleController(
  database: DemoDatabase,
  scheduler?: PgCronScheduler,
): ScheduleController {
  return {
    async setScheduleEnabled(name, enabled, audit) {
      if (name !== HEARTBEAT_SCHEDULE_NAME)
        throw new Error(`Schedule ${name} is not controlled here`);
      if (scheduler) {
        const before = await database.execute<{ enabled: boolean }>(sql`
          SELECT enabled FROM ironshift.schedule_definition
           WHERE namespace = ${DEMO_SCHEDULE_NAMESPACE} AND schedule_name = ${name}
        `);
        if (before.rows.length === 0) throw new Error(`Schedule ${name} not found`);
        await scheduler.sync([heartbeatSchedule(enabled)], {
          maintenance: DEMO_MAINTENANCE,
          prune: false,
        });
        await database.execute(sql`
          INSERT INTO public.ironshift_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'setScheduleEnabled', ${`schedule:${name}`},
             ${JSON.stringify(before.rows[0])}::jsonb, ${JSON.stringify({ enabled })}::jsonb, 'succeeded')
        `);
        return { enabled };
      }
      const rows = await database.transaction(async (transaction) => {
        const before = await transaction.execute<{ enabled: boolean }>(sql`
          SELECT enabled FROM ironshift.schedule_definition
           WHERE namespace = ${DEMO_SCHEDULE_NAMESPACE} AND schedule_name = ${name}
           FOR UPDATE
        `);
        if (before.rows.length === 0) throw new Error(`Schedule ${name} not found`);
        const updated = await transaction.execute<{ enabled: boolean }>(sql`
          UPDATE ironshift.schedule_definition
             SET enabled = ${enabled}, revision = revision + 1, updated_at = clock_timestamp()
           WHERE namespace = ${DEMO_SCHEDULE_NAMESPACE} AND schedule_name = ${name}
           RETURNING enabled
        `);
        await transaction.execute(sql`
          INSERT INTO public.ironshift_demo_audit
            (actor, reason, request_id, occurred_at, action, target, before, after, status)
          VALUES
            (${audit.actor}, ${audit.reason}, ${audit.requestId},
             ${audit.occurredAt ?? new Date().toISOString()}, 'setScheduleEnabled', ${`schedule:${name}`},
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
  const dashboardRefresh = options.dashboardRefresh ?? new DashboardRefreshHub();
  const adapter = createDrizzleAdapter(database, {
    defaultQueue: DEMO_QUEUE,
    close: options.close,
  });
  const ironshift = new HonoIronshift(adapter, {
    workers: DEMO_WORKERS.map((workerId) => ({
      options: {
        queue: DEMO_QUEUE,
        workerId,
        maintenance: options.workerMaintenance ?? "worker",
        pollMs: options.workerPollMs ?? DEMO_WORKER_POLL_MS,
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
        worker.handle<{ label: string }>(RETRY_JOB_TYPE, async ({ label }, { job }) => {
          if (job.attempt === 1) throw new Error("Intentional first-attempt demo failure");
          dashboardRefresh.publish("worker");
          return { label, recovered: true, attempt: job.attempt };
        });
        worker.handle<{ source: string }>(RECURRING_JOB_TYPE, async ({ source }, { job }) => {
          dashboardRefresh.publish("worker");
          return { source, recurring: true, attempt: job.attempt };
        });
        worker.handle(FAILURE_JOB_TYPE, () => {
          throw new Error("Intentional terminal demo failure");
        });
      },
    })),
    onWorkerError(error) {
      options.onWorkerError?.(error);
    },
  });
  const rpcHandler = new RPCHandler(dashboardRouter);

  const app = new Hono()
    .use("*", ironshift.middleware())
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
        return context.var.ironshift
          .forTransaction(transaction)
          .enqueue(ORDER_JOB_TYPE, { orderId }, { maxAttempts: 3 });
      });
      dashboardRefresh.publish("enqueue");

      return context.json({ orderId, jobId, status: "queued" }, 202);
    })
    .post("/demo/retries", async (context) => {
      const jobId = await context.var.ironshift.queue.enqueue(
        RETRY_JOB_TYPE,
        { label: "recover-after-one-failure" },
        { maxAttempts: 3 },
      );
      dashboardRefresh.publish("enqueue");
      return context.json({ jobId, status: "queued", expectedAttempts: 2 }, 202);
    })
    .post("/demo/failures", async (context) => {
      const jobId = await context.var.ironshift.queue.enqueue(
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
      const job = await context.var.ironshift.queue.getJob(context.req.param("id"));
      if (!job) return context.json({ error: "Job not found" }, 404);
      return context.json({ job: { ...job, fenceToken: job.fenceToken.toString() } });
    })
    .get("/health", async (context) =>
      context.json({ status: "ok", ironshift: await context.var.ironshift.queue.health() }),
    );

  if (options.dashboard !== false) {
    app.all("/rpc/*", async (context) => {
      const { response } = await rpcHandler.handle(context.req.raw, {
        prefix: "/rpc",
        context: {
          database,
          queue: context.var.ironshift.queue,
          configuredWorkers: DEMO_WORKERS,
          operator: options.operator ?? createReadOnlyOperator(),
          scheduleController: options.scheduleController,
          schedulerStatusProvider: options.schedulerStatusProvider,
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

  return { app, ironshift, dashboardRefresh };
}

export async function seedDemoData(
  database: DemoDatabase,
  app: ReturnType<typeof createDemoApplication>["app"],
) {
  const marker = await database.execute<{ name: string }>(sql`
    INSERT INTO public.ironshift_demo_seed (name)
    VALUES ('default-dashboard-v2')
    ON CONFLICT (name) DO NOTHING
    RETURNING name
  `);
  if (marker.rows.length === 0) return { seeded: false, jobIds: [] };

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
    const ironshift = createDrizzleAdapter(database, { defaultQueue: DEMO_QUEUE });
    const scheduledJobId = await ironshift.queue.enqueue(
      RECURRING_JOB_TYPE,
      { source: "scheduled-seed" },
      { runAt: new Date(Date.now() + 24 * 60 * 60 * 1_000) },
    );
    return { seeded: true, jobIds: [order.jobId, retry.jobId, failure.jobId, scheduledJobId] };
  } catch (error) {
    await database.execute(sql`
      DELETE FROM public.ironshift_demo_seed WHERE name = 'default-dashboard-v2'
    `);
    throw error;
  }
}

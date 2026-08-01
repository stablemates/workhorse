import { ORPCError, os } from "@orpc/server";
import type { Queue } from "@workhorse/core";
import type { DashboardSystemWindow, MaintenanceLoopCadences } from "../model.js";
import { z } from "zod";
import type {
  DashboardAuditContext,
  DashboardDurabilityProjector,
  DashboardOperator,
  DashboardQueueController,
  DashboardScheduleController,
  DashboardTaskController,
  DashboardWorkerController,
} from "./types.js";
import type { DashboardDatabase } from "./sql.js";
import {
  readDashboardActivity,
  readDashboardCron,
  readDashboardJobDetail,
  readDashboardQueues,
  readDashboardSystem,
  readDashboardTaskFacets,
  readDashboardTaskCounts,
  readDashboardTasks,
  readDashboardWorkers,
} from "./read-model.js";

export interface DashboardRpcContext {
  database: DashboardDatabase;
  queue: Queue;
  configuredWorkers: readonly string[];
  environment: string;
  maintenanceLoops: MaintenanceLoopCadences;
  operator: DashboardOperator;
  scheduleController?: DashboardScheduleController;
  queueController?: DashboardQueueController;
  taskController?: DashboardTaskController;
  workerController?: DashboardWorkerController;
  projectDurability?: DashboardDurabilityProjector;
}

const procedure = os.$context<DashboardRpcContext>();

const auditSchema = z.object({
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
});

const jobDetailInput = z.object({ id: z.uuid() });
const taskFilter = z.enum([
  "all",
  "scheduled",
  "retried",
  "queued",
  "running",
  "completed",
  "discarded",
  // Cancellation is its own terminal filter. It is never merged into "discarded", which means a
  // task that exhausted its attempts.
  "canceled",
]);
const tasksInput = z.object({
  filter: taskFilter.default("all"),
  queue: z.string().trim().min(1).nullable().default(null),
  page: z.number().int().min(1).default(1),
  worker: z.string().trim().min(1).nullable().default(null),
  jobType: z.string().trim().min(1).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  search: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(50),
});
const activityInput = z.object({
  filter: taskFilter.default("all"),
  period: z.enum(["15m", "1h", "6h", "24h", "7d"]).default("1h"),
  groupBy: z.enum(["queue", "worker", "task", "status"]).default("queue"),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  queue: z.string().trim().min(1).nullable().default(null),
  worker: z.string().trim().min(1).nullable().default(null),
});
const systemInput = z.object({
  window: z.enum(["15m", "1h", "24h"]).default("1h"),
});
const enqueueTestInput = z.object({
  kind: z.enum(["success", "retry", "durable", "timer", "failure", "idempotent", "long-running"]),
  scenario: z.enum(["order-fulfillment", "customer-onboarding", "report-publication"]).optional(),
  audit: auditSchema,
});
const setScheduleEnabledInput = z.object({
  kind: z.literal("user"),
  namespace: z.string().trim().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  audit: auditSchema,
});
const setQueuePausedInput = z.object({
  queue: z.string().trim().min(1),
  paused: z.boolean(),
  audit: auditSchema,
});
const purgeQueueInput = z.object({
  queue: z.string().trim().min(1),
  audit: auditSchema,
});
const setWorkerPausedInput = z.object({
  workerId: z.string().trim().min(1),
  paused: z.boolean(),
  audit: auditSchema,
});
/**
 * One cancellation request. The audit reason is required and reused as the stored cancellation
 * reason, so a task can never be canceled without a recorded operator justification.
 */
const cancelTaskInput = z.object({
  id: z.uuid(),
  audit: auditSchema,
});

function auditWithOccurredAt(
  audit: z.infer<typeof auditSchema>,
): DashboardAuditContext & { occurredAt: string } {
  return { ...audit, occurredAt: new Date().toISOString() };
}

export const dashboardRouter = {
  dashboard: {
    meta: procedure.handler(({ context }) => ({ environment: context.environment })),
    taskCounts: procedure.handler(({ context }) => readDashboardTaskCounts(context.database)),
    tasks: procedure
      .input(tasksInput)
      .handler(({ context, input }) =>
        readDashboardTasks(
          context.database,
          input.filter,
          input.page,
          input.pageSize,
          input.queue,
          input.tags,
          input.search,
          input.worker,
          input.jobType,
          context.projectDurability,
        ),
      ),
    taskFacets: procedure.handler(({ context }) =>
      readDashboardTaskFacets(context.database, context.configuredWorkers),
    ),
    activity: procedure
      .input(activityInput)
      .handler(({ context, input }) =>
        readDashboardActivity(
          context.database,
          input.filter,
          input.period,
          input.groupBy,
          input.tags,
          input.queue,
          input.worker,
        ),
      ),
    cron: procedure.handler(({ context }) =>
      readDashboardCron(context.database, context.maintenanceLoops),
    ),
    queues: procedure.handler(({ context }) => readDashboardQueues(context.database)),
    system: procedure
      .input(systemInput)
      .handler(({ context, input }) =>
        readDashboardSystem(context.database, context.queue, input.window as DashboardSystemWindow),
      ),
    workers: procedure.handler(({ context }) => {
      const canManageWorkers =
        context.operator.mode === "local" && Boolean(context.workerController?.setWorkerPaused);
      return readDashboardWorkers(
        context.database,
        context.configuredWorkers,
        context.workerController?.workerStates(),
        canManageWorkers,
      );
    }),
    jobDetail: procedure.input(jobDetailInput).handler(async ({ context, input }) => {
      const detail = await readDashboardJobDetail(
        context.database,
        input.id,
        context.projectDurability,
      );
      if (!detail) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
      return detail;
    }),
    enqueueTest: procedure.input(enqueueTestInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.operator.enqueueTest) {
        throw new ORPCError("FORBIDDEN", { message: "Operator is read-only" });
      }
      return context.operator.enqueueTest(
        input.kind,
        auditWithOccurredAt(input.audit),
        input.scenario,
      );
    }),
    setScheduleEnabled: procedure
      .input(setScheduleEnabledInput)
      .handler(async ({ context, input }) => {
        if (context.operator.mode !== "local" || !context.scheduleController?.setScheduleEnabled) {
          throw new ORPCError("FORBIDDEN", { message: "Operator is read-only" });
        }
        return context.scheduleController.setScheduleEnabled(
          input.namespace,
          input.name,
          input.enabled,
          auditWithOccurredAt(input.audit),
        );
      }),
    setQueuePaused: procedure.input(setQueuePausedInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.queueController?.setQueuePaused) {
        throw new ORPCError("FORBIDDEN", { message: "Operator is read-only" });
      }
      return context.queueController.setQueuePaused(
        input.queue,
        input.paused,
        auditWithOccurredAt(input.audit),
      );
    }),
    purgeQueue: procedure.input(purgeQueueInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.queueController?.purgeQueue) {
        throw new ORPCError("FORBIDDEN", { message: "Operator is read-only" });
      }
      return context.queueController.purgeQueue(input.queue, auditWithOccurredAt(input.audit));
    }),
    setWorkerPaused: procedure.input(setWorkerPausedInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.workerController?.setWorkerPaused) {
        throw new ORPCError("FORBIDDEN", { message: "Operator is read-only" });
      }
      return context.workerController.setWorkerPaused(
        input.workerId,
        input.paused,
        auditWithOccurredAt(input.audit),
      );
    }),
    /**
     * Cancel one task. The returned status is exactly what PostgreSQL reported, so the caller can
     * distinguish an immediate cancellation from a cooperative request an active handler still has
     * to observe, and from a terminal task that was left untouched.
     */
    cancelTask: procedure.input(cancelTaskInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.taskController?.cancelTask) {
        throw new ORPCError("FORBIDDEN", { message: "Operator is read-only" });
      }
      const result = await context.taskController.cancelTask(
        input.id,
        auditWithOccurredAt(input.audit),
      );
      if (result.status === "not_found") {
        throw new ORPCError("NOT_FOUND", { message: "Job not found" });
      }
      return result;
    }),
  },
};

export type DashboardRouter = typeof dashboardRouter;

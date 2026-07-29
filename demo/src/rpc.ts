import { ORPCError, os } from "@orpc/server";
import type { Queue } from "@workhorse/core";
import { z } from "zod";
import type {
  AuditContext,
  DashboardOperator,
  DemoDatabase,
  QueueController,
  ScheduleController,
  WorkerController,
} from "./app.js";
import {
  type MaintenanceLoopCadences,
  readDashboardActivity,
  readDashboardCron,
  readDashboardJobDetail,
  readDashboardQueues,
  readDashboardSystem,
  readDashboardTaskCounts,
  readDashboardTasks,
  readDashboardWorkers,
} from "./dashboard.js";

export interface DashboardRpcContext {
  database: DemoDatabase;
  queue: Queue;
  configuredWorkers: readonly string[];
  maintenanceLoops: MaintenanceLoopCadences;
  operator: DashboardOperator;
  scheduleController?: ScheduleController;
  queueController?: QueueController;
  workerController?: WorkerController;
}

const procedure = os.$context<DashboardRpcContext>();

const auditSchema = z.object({
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
});

const jobDetailInput = z.object({ id: z.string().uuid() });
const taskFilter = z.enum([
  "all",
  "scheduled",
  "retried",
  "queued",
  "running",
  "completed",
  "discarded",
]);
const tasksInput = z.object({
  filter: taskFilter.default("all"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(10),
});
const activityInput = z.object({
  filter: taskFilter.default("all"),
  period: z.enum(["15m", "1h", "6h", "24h", "7d"]).default("1h"),
  groupBy: z.enum(["queue", "worker", "task"]).default("queue"),
});
const enqueueTestInput = z.object({
  kind: z.enum(["success", "retry", "failure", "long-running"]),
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

function auditWithOccurredAt(
  audit: z.infer<typeof auditSchema>,
): AuditContext & { occurredAt: string } {
  return { ...audit, occurredAt: new Date().toISOString() };
}

export const dashboardRouter = {
  dashboard: {
    taskCounts: procedure.handler(({ context }) => readDashboardTaskCounts(context.database)),
    tasks: procedure
      .input(tasksInput)
      .handler(({ context, input }) =>
        readDashboardTasks(context.database, input.filter, input.page, input.pageSize),
      ),
    activity: procedure
      .input(activityInput)
      .handler(({ context, input }) =>
        readDashboardActivity(context.database, input.filter, input.period, input.groupBy),
      ),
    cron: procedure.handler(({ context }) =>
      readDashboardCron(context.database, context.maintenanceLoops),
    ),
    queues: procedure.handler(({ context }) => readDashboardQueues(context.database)),
    system: procedure.handler(({ context }) =>
      readDashboardSystem(context.database, context.queue),
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
      const detail = await readDashboardJobDetail(context.database, input.id);
      if (!detail) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
      return detail;
    }),
    enqueueTest: procedure.input(enqueueTestInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.operator.enqueueTest) {
        throw new ORPCError("FORBIDDEN", { message: "Operator is read-only" });
      }
      return context.operator.enqueueTest(input.kind, auditWithOccurredAt(input.audit));
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
  },
};

export type DashboardRouter = typeof dashboardRouter;

import { ORPCError, os } from "@orpc/server";
import type { Queue } from "@workhorse/core";
import { z } from "zod";
import type { AuditContext, DashboardOperator, DemoDatabase, ScheduleController } from "./app.js";
import {
  readDashboardCron,
  readDashboardJobDetail,
  readDashboardSystem,
  readDashboardTaskCounts,
  readDashboardTasks,
  readDashboardWorkers,
} from "./dashboard.js";

export interface DashboardRpcContext {
  database: DemoDatabase;
  queue: Queue;
  configuredWorkers: readonly string[];
  operator: DashboardOperator;
  scheduleController?: ScheduleController;
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
const enqueueTestInput = z.object({
  kind: z.enum(["success", "retry", "failure", "long-running"]),
  audit: auditSchema,
});
const setScheduleEnabledInput = z.object({
  name: z.string().trim().min(1),
  enabled: z.boolean(),
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
    cron: procedure.handler(({ context }) => readDashboardCron(context.database)),
    system: procedure.handler(({ context }) =>
      readDashboardSystem(context.database, context.queue),
    ),
    workers: procedure.handler(({ context }) =>
      readDashboardWorkers(context.database, context.configuredWorkers),
    ),
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
          input.name,
          input.enabled,
          auditWithOccurredAt(input.audit),
        );
      }),
  },
};

export type DashboardRouter = typeof dashboardRouter;

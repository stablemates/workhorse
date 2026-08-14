import { ORPCError, os } from "@orpc/server";
import type { Queue } from "@workhorse/core";
import type {
  CompleteDashboardOptions,
  DashboardDemoJobKind,
  DashboardDemoScenario,
  DashboardEventTypeFilter,
  DashboardSystemWindow,
  MaintenanceLoopCadences,
} from "../wire.js";
import { z } from "zod";
import type {
  DashboardDurabilityProjector,
  DashboardOperator,
  DashboardQueueController,
  DashboardScheduleController,
  DashboardTaskController,
  DashboardWorkerController,
  DashboardSettingsController,
} from "./types.js";
import type { DashboardDatabase } from "./sql.js";
import {
  readDashboardActivity,
  readDashboardCron,
  readDashboardEvents,
  readDashboardEventDetail,
  readDashboardJobDetail,
  readDashboardQueues,
  readDashboardSystem,
  readDashboardTaskFacets,
  readDashboardTaskCounts,
  readDashboardTasks,
  readDashboardWorkers,
  readDashboardSettings,
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
  settingsController?: DashboardSettingsController;
  projectDurability?: DashboardDurabilityProjector;
  authenticatedActor: string;
}

const procedure = os.$context<DashboardRpcContext>();

const auditSchema = z.object({
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
});
const cancellationAuditSchema = z.object({
  actor: z.string().trim().min(1),
  reason: z
    .string()
    .trim()
    .max(2_000)
    .nullable()
    .optional()
    .transform((value) => value || null),
  requestId: z.string().trim().min(1),
});

const jobDetailInput = z.object({ id: z.uuid() });
const eventDetailInput = z.object({ id: z.string().regex(/^(event|attempt):\d+$/) });
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
  groupBy: z.enum(["queue", "worker", "task", "status"]).default("task"),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  queue: z.string().trim().min(1).nullable().default(null),
  worker: z.string().trim().min(1).nullable().default(null),
});
const systemInput = z.object({
  window: z.enum(["15m", "1h", "24h"]).default("1h"),
});
const eventTypeValues = [
  "enqueued",
  "claimed",
  "succeeded",
  "failed",
  "retry_scheduled",
  "canceled",
  "promoted",
  "lease_expired",
  "execution_timed_out",
  "redriven",
  "redrive_created",
  "wait_elapsed",
  "retry",
  "deadline_exceeded",
  "timeout",
] as const;
const checkedEventTypeValues: CompleteDashboardOptions<
  DashboardEventTypeFilter,
  typeof eventTypeValues
> = eventTypeValues;
const eventType = z.enum(checkedEventTypeValues);
const demoJobKindValues = [
  "success",
  "retry",
  "durable",
  "timer",
  "failure",
  "idempotent",
  "long-running",
] as const;
const checkedDemoJobKindValues: CompleteDashboardOptions<
  DashboardDemoJobKind,
  typeof demoJobKindValues
> = demoJobKindValues;
const demoScenarioValues = [
  "order-fulfillment",
  "customer-onboarding",
  "report-publication",
] as const;
const checkedDemoScenarioValues: CompleteDashboardOptions<
  DashboardDemoScenario,
  typeof demoScenarioValues
> = demoScenarioValues;
/**
 * The event feed is bounded by a window and paged by offset, like the task listing.
 *
 * `types` is validated against the closed sets the schema itself writes, so an unbounded string
 * from a browser can never reach a filter that would otherwise scan the whole retained window for
 * a value no row can hold.
 */
const eventsInput = z.object({
  window: z.enum(["15m", "1h", "6h", "24h"]).default("1h"),
  page: z.number().int().min(1).default(1),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(50),
  kind: z.enum(["all", "event", "attempt"]).default("all"),
  queue: z.string().trim().min(1).nullable().default(null),
  jobType: z.string().trim().min(1).nullable().default(null),
  types: z.array(eventType).max(eventType.options.length).default([]),
  jobId: z.uuid().nullable().default(null),
});
const enqueueTestInput = z.object({
  kind: z.enum(checkedDemoJobKindValues),
  scenario: z.enum(checkedDemoScenarioValues).optional(),
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
const maintenanceSetting = z.enum([
  "timezone",
  "partitionPreparationIntervalMs",
  "terminalCleanupIntervalMs",
  "historyRetentionLocalTime",
]);
const retentionSetting = z.enum([
  "jobIdentityRetentionDays",
  "terminalOutcomeRetentionDays",
  "jobEventRetentionDays",
  "attemptHistoryRetentionDays",
  "scheduleOccurrenceRetentionDays",
  "statisticsRetentionDays",
  "terminalJobPruneLimit",
  "historyPartitionsPerPass",
  "defaultPartitionRowsPerPass",
  "occurrenceRowsPerPass",
  "statisticsRowsPerPass",
]);
const maintenanceDefinition = z
  .object({
    timezone: z.string().trim().min(1).optional(),
    partitionPreparationIntervalMs: z.number().int().min(60_000).max(604_800_000).optional(),
    terminalCleanupIntervalMs: z.number().int().min(1_000).max(86_400_000).optional(),
    historyRetentionLocalTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
  })
  .refine((definition) => Object.keys(definition).length > 0, "At least one setting is required");
const retentionDays = z.number().int().min(1).max(36_500).nullable();
const retentionDefinition = z
  .object({
    jobIdentityRetentionDays: retentionDays.optional(),
    terminalOutcomeRetentionDays: retentionDays.optional(),
    jobEventRetentionDays: retentionDays.optional(),
    attemptHistoryRetentionDays: retentionDays.optional(),
    scheduleOccurrenceRetentionDays: retentionDays.optional(),
    statisticsRetentionDays: retentionDays.optional(),
    terminalJobPruneLimit: z.number().int().min(1).max(100_000).optional(),
    historyPartitionsPerPass: z.number().int().min(1).max(52).optional(),
    defaultPartitionRowsPerPass: z.number().int().min(1).max(1_000_000).optional(),
    occurrenceRowsPerPass: z.number().int().min(1).max(1_000_000).optional(),
    statisticsRowsPerPass: z.number().int().min(1).max(1_000_000).optional(),
  })
  .refine((definition) => Object.keys(definition).length > 0, "At least one setting is required");
const overrideMaintenancePolicyInput = z.object({
  definition: maintenanceDefinition,
  audit: auditSchema,
});
const revertMaintenancePolicyInput = z.object({
  settings: z.array(maintenanceSetting).min(1),
  audit: auditSchema,
});
const overrideRetentionPolicyInput = z.object({
  definition: retentionDefinition,
  audit: auditSchema,
});
const revertRetentionPolicyInput = z.object({
  settings: z.array(retentionSetting).min(1),
  audit: auditSchema,
});
/** One cancellation request. Attribution is required; the operator reason is optional. */
const cancelTaskInput = z.object({
  id: z.uuid(),
  audit: cancellationAuditSchema,
});
const runTaskNowInput = z.object({
  id: z.uuid(),
  audit: auditSchema,
});

function auditWithOccurredAt<
  TAudit extends { actor: string; reason: string | null; requestId: string },
>(audit: TAudit, authenticatedActor: string): TAudit & { occurredAt: string } {
  return { ...audit, actor: authenticatedActor, occurredAt: new Date().toISOString() };
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
    events: procedure
      .input(eventsInput)
      .handler(({ context, input }) => readDashboardEvents(context.database, input)),
    eventDetail: procedure.input(eventDetailInput).handler(async ({ context, input }) => {
      const detail = await readDashboardEventDetail(context.database, input.id);
      if (!detail) throw new ORPCError("NOT_FOUND", { message: "Event not found" });
      return detail;
    }),
    cron: procedure.handler(({ context }) =>
      readDashboardCron(context.database, context.maintenanceLoops),
    ),
    queues: procedure.handler(({ context }) =>
      readDashboardQueues(context.database, context.queue),
    ),
    system: procedure
      .input(systemInput)
      .handler(({ context, input }) =>
        readDashboardSystem(context.database, context.queue, input.window as DashboardSystemWindow),
      ),
    workers: procedure.handler(({ context }) => {
      const canManageWorkers =
        context.operator.mode === "local" && Boolean(context.workerController?.setWorkerPaused);
      return readDashboardWorkers(context.database, context.configuredWorkers, canManageWorkers);
    }),
    settings: procedure.handler(({ context }) =>
      readDashboardSettings(
        context.database,
        context.queue,
        context.operator.mode === "local" && Boolean(context.settingsController),
      ),
    ),
    previewRetentionPolicy: procedure
      .input(z.object({ definition: retentionDefinition }))
      .handler(({ context, input }) => context.queue.previewRetentionPolicy(input.definition)),
    jobDetail: procedure.input(jobDetailInput).handler(async ({ context, input }) => {
      const detail = await readDashboardJobDetail(
        context.database,
        input.id,
        context.projectDurability,
        context.queue,
      );
      if (!detail) throw new ORPCError("NOT_FOUND", { message: "Task not found" });
      return detail;
    }),
    enqueueTest: procedure.input(enqueueTestInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.operator.enqueueTest) {
        throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
      }
      return context.operator.enqueueTest(
        input.kind,
        auditWithOccurredAt(input.audit, context.authenticatedActor),
        input.scenario,
      );
    }),
    setScheduleEnabled: procedure
      .input(setScheduleEnabledInput)
      .handler(async ({ context, input }) => {
        if (context.operator.mode !== "local" || !context.scheduleController?.setScheduleEnabled) {
          throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
        }
        return context.scheduleController.setScheduleEnabled(
          input.namespace,
          input.name,
          input.enabled,
          auditWithOccurredAt(input.audit, context.authenticatedActor),
        );
      }),
    setQueuePaused: procedure.input(setQueuePausedInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.queueController?.setQueuePaused) {
        throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
      }
      return context.queueController.setQueuePaused(
        input.queue,
        input.paused,
        auditWithOccurredAt(input.audit, context.authenticatedActor),
      );
    }),
    purgeQueue: procedure.input(purgeQueueInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.queueController?.purgeQueue) {
        throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
      }
      return context.queueController.purgeQueue(
        input.queue,
        auditWithOccurredAt(input.audit, context.authenticatedActor),
      );
    }),
    setWorkerPaused: procedure.input(setWorkerPausedInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.workerController?.setWorkerPaused) {
        throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
      }
      return context.workerController.setWorkerPaused(
        input.workerId,
        input.paused,
        auditWithOccurredAt(input.audit, context.authenticatedActor),
      );
    }),
    overrideMaintenancePolicy: procedure
      .input(overrideMaintenancePolicyInput)
      .handler(async ({ context, input }) => {
        if (context.operator.mode !== "local" || !context.settingsController) {
          throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
        }
        await context.settingsController.overrideMaintenancePolicy(
          input.definition,
          auditWithOccurredAt(input.audit, context.authenticatedActor),
        );
      }),
    revertMaintenancePolicy: procedure
      .input(revertMaintenancePolicyInput)
      .handler(async ({ context, input }) => {
        if (context.operator.mode !== "local" || !context.settingsController) {
          throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
        }
        await context.settingsController.revertMaintenancePolicy(
          input.settings,
          auditWithOccurredAt(input.audit, context.authenticatedActor),
        );
      }),
    overrideRetentionPolicy: procedure
      .input(overrideRetentionPolicyInput)
      .handler(async ({ context, input }) => {
        if (context.operator.mode !== "local" || !context.settingsController) {
          throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
        }
        await context.settingsController.overrideRetentionPolicy(
          input.definition,
          auditWithOccurredAt(input.audit, context.authenticatedActor),
        );
      }),
    revertRetentionPolicy: procedure
      .input(revertRetentionPolicyInput)
      .handler(async ({ context, input }) => {
        if (context.operator.mode !== "local" || !context.settingsController) {
          throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
        }
        await context.settingsController.revertRetentionPolicy(
          input.settings,
          auditWithOccurredAt(input.audit, context.authenticatedActor),
        );
      }),
    runTaskNow: procedure.input(runTaskNowInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.taskController?.runTaskNow) {
        throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
      }
      const result = await context.taskController.runTaskNow(
        input.id,
        auditWithOccurredAt(input.audit, context.authenticatedActor),
      );
      if (result.status === "not_found") {
        throw new ORPCError("NOT_FOUND", { message: "Task not found" });
      }
      return result;
    }),
    /**
     * Cancel one task. The returned status is exactly what PostgreSQL reported, so the caller can
     * distinguish an immediate cancellation from a cooperative request an active handler still has
     * to observe, and from a terminal task that was left untouched.
     */
    cancelTask: procedure.input(cancelTaskInput).handler(async ({ context, input }) => {
      if (context.operator.mode !== "local" || !context.taskController?.cancelTask) {
        throw new ORPCError("FORBIDDEN", { message: "This dashboard is read-only" });
      }
      const result = await context.taskController.cancelTask(
        input.id,
        auditWithOccurredAt(input.audit, context.authenticatedActor),
      );
      if (result.status === "not_found") {
        throw new ORPCError("NOT_FOUND", { message: "Task not found" });
      }
      return result;
    }),
  },
};

export type DashboardRouter = typeof dashboardRouter;

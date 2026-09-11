import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { expectOneRow } from "../errors.js";
import { logDebug, logInfo, recordScheduleFired, withSpan } from "../telemetry.js";
import type { Json, RetryPolicy } from "../types.js";
import { validateTaskPriority, type EnqueueContractsModule } from "./enqueue-contracts.js";
import { QueueModule, type QueueModuleContext } from "./module-context.js";

export interface ScheduledTask {
  type: string;
  payload: Json;
  queue?: string;
  /** Dispatch rank from 0 through 100. Higher values are claimed first. */
  priority?: number;
  concurrencyKey?: string;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
}

/** @deprecated Renamed to {@link ScheduledTask}. Removed in 1.0.0. */
export type ScheduleTaskDefinition = ScheduledTask;

export interface ScheduleDefinition {
  name: string;
  schedule: string;
  /** IANA timezone used to interpret cron wall-clock fields. */
  timezone?: string;
  enabled?: boolean;
  task: ScheduledTask;
}

export interface StoredSchedule {
  namespace: string;
  name: string;
  schedule: string;
  timezone: string;
  revision: bigint;
  lastOccurrenceAt: Date | null;
}

/** Owns recurring schedule persistence and occurrence firing behind the Queue facade. */
export class CronSchedulesModule extends QueueModule {
  constructor(
    context: QueueModuleContext,
    private readonly enqueueContracts: Pick<EnqueueContractsModule, "taskAcceptance">,
  ) {
    super(context);
  }

  async syncSchedules(
    namespace: string,
    definitions: readonly ScheduleDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    const scheduleInputs = await Promise.all(
      definitions.map(async (definition) => ({
        ...(await this.enqueueContracts.taskAcceptance(
          definition.task.type,
          definition.task.payload,
        )),
        name: definition.name,
        schedule: definition.schedule,
        timezone: definition.timezone ?? "UTC",
        enabled: definition.enabled ?? true,
        queue: definition.task.queue ?? this.context.defaultQueue,
        priority: validateTaskPriority(definition.task.priority),
        concurrencyKey: definition.task.concurrencyKey ?? null,
        type: definition.task.type,
        payload: definition.task.payload,
        maxAttempts: definition.task.maxAttempts ?? 25,
        retryPolicy: definition.task.retryPolicy ?? null,
      })),
    );
    await withSpan(
      "workhorse.schedule.synchronize",
      { "workhorse.schedule.definition_count": definitions.length },
      async () => {
        await this.context.database.query(SQL_STATEMENTS["sync_schedule_definitions_v1"], [
          namespace,
          JSON.stringify(scheduleInputs),
          options.prune ?? true,
        ]);
        logInfo("workhorse.schedules.synchronized", "Recurring schedules synchronized", {
          "workhorse.schedule.namespace": namespace,
          "workhorse.schedule.count": definitions.length,
        });
      },
    );
  }

  async schedules(namespaces: readonly string[]): Promise<StoredSchedule[]> {
    if (namespaces.length === 0) return [];
    const result = await this.context.database.query<{
      namespace: string;
      schedule_name: string;
      cron_expression: string;
      timezone: string;
      revision: string;
      last_occurrence_at: Date | null;
    }>(SQL_STATEMENTS["schedule_definition__cron_schedules"], [namespaces]);
    return result.rows.map((row) => ({
      namespace: row.namespace,
      name: row.schedule_name,
      schedule: row.cron_expression,
      timezone: row.timezone,
      revision: BigInt(row.revision),
      lastOccurrenceAt: row.last_occurrence_at,
    }));
  }

  async fireDueSchedules(
    namespaces: readonly string[],
    now: Date,
    catchupLimit: number,
  ): Promise<void> {
    if (namespaces.length === 0) return;
    const result = await this.context.database.query<{
      namespace: string;
      schedule_name: string;
      occurrence_at: Date | string;
      task_id: string | null;
    }>(SQL_STATEMENTS["fire_due_schedules_v1"], [namespaces, now.toISOString(), catchupLimit]);
    for (const row of result.rows) {
      if (row.task_id !== null) {
        const occurrenceAt =
          row.occurrence_at instanceof Date ? row.occurrence_at : new Date(row.occurrence_at);
        recordScheduleFired(row.namespace, row.schedule_name, occurrenceAt);
        logInfo("workhorse.schedule.fired", "Recurring schedule fired", {
          "workhorse.schedule.namespace": row.namespace,
          "workhorse.schedule.name": row.schedule_name,
          "workhorse.task.id": row.task_id,
        });
      } else {
        logDebug("workhorse.schedule.fire_replayed", "Recurring schedule occurrence replayed", {
          "workhorse.schedule.namespace": row.namespace,
          "workhorse.schedule.name": row.schedule_name,
        });
      }
    }
  }

  async fireSchedule(
    namespace: string,
    name: string,
    revision: bigint,
    occurrenceAt: Date,
  ): Promise<string | null> {
    const result = await this.context.database.query<{ task_id: string | null }>(
      SQL_STATEMENTS["fire_schedule_v1"],
      [namespace, name, revision.toString(), occurrenceAt.toISOString()],
    );
    const taskId = expectOneRow(result, "workhorse.fire_schedule_v1").task_id;
    if (taskId !== null) {
      recordScheduleFired(namespace, name, occurrenceAt);
      logInfo("workhorse.schedule.fired", "Recurring schedule fired", {
        "workhorse.schedule.namespace": namespace,
        "workhorse.schedule.name": name,
        "workhorse.task.id": taskId,
      });
    } else {
      logDebug("workhorse.schedule.fire_replayed", "Recurring schedule occurrence replayed", {
        "workhorse.schedule.namespace": namespace,
        "workhorse.schedule.name": name,
      });
    }
    return taskId;
  }
}

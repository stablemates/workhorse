import { SQL_STATEMENTS } from "./sql-catalogue.generated.js";
import { expectOneRow } from "../errors.js";
import { logDebug, logInfo, recordScheduleFired, withSpan } from "../telemetry.js";
import type { Json, RetryPolicy } from "../types.js";
import {
  encodePayload,
  maxAttemptsValue,
  serializedRequest,
  validateTaskPriority,
  checkedOptions,
  type EnqueueContractsModule,
} from "./enqueue-contracts.js";
import { QueueModule, type QueueModuleContext } from "./module-context.js";
import type { EncodedJson } from "./stored-json.js";

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

/** @deprecated Renamed to {@link ScheduledTask}. The name stays through the 1.x line. It can go at the first contract step of the 2.x line. */
export type ScheduleTaskDefinition = ScheduledTask;

export type ScheduleCatchupPolicy = "skip" | "latest" | "all";

export interface ScheduleDefinition {
  name: string;
  schedule: string;
  /** IANA timezone used to interpret cron wall-clock fields. */
  timezone?: string;
  /** What to do with occurrences missed between worker evaluations. Defaults to `skip`. */
  catchupPolicy?: ScheduleCatchupPolicy;
  enabled?: boolean;
  task: ScheduledTask;
}

/** A schedule definition with its payload encoded before the first statement of the call. */
export interface EncodedSchedule {
  readonly definition: ScheduleDefinition;
  readonly payload: EncodedJson;
}

export interface StoredSchedule {
  namespace: string;
  name: string;
  schedule: string;
  timezone: string;
  catchupPolicy: ScheduleCatchupPolicy;
  revision: bigint;
  lastOccurrenceAt: Date | null;
}

/** Owns recurring schedule persistence and occurrence firing behind the Queue facade. */
export class CronSchedulesModule extends QueueModule {
  constructor(
    context: QueueModuleContext,
    private readonly enqueueContracts: Pick<EnqueueContractsModule, "currentTaskAcceptances">,
  ) {
    super(context);
  }

  /**
   * Check the attempt limit and the priority of each definition, then encode each payload. Both
   * steps send no statement, so a refused value runs no compatibility query and no contract read.
   */
  encodeSchedules(definitions: readonly ScheduleDefinition[]): EncodedSchedule[] {
    for (const definition of definitions) {
      maxAttemptsValue(definition.task.maxAttempts);
      validateTaskPriority(definition.task.priority);
    }
    return definitions.map((definition) => {
      const payload = encodePayload(definition.task.type, definition.task.payload);
      return {
        definition: {
          ...definition,
          task: {
            ...checkedOptions(
              { ...definition.task, payload: undefined },
              `Schedule ${definition.name}`,
            ),
            payload: definition.task.payload,
          },
        },
        payload,
      };
    });
  }

  /** Store the definitions that {@link encodeSchedules} checked and encoded. */
  async syncSchedules(
    namespace: string,
    encoded: readonly EncodedSchedule[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    const definitions = encoded.map(({ definition }) => definition);
    const acceptances = await this.enqueueContracts.currentTaskAcceptances(
      encoded.map(({ definition, payload }) => ({ type: definition.task.type, payload })),
    );
    // Each input carries the payload text that passed the checks, not a second encoding.
    const scheduleInputs = definitions.map((definition, index) =>
      serializedRequest(
        {
          ...acceptances[index]!.acceptance,
          name: definition.name,
          schedule: definition.schedule,
          timezone: definition.timezone ?? "UTC",
          catchupPolicy: definition.catchupPolicy ?? "skip",
          enabled: definition.enabled ?? true,
          queue: definition.task.queue ?? this.context.defaultQueue,
          priority: validateTaskPriority(definition.task.priority),
          concurrencyKey: definition.task.concurrencyKey ?? null,
          type: definition.task.type,
          maxAttempts: maxAttemptsValue(definition.task.maxAttempts),
          retryPolicy: definition.task.retryPolicy ?? null,
        },
        acceptances[index]!.serializedPayload,
      ),
    );
    await withSpan(
      "workhorse.schedule.synchronize",
      { "workhorse.schedule.definition_count": definitions.length },
      async () => {
        await this.context.database.query(SQL_STATEMENTS["sync_schedule_definitions_v2"], [
          namespace,
          `[${scheduleInputs.join(",")}]`,
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
      catchup_policy: ScheduleCatchupPolicy;
      revision: string;
      last_occurrence_at: Date | null;
    }>(SQL_STATEMENTS["schedule_definition__cron_schedules"], [namespaces]);
    return result.rows.map((row) => ({
      namespace: row.namespace,
      name: row.schedule_name,
      schedule: row.cron_expression,
      timezone: row.timezone,
      catchupPolicy: row.catchup_policy,
      revision: BigInt(row.revision),
      lastOccurrenceAt: row.last_occurrence_at,
    }));
  }

  async fireDueSchedules(
    namespaces: readonly string[],
    now: Date | null,
    catchupLimit: number,
    evaluationWindowMs: number,
  ): Promise<void> {
    if (namespaces.length === 0) return;
    const result = await this.context.database.query<{
      namespace: string;
      schedule_name: string;
      occurrence_at: Date | string;
      task_id: string | null;
    }>(SQL_STATEMENTS["fire_due_schedules_v2"], [
      namespaces,
      now === null ? null : now.toISOString(),
      catchupLimit,
      evaluationWindowMs,
    ]);
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

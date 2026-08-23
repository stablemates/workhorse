import { expectOneRow } from "../errors.js";
import { logDebug, logInfo, recordScheduleFired, withSpan } from "../telemetry.js";
import type { Json, RetryPolicy } from "../types.js";
import { validateJobPriority, type EnqueueContractsModule } from "./enqueue-contracts.js";
import { QueueModule, type QueueModuleContext } from "./module-context.js";

export interface ScheduleJobDefinition {
  type: string;
  payload: Json;
  queue?: string;
  /** Dispatch rank from 0 through 100. Higher values are claimed first. */
  priority?: number;
  concurrencyKey?: string;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
}

export interface ScheduleDefinition {
  name: string;
  schedule: string;
  /** IANA timezone used to interpret cron wall-clock fields. */
  timezone?: string;
  enabled?: boolean;
  job: ScheduleJobDefinition;
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
    private readonly enqueueContracts: Pick<EnqueueContractsModule, "jobAcceptance">,
  ) {
    super(context);
  }

  async syncSchedules(
    namespace: string,
    definitions: readonly ScheduleDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    const scheduleInputs = definitions.map((definition) => ({
      ...this.enqueueContracts.jobAcceptance(definition.job.type, definition.job.payload),
      name: definition.name,
      schedule: definition.schedule,
      timezone: definition.timezone ?? "UTC",
      enabled: definition.enabled ?? true,
      queue: definition.job.queue ?? this.context.defaultQueue,
      priority: validateJobPriority(definition.job.priority),
      concurrencyKey: definition.job.concurrencyKey ?? null,
      type: definition.job.type,
      payload: definition.job.payload,
      maxAttempts: definition.job.maxAttempts ?? 25,
      retryPolicy: definition.job.retryPolicy ?? null,
    }));
    await withSpan(
      "workhorse.schedule.synchronize",
      { "workhorse.schedule.definition_count": definitions.length },
      async () => {
        await this.context.database.query(
          "SELECT workhorse.sync_schedule_definitions_v1($1::text, $2::jsonb, $3::boolean)",
          [namespace, JSON.stringify(scheduleInputs), options.prune ?? true],
        );
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
    }>(
      `SELECT definition.namespace, definition.schedule_name, definition.cron_expression,
              definition.timezone,
              definition.revision::text,
              max(occurrence.occurrence_at) AS last_occurrence_at
         FROM workhorse.schedule_definition definition
         LEFT JOIN workhorse.schedule_occurrence occurrence
           ON occurrence.namespace = definition.namespace
          AND occurrence.schedule_name = definition.schedule_name
        WHERE definition.enabled AND definition.namespace = ANY($1::text[])
        GROUP BY definition.namespace, definition.schedule_name, definition.timezone
        ORDER BY definition.namespace, definition.schedule_name`,
      [namespaces],
    );
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
      job_id: string | null;
    }>(
      `SELECT namespace, schedule_name, occurrence_at, job_id
         FROM workhorse.fire_due_schedules_v1($1::text[], $2::timestamptz, $3::integer)`,
      [namespaces, now.toISOString(), catchupLimit],
    );
    for (const row of result.rows) {
      if (row.job_id !== null) {
        const occurrenceAt =
          row.occurrence_at instanceof Date ? row.occurrence_at : new Date(row.occurrence_at);
        recordScheduleFired(row.namespace, row.schedule_name, occurrenceAt);
        logInfo("workhorse.schedule.fired", "Recurring schedule fired", {
          "workhorse.schedule.namespace": row.namespace,
          "workhorse.schedule.name": row.schedule_name,
          "workhorse.job.id": row.job_id,
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
    const result = await this.context.database.query<{ job_id: string | null }>(
      "SELECT workhorse.fire_schedule_v1($1::text, $2::text, $3::bigint, $4::timestamptz) AS job_id",
      [namespace, name, revision.toString(), occurrenceAt.toISOString()],
    );
    const jobId = expectOneRow(result, "workhorse.fire_schedule_v1").job_id;
    if (jobId !== null) {
      recordScheduleFired(namespace, name, occurrenceAt);
      logInfo("workhorse.schedule.fired", "Recurring schedule fired", {
        "workhorse.schedule.namespace": namespace,
        "workhorse.schedule.name": name,
        "workhorse.job.id": jobId,
      });
    } else {
      logDebug("workhorse.schedule.fire_replayed", "Recurring schedule occurrence replayed", {
        "workhorse.schedule.namespace": namespace,
        "workhorse.schedule.name": name,
      });
    }
    return jobId;
  }
}

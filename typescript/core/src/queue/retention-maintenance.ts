import { expectOneRow } from "../errors.js";
import { logInfo, withSpan } from "../telemetry.js";
import type {
  Json,
  MaintenancePolicy,
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  PolicyValueProvenance,
  RetentionPolicy,
  RetentionPolicyDefinition,
  RetentionPolicyImpact,
  RetentionPolicySetting,
} from "../types.js";
import { recordRecoveryTelemetry } from "./claim-lease-fence.js";
import { QueueModule } from "./module-context.js";

export type MaintenancePhase =
  | "promote"
  | "recover"
  | "history_partitions"
  | "stat_rollup"
  | "stat_retention"
  | "event_retention"
  | "attempt_retention"
  | "schedule_occurrences"
  | "enqueue_idempotency"
  | "terminal_jobs";

export interface MaintenancePhaseResult {
  phase: MaintenancePhase;
  rowsAffected: number;
  durationMs: number;
  skippedLock: boolean;
  error: Json;
}

type MaintenancePhaseRow = {
  phase: MaintenancePhase;
  rows_affected: number;
  duration_ms: number;
  skipped_lock: boolean;
  error: Json;
  expired_leases: number;
  retried: number;
  retry_dimensions: Array<{ queue: string; type: string }>;
};

export type RetentionPolicyRow = {
  job_identity_retention_days: number | null;
  terminal_outcome_retention_days: number | null;
  job_event_retention_days: number | null;
  attempt_history_retention_days: number | null;
  schedule_occurrence_retention_days: number | null;
  statistics_retention_days: number | null;
  terminal_job_prune_limit: number;
  history_partitions_per_pass: number;
  default_partition_rows_per_pass: number;
  occurrence_rows_per_pass: number;
  statistics_rows_per_pass: number;
  application_job_identity_retention_days: number | null;
  application_terminal_outcome_retention_days: number | null;
  application_job_event_retention_days: number | null;
  application_attempt_history_retention_days: number | null;
  application_schedule_occurrence_retention_days: number | null;
  application_statistics_retention_days: number | null;
  application_terminal_job_prune_limit: number;
  application_history_partitions_per_pass: number;
  application_default_partition_rows_per_pass: number;
  application_occurrence_rows_per_pass: number;
  application_statistics_rows_per_pass: number;
  operator_overrides: string[];
  updated_at: Date;
};

type MaintenancePolicyRow = {
  timezone: string;
  partition_preparation_interval_ms: number;
  terminal_cleanup_interval_ms: number;
  history_retention_local_time: string;
  application_timezone: string;
  application_partition_preparation_interval_ms: number;
  application_terminal_cleanup_interval_ms: number;
  application_history_retention_local_time: string;
  operator_overrides: string[];
  updated_at: Date;
};

const RETENTION_POLICY_COLUMNS: Readonly<Record<RetentionPolicySetting, string>> = {
  jobIdentityRetentionDays: "job_identity_retention_days",
  terminalOutcomeRetentionDays: "terminal_outcome_retention_days",
  jobEventRetentionDays: "job_event_retention_days",
  attemptHistoryRetentionDays: "attempt_history_retention_days",
  scheduleOccurrenceRetentionDays: "schedule_occurrence_retention_days",
  statisticsRetentionDays: "statistics_retention_days",
  terminalJobPruneLimit: "terminal_job_prune_limit",
  historyPartitionsPerPass: "history_partitions_per_pass",
  defaultPartitionRowsPerPass: "default_partition_rows_per_pass",
  occurrenceRowsPerPass: "occurrence_rows_per_pass",
  statisticsRowsPerPass: "statistics_rows_per_pass",
};

const MAINTENANCE_POLICY_COLUMNS: Readonly<Record<MaintenancePolicySetting, string>> = {
  timezone: "timezone",
  partitionPreparationIntervalMs: "partition_preparation_interval_ms",
  terminalCleanupIntervalMs: "terminal_cleanup_interval_ms",
  historyRetentionLocalTime: "history_retention_local_time",
};

function policyProvenance<TSetting extends string>(
  row: { operator_overrides: string[] },
  columns: Readonly<Record<TSetting, string>>,
  read: (value: unknown, setting: TSetting) => unknown = (value) => value,
): Record<TSetting, PolicyValueProvenance<unknown>> {
  const overrides = new Set(row.operator_overrides);
  const values = row as unknown as Record<string, unknown>;
  const entries = Object.entries(columns) as [TSetting, string][];
  return Object.fromEntries(
    entries.map(([setting, column]) => [
      setting,
      {
        source: overrides.has(column) ? "operator" : "application",
        applicationDefault: read(values[`application_${column}`], setting),
      },
    ]),
  ) as Record<TSetting, PolicyValueProvenance<unknown>>;
}

function policyColumnNames<TSetting extends string>(
  settings: readonly TSetting[],
  columns: Readonly<Record<TSetting, string>>,
): string[] {
  return settings.map((setting) => columns[setting]);
}

export function retentionPolicy(row: RetentionPolicyRow): RetentionPolicy {
  return {
    jobIdentityRetentionDays: row.job_identity_retention_days,
    terminalOutcomeRetentionDays: row.terminal_outcome_retention_days,
    jobEventRetentionDays: row.job_event_retention_days,
    attemptHistoryRetentionDays: row.attempt_history_retention_days,
    scheduleOccurrenceRetentionDays: row.schedule_occurrence_retention_days,
    statisticsRetentionDays: row.statistics_retention_days,
    terminalJobPruneLimit: row.terminal_job_prune_limit,
    historyPartitionsPerPass: row.history_partitions_per_pass,
    defaultPartitionRowsPerPass: row.default_partition_rows_per_pass,
    occurrenceRowsPerPass: row.occurrence_rows_per_pass,
    statisticsRowsPerPass: row.statistics_rows_per_pass,
    provenance: policyProvenance(row, RETENTION_POLICY_COLUMNS) as RetentionPolicy["provenance"],
    updatedAt: new Date(row.updated_at),
  };
}

function localMaintenanceTime(value: string): string {
  return value.slice(0, 5);
}

function maintenancePolicy(row: MaintenancePolicyRow): MaintenancePolicy {
  const read = (value: unknown, setting: MaintenancePolicySetting): unknown =>
    setting === "historyRetentionLocalTime" ? localMaintenanceTime(value as string) : value;
  return {
    timezone: row.timezone,
    partitionPreparationIntervalMs: row.partition_preparation_interval_ms,
    terminalCleanupIntervalMs: row.terminal_cleanup_interval_ms,
    historyRetentionLocalTime: localMaintenanceTime(row.history_retention_local_time),
    provenance: policyProvenance(
      row,
      MAINTENANCE_POLICY_COLUMNS,
      read,
    ) as MaintenancePolicy["provenance"],
    updatedAt: row.updated_at,
  };
}

function maintenancePhaseResult(row: MaintenancePhaseRow): MaintenancePhaseResult {
  return {
    phase: row.phase,
    rowsAffected: row.rows_affected,
    durationMs: row.duration_ms,
    skippedLock: row.skipped_lock,
    error: row.error,
  };
}

/** Owns retention policy and maintenance operations behind the Queue facade. */
export class RetentionMaintenanceModule extends QueueModule {
  async tick(
    options: { promoteLimit?: number; recoverLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("tick", () =>
      withSpan("workhorse.recovery", {}, async (span) => {
        const result = await this.context.database.query<MaintenancePhaseRow>(
          "SELECT * FROM workhorse.tick_v1($1::integer, $2::integer)",
          [options.promoteLimit ?? 1_000, options.recoverLimit ?? 1_000],
        );
        const recovery = result.rows.find((row) => row.phase === "recover");
        if (recovery !== undefined) {
          span.setAttribute("workhorse.recovery.skipped", recovery.skipped_lock);
          if (!recovery.skipped_lock && recovery.error === null) {
            recordRecoveryTelemetry(span, recovery);
          }
        }
        return result.rows.map(maintenancePhaseResult);
      }),
    );
  }

  async prepareHistoryPartitions(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("history_partitions", async () => {
      const result = await this.context.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.prepare_history_partitions_v1($1::boolean, $2::timestamptz)",
        [options.force ?? false, options.now ?? new Date()],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  async rollupStatistics(
    options: { now?: Date; maxBuckets?: number; recomputeBuckets?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("statistics_rollup", async () => {
      const result = await this.context.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.rollup_stats_v1($1::timestamptz, $2::integer, $3::integer)",
        [options.now ?? new Date(), options.maxBuckets ?? 240, options.recomputeBuckets ?? 2],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  async retainHistory(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("history_retention", async () => {
      const result = await this.context.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.retain_history_v1($1::boolean, $2::timestamptz)",
        [options.force ?? false, options.now ?? new Date()],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  async pruneTerminalStorage(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.maintenanceSpan("terminal_storage", async () => {
      const result = await this.context.database.query<MaintenancePhaseRow>(
        "SELECT * FROM workhorse.prune_terminal_storage_v1($1::boolean, $2::timestamptz)",
        [options.force ?? false, options.now ?? new Date()],
      );
      return result.rows.map(maintenancePhaseResult);
    });
  }

  async syncRetentionPolicy(
    definition: RetentionPolicyDefinition,
    options: { force?: boolean } = {},
  ): Promise<RetentionPolicy> {
    const result = await this.context.database.query<RetentionPolicyRow>(
      `SELECT (policy).* FROM workhorse.sync_retention_policy_v1(
         $1::integer, $2::integer, $3::integer, $4::integer, $5::integer,
         $6::integer, $7::integer, $8::integer, $9::integer, $10::integer,
         $11::integer, $12::boolean
       ) policy`,
      [
        definition.jobIdentityRetentionDays,
        definition.terminalOutcomeRetentionDays,
        definition.jobEventRetentionDays,
        definition.attemptHistoryRetentionDays,
        definition.scheduleOccurrenceRetentionDays,
        definition.statisticsRetentionDays,
        definition.terminalJobPruneLimit ?? null,
        definition.historyPartitionsPerPass ?? null,
        definition.defaultPartitionRowsPerPass ?? null,
        definition.occurrenceRowsPerPass ?? null,
        definition.statisticsRowsPerPass ?? null,
        options.force ?? false,
      ],
    );
    const policy = retentionPolicy(expectOneRow(result, "workhorse.sync_retention_policy_v1"));
    logInfo("workhorse.retention_policy.synchronized", "Retention policy synchronized");
    return policy;
  }

  async overrideRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
  ): Promise<RetentionPolicy> {
    const overrides = Object.fromEntries(
      Object.entries(definition)
        .filter((entry): entry is [RetentionPolicySetting, number | null] => entry[1] !== undefined)
        .map(([setting, value]) => [RETENTION_POLICY_COLUMNS[setting], value]),
    );
    const result = await this.context.database.query<RetentionPolicyRow>(
      "SELECT (policy).* FROM workhorse.override_retention_policy_v1($1::jsonb) policy",
      [JSON.stringify(overrides)],
    );
    return retentionPolicy(expectOneRow(result, "workhorse.override_retention_policy_v1"));
  }

  async revertRetentionPolicy(
    settings: readonly RetentionPolicySetting[],
  ): Promise<RetentionPolicy> {
    const result = await this.context.database.query<RetentionPolicyRow>(
      "SELECT (policy).* FROM workhorse.revert_retention_policy_v1($1::text[]) policy",
      [policyColumnNames(settings, RETENTION_POLICY_COLUMNS)],
    );
    return retentionPolicy(expectOneRow(result, "workhorse.revert_retention_policy_v1"));
  }

  async previewRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
  ): Promise<RetentionPolicyImpact> {
    const current = await this.getRetentionPolicy();
    const candidate = { ...current, ...definition };
    const result = await this.context.database.query<{
      terminal_jobs: number;
      job_events: number;
      attempt_history: number;
      schedule_occurrences: number;
      statistics: number;
    }>(
      `SELECT
        (SELECT count(*)::integer FROM (
          SELECT 1 FROM workhorse.job job
          JOIN workhorse.job_outcome outcome ON outcome.job_id = job.id
          WHERE $1::integer IS NOT NULL AND $2::integer IS NOT NULL
            AND job.created_at < clock_timestamp() - make_interval(days => $1)
            AND outcome.finished_at < clock_timestamp() - make_interval(days => $2)
          LIMIT 10001
        ) rows) AS terminal_jobs,
        (SELECT count(*)::integer FROM (
          SELECT 1 FROM workhorse.job_event
          WHERE $3::integer IS NOT NULL
            AND occurred_at < clock_timestamp() - make_interval(days => $3)
          LIMIT 10001
        ) rows) AS job_events,
        (SELECT count(*)::integer FROM (
          SELECT 1 FROM workhorse.attempt_history
          WHERE $4::integer IS NOT NULL
            AND occurred_at < clock_timestamp() - make_interval(days => $4)
          LIMIT 10001
        ) rows) AS attempt_history,
        (SELECT count(*)::integer FROM (
          SELECT 1 FROM workhorse.schedule_occurrence
          WHERE $5::integer IS NOT NULL
            AND occurrence_at < clock_timestamp() - make_interval(days => $5)
          LIMIT 10001
        ) rows) AS schedule_occurrences,
        (SELECT count(*)::integer FROM (
          SELECT 1 FROM workhorse.job_stat_bucket
          WHERE $6::integer IS NOT NULL
            AND bucket_start < clock_timestamp() - make_interval(days => $6)
          LIMIT 10001
        ) rows) AS statistics`,
      [
        candidate.jobIdentityRetentionDays,
        candidate.terminalOutcomeRetentionDays,
        candidate.jobEventRetentionDays,
        candidate.attemptHistoryRetentionDays,
        candidate.scheduleOccurrenceRetentionDays,
        candidate.statisticsRetentionDays,
      ],
    );
    const row = expectOneRow(result, "the retention policy preview");
    const sampled = {
      terminalJobs: Number(row.terminal_jobs),
      jobEvents: Number(row.job_events),
      attemptHistory: Number(row.attempt_history),
      scheduleOccurrences: Number(row.schedule_occurrences),
      statistics: Number(row.statistics),
    };
    return {
      eligible: Object.fromEntries(
        Object.entries(sampled).map(([key, value]) => [key, Math.min(value, 10_000)]),
      ) as RetentionPolicyImpact["eligible"],
      capped: Object.fromEntries(
        Object.entries(sampled).map(([key, value]) => [key, value > 10_000]),
      ) as RetentionPolicyImpact["capped"],
    };
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    const result = await this.context.database.query<RetentionPolicyRow>(
      "SELECT (policy).* FROM workhorse.get_retention_policy_v1() policy",
    );
    return retentionPolicy(expectOneRow(result, "workhorse.get_retention_policy_v1"));
  }

  async syncMaintenancePolicy(
    definition: MaintenancePolicyDefinition,
    options: { force?: boolean } = {},
  ): Promise<MaintenancePolicy> {
    this.validateMaintenanceTime(definition.historyRetentionLocalTime);
    const result = await this.context.database.query<MaintenancePolicyRow>(
      `SELECT (policy).* FROM workhorse.sync_maintenance_policy_v1(
         $1::text, $2::integer, $3::integer, $4::time, $5::boolean
       ) policy`,
      [
        definition.timezone,
        definition.partitionPreparationIntervalMs ?? null,
        definition.terminalCleanupIntervalMs ?? null,
        definition.historyRetentionLocalTime ?? null,
        options.force ?? false,
      ],
    );
    const policy = maintenancePolicy(expectOneRow(result, "workhorse.sync_maintenance_policy_v1"));
    logInfo("workhorse.maintenance_policy.synchronized", "Maintenance policy synchronized", {
      "workhorse.maintenance.timezone": policy.timezone,
    });
    return policy;
  }

  async overrideMaintenancePolicy(
    definition: Partial<MaintenancePolicyDefinition>,
  ): Promise<MaintenancePolicy> {
    this.validateMaintenanceTime(definition.historyRetentionLocalTime);
    const result = await this.context.database.query<MaintenancePolicyRow>(
      `SELECT (policy).* FROM workhorse.override_maintenance_policy_v1(
         $1::text, $2::integer, $3::integer, $4::time
       ) policy`,
      [
        definition.timezone ?? null,
        definition.partitionPreparationIntervalMs ?? null,
        definition.terminalCleanupIntervalMs ?? null,
        definition.historyRetentionLocalTime ?? null,
      ],
    );
    return maintenancePolicy(expectOneRow(result, "workhorse.override_maintenance_policy_v1"));
  }

  async revertMaintenancePolicy(
    settings: readonly MaintenancePolicySetting[],
  ): Promise<MaintenancePolicy> {
    const result = await this.context.database.query<MaintenancePolicyRow>(
      "SELECT (policy).* FROM workhorse.revert_maintenance_policy_v1($1::text[]) policy",
      [policyColumnNames(settings, MAINTENANCE_POLICY_COLUMNS)],
    );
    return maintenancePolicy(expectOneRow(result, "workhorse.revert_maintenance_policy_v1"));
  }

  async getMaintenancePolicy(): Promise<MaintenancePolicy> {
    const result = await this.context.database.query<MaintenancePolicyRow>(
      "SELECT (policy).* FROM workhorse.get_maintenance_policy_v1() policy",
    );
    return maintenancePolicy(expectOneRow(result, "workhorse.get_maintenance_policy_v1"));
  }

  private validateMaintenanceTime(value: string | undefined): void {
    if (value !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new RangeError("historyRetentionLocalTime must use 24-hour HH:mm form");
    }
  }

  private maintenanceSpan(
    operation: string,
    run: () => Promise<MaintenancePhaseResult[]>,
  ): Promise<MaintenancePhaseResult[]> {
    return withSpan(
      "workhorse.maintenance",
      { "workhorse.maintenance.operation": operation },
      async (span) => {
        const results = await run();
        span.setAttribute(
          "workhorse.maintenance.rows_affected",
          results.reduce((total, result) => total + result.rowsAffected, 0),
        );
        for (const result of results) {
          const attributes = {
            "workhorse.maintenance.operation": operation,
            "workhorse.maintenance.phase": result.phase,
            "workhorse.maintenance.rows_affected": result.rowsAffected,
            "workhorse.maintenance.skipped_lock": result.skippedLock,
          };
          if (result.rowsAffected === 0 && result.error === null) continue;
          logInfo("workhorse.maintenance.completed", "Maintenance phase completed", attributes);
        }
        return results;
      },
    );
  }
}

/**
 * The shape one soak observation records, shared by the collector and the report builder.
 *
 * An observation is a snapshot, not a log. PostgreSQL keeps no history of partition creation or of
 * a retention pass, and both raw history and daily statistics are pruned after their retention
 * window, so a single read at the end of a 30-day soak cannot see the 30 days behind it. A series
 * of overlapping snapshots can: a partition that appears between two observations was rolled over,
 * one that disappears was retired by retention, and a day's statistics are immutable once the day
 * closes, so whichever observation saw them is authoritative.
 */

/** Bumped when a field changes meaning. The report refuses a format it was not written against. */
export const OBSERVATION_FORMAT = 1;

/** The two daily-partitioned history parents. */
export const HISTORY_PARENTS = ["task_event", "attempt_history"] as const;

export type HistoryParent = (typeof HISTORY_PARENTS)[number];

/** The append-only migration ledger. Its baseline row dates the installation. */
export interface MigrationRecord {
  version: number;
  description: string;
  appliedAt: string;
}

export interface InstallationFacts {
  /** The single `workhorse.schema_version` row, or null when it is absent or ambiguous. */
  schemaVersion: number | null;
  /** Every SQL protocol version the installed schema serves. */
  protocolVersions: number[];
  /** Every row of `workhorse.schema_migration`, oldest first. */
  migrations: MigrationRecord[];
}

export interface ParentPartitions {
  parent: HistoryParent;
  /** Local dates, `YYYY-MM-DD`, of every live daily partition of this parent. */
  days: string[];
  /** Rows sitting in the parent's default partition, which retention prunes row by row. */
  defaultRows: number;
}

export interface PartitionFacts {
  parents: ParentPartitions[];
  /** The earliest day held by any live daily partition. */
  oldestSurvivingDay: string | null;
  /** Whole days between `oldestSurvivingDay` and the observation. */
  oldestSurvivingAgeDays: number | null;
}

export interface RetentionFacts {
  taskEventRetentionDays: number | null;
  attemptHistoryRetentionDays: number | null;
  statisticsRetentionDays: number | null;
  historyPartitionsPerPass: number;
  /** The cutoff the last completed retention pass reached. It only ever moves forward. */
  historyRetainedBefore: string | null;
  retentionLastCompletedAt: string | null;
  retentionLastCompletedLocalDate: string | null;
  partitionsLastCompletedAt: string | null;
}

/** One closed day of the daily statistics tier, summed over every queue and task type. */
export interface ThroughputDay {
  day: string;
  enqueued: number;
  taskSucceeded: number;
  taskFailed: number;
  taskCanceled: number;
  attemptSucceeded: number;
  attemptFailed: number;
  attemptRetry: number;
  attemptLeaseExpired: number;
  attemptCanceled: number;
  attemptOther: number;
}

export interface WorkerFacts {
  workerId: string;
  hostname: string;
  queueNames: string[];
  activeSlots: number;
  startedAt: string;
  lastHeartbeatAt: string;
}

/**
 * What the database can still prove about one ungraceful kill.
 *
 * A `SIGKILL`ed worker acknowledges nothing, so its held tasks are recovered when their leases
 * expire. Every one of them must end up somewhere — terminal, or live and moving — and none may
 * have succeeded twice.
 */
export interface KillRecovery {
  workerId: string;
  killedAt: string;
  windowEnd: string;
  /** Attempts the killed worker lost to lease expiry inside the window. */
  leaseExpiredAttempts: number;
  /** Distinct tasks behind those attempts. This is the enqueued side of the reconciliation. */
  affectedTasks: number;
  /** Of the affected tasks, those that reached a terminal outcome. */
  tasksSettled: number;
  /** Of the affected tasks, those still live in the runtime. */
  tasksLive: number;
  /** Of the affected tasks, those in neither relation. A lost task. Must be zero. */
  tasksLost: number;
  /** Affected tasks holding more than one succeeded attempt. A duplicate. Must be zero. */
  tasksSucceededMoreThanOnce: number;
}

export interface SoakObservation {
  format: typeof OBSERVATION_FORMAT;
  /** The database's own clock, not the collector host's. */
  observedAt: string;
  database: { name: string; serverVersion: string };
  installation: InstallationFacts;
  partitions: PartitionFacts;
  retention: RetentionFacts;
  /** Every closed day the daily statistics tier still holds, oldest first. */
  throughput: ThroughputDay[];
  /** Live tasks by runtime state. Terminal work is counted by the statistics tier instead. */
  backlog: Record<string, number>;
  workers: WorkerFacts[];
  /** The `workhorse.queue_health_v1()` document, verbatim. */
  queueHealth: unknown;
  /** Present only when the collector was asked to reconcile a kill. */
  killRecovery?: KillRecovery;
}

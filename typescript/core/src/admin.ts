import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
import type {
  BulkRedriveOptions,
  BulkRedrivePage,
  ChildLineage,
  ConcurrencyPolicy,
  DeadLetterFilter,
  DeadLetterPage,
  DeadLetterQuery,
  DependencyLineage,
  JobCheckpoint,
  JobListPage,
  JobListQuery,
  JobProgress,
  JobSnapshot,
  JobTimelinePage,
  JobTimelineQuery,
  JobWait,
  Json,
  MaintenancePolicy,
  Queryable,
  QueueHealth,
  QueueOptions,
  RedriveLineage,
  RedriveResult,
  RetentionPolicy,
  RetentionPolicyDefinition,
  RetentionPolicyImpact,
  WorkerPauseResult,
  WorkerRegistryEntry,
} from "./types.js";
import { databaseErrorCode, databaseErrorDetails, expectOneRow, WorkhorseError } from "./errors.js";
import { MAX_JOB_QUERY_PAGE_SIZE, MAX_REDRIVE_BATCH_SIZE } from "./types.js";
import type { QueueMetricSnapshot } from "./telemetry.js";
import { logInfo } from "./telemetry.js";
import { createQueueModuleContext } from "./queue/module-context.js";
import { createQueueModules, type QueueModules } from "./queue/modules.js";
import { validateQueueOptions } from "./queue/enqueue-contracts.js";
import type { ExternalWaitListOptions } from "./queue/external-waits.js";
import type { HumanWaitPage } from "./queue/human-waits.js";
import type { SignalWaitPage } from "./queue/signals.js";
import type { StoredSchedule } from "./queue/cron-schedules.js";
import { nullableRowTimestamp } from "./queue/row-mapping.js";
import { concurrencyPolicy, type ConcurrencyPolicyRow } from "./queue/operator-reads.js";

export type RunTaskNowStatus =
  | "released"
  | "already_ready"
  | "not_scheduled"
  | "waiting"
  | "not_found";

export interface RunTaskNowResult {
  status: RunTaskNowStatus;
  jobId: string;
  state: string | null;
  runAt: Date | null;
}

/** Required attribution and replay identity for an administrative mutation. */
export interface AdminAudit {
  actor: string;
  reason: string;
  requestId: string;
}

export interface PurgeIdempotencyConflictDetails {
  queue: string;
  requestIdPreview: string;
  requestIdDigest: string;
  requestIdLength: number;
  conflictingFields: string[];
  storedRequestDigest: string;
  rejectedRequestDigest: string;
}

export class PurgeIdempotencyConflictError extends WorkhorseError {
  constructor(readonly details: PurgeIdempotencyConflictDetails) {
    super(
      `Queue purge conflict for ${details.queue} and request ${details.requestIdPreview} (${details.requestIdDigest}); fields: ${details.conflictingFields.join(", ")}`,
    );
    this.name = "PurgeIdempotencyConflictError";
  }
}

function validateAdminAudit(audit: AdminAudit): void {
  if (audit.actor.length === 0 || audit.actor.length > 200) {
    throw new RangeError("actor must contain between 1 and 200 characters");
  }
  if (audit.reason.length === 0 || audit.reason.length > 2_000) {
    throw new RangeError("reason must contain between 1 and 2000 characters");
  }
  const requestBytes = new TextEncoder().encode(audit.requestId).byteLength;
  if (requestBytes === 0 || requestBytes > 512) {
    throw new RangeError("requestId must contain between 1 and 512 UTF-8 bytes");
  }
}

function purgeConflict(error: unknown): PurgeIdempotencyConflictError | null {
  if (databaseErrorCode(error) !== "P1006") return null;
  for (const detail of databaseErrorDetails(error)) {
    try {
      const parsed = JSON.parse(detail) as PurgeIdempotencyConflictDetails;
      if (
        typeof parsed.queue === "string" &&
        typeof parsed.requestIdPreview === "string" &&
        typeof parsed.requestIdDigest === "string" &&
        typeof parsed.requestIdLength === "number" &&
        Array.isArray(parsed.conflictingFields) &&
        parsed.conflictingFields.every((field) => typeof field === "string") &&
        typeof parsed.storedRequestDigest === "string" &&
        typeof parsed.rejectedRequestDigest === "string"
      ) {
        return new PurgeIdempotencyConflictError(parsed);
      }
    } catch {
      // PostgreSQL or an adapter supplied unrelated DETAIL text; try the next wrapper.
    }
  }
  return new PurgeIdempotencyConflictError({
    queue: "unknown",
    requestIdPreview: "unknown",
    requestIdDigest: "unknown",
    requestIdLength: 0,
    conflictingFields: [],
    storedRequestDigest: "unknown",
    rejectedRequestDigest: "unknown",
  });
}

/**
 * Public operator client over the versioned PostgreSQL protocol.
 *
 * Application code uses {@link import("./queue.js").Queue} to produce and control its own work.
 * Operational tooling uses Admin so privileged reads and fleet-wide controls have one contract
 * across the SDKs, CLI, and dashboard.
 */
export class Admin {
  private readonly modules: QueueModules;

  constructor(
    private readonly database: Queryable,
    readonly defaultQueue = "default",
    options: QueueOptions = {},
  ) {
    this.modules = createQueueModules(
      createQueueModuleContext(database, defaultQueue, validateQueueOptions(options)),
    );
  }

  listJobs(query: JobListQuery = {}): Promise<JobListPage> {
    return this.modules.operatorReads.listJobs(query);
  }

  getJob<TResult extends Json = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    return this.modules.operatorReads.getJob<TResult>(id);
  }

  getJobTimeline(jobId: string, query: JobTimelineQuery = {}): Promise<JobTimelinePage> {
    return this.modules.operatorReads.getJobTimeline(jobId, query);
  }

  listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterPage> {
    return this.modules.operatorReads.listDeadLetters(query);
  }

  redrive(sourceJobId: string, audit: AdminAudit): Promise<RedriveResult> {
    validateAdminAudit(audit);
    return this.modules.operatorReads.redrive(sourceJobId, {
      requestedBy: audit.actor,
      reason: audit.reason,
      requestId: audit.requestId,
    });
  }

  redriveMany(
    filter: DeadLetterFilter,
    audit: AdminAudit,
    options: BulkRedriveOptions = {},
  ): Promise<BulkRedrivePage> {
    validateAdminAudit(audit);
    return this.modules.operatorReads.redriveMany(
      filter,
      { requestedBy: audit.actor, reason: audit.reason, requestId: audit.requestId },
      options,
    );
  }

  getRedriveLineage(jobId: string, limit = MAX_REDRIVE_BATCH_SIZE): Promise<RedriveLineage> {
    return this.modules.operatorReads.getRedriveLineage(jobId, limit);
  }

  getDependencyLineage(jobId: string, limit = MAX_JOB_QUERY_PAGE_SIZE): Promise<DependencyLineage> {
    return this.modules.operatorReads.getDependencyLineage(jobId, limit);
  }

  getChildLineage(jobId: string, limit = MAX_JOB_QUERY_PAGE_SIZE): Promise<ChildLineage> {
    return this.modules.operatorReads.getChildLineage(jobId, limit);
  }

  getCheckpoint<TValue extends Json = Json>(
    jobId: string,
    name: string,
  ): Promise<JobCheckpoint<TValue> | null> {
    return this.modules.checkpointsProgressWaits.getCheckpoint<TValue>(jobId, name);
  }

  listCheckpoints<TValue extends Json = Json>(jobId: string): Promise<JobCheckpoint<TValue>[]> {
    return this.modules.checkpointsProgressWaits.listCheckpoints<TValue>(jobId);
  }

  getProgress<TValue extends Json = Json>(jobId: string): Promise<JobProgress<TValue> | null> {
    return this.modules.checkpointsProgressWaits.getProgress<TValue>(jobId);
  }

  getWait(jobId: string, name: string): Promise<JobWait | null> {
    return this.modules.checkpointsProgressWaits.getWait(jobId, name);
  }

  listWaits(jobId: string): Promise<JobWait[]> {
    return this.modules.checkpointsProgressWaits.listWaits(jobId);
  }

  listSignalWaits(options: ExternalWaitListOptions = {}): Promise<SignalWaitPage> {
    return this.modules.signals.listSignalWaits(options);
  }

  listHumanWaits<TContext extends Json = Json>(
    options: ExternalWaitListOptions = {},
  ): Promise<HumanWaitPage<TContext>> {
    return this.modules.humanWaits.listHumanWaits<TContext>(options);
  }

  listWorkers(): Promise<WorkerRegistryEntry[]> {
    return this.modules.workerRegistry.listWorkers();
  }

  setWorkerPaused(
    workerId: string,
    paused: boolean,
    audit: AdminAudit,
  ): Promise<WorkerPauseResult | null> {
    validateAdminAudit(audit);
    return this.modules.workerRegistry.setWorkerPaused(workerId, paused, {
      requestedBy: audit.actor,
      reason: audit.reason,
      requestId: audit.requestId,
    });
  }

  async runTaskNow(jobId: string, audit: AdminAudit): Promise<RunTaskNowResult> {
    validateAdminAudit(audit);
    const result = await this.database.query<{
      status: RunTaskNowStatus;
      state: string | null;
      run_at: Date | string | null;
    }>(SQL_STATEMENTS["run_task_now_v1"], [jobId, audit.actor, audit.reason, audit.requestId]);
    const row = expectOneRow(result, "workhorse.run_task_now_v1");
    logInfo("workhorse.job.run_now_requested", "Immediate job run requested", {
      "workhorse.job.id": jobId,
      "workhorse.job.state": row.state ?? "not_found",
      "workhorse.operation.status": row.status,
    });
    return {
      status: row.status,
      jobId,
      state: row.state,
      runAt: nullableRowTimestamp(row.run_at, "run_at"),
    };
  }

  async pauseQueue(queueName: string, audit: AdminAudit): Promise<void> {
    validateAdminAudit(audit);
    return this.modules.queueAdministration.pauseQueue(queueName, audit);
  }

  async resumeQueue(queueName: string, audit: AdminAudit): Promise<void> {
    validateAdminAudit(audit);
    return this.modules.queueAdministration.resumeQueue(queueName, audit);
  }

  async purgeQueue(queueName: string, audit: AdminAudit): Promise<number> {
    validateAdminAudit(audit);
    try {
      const result = await this.database.query<{ deleted_count: number }>(
        SQL_STATEMENTS["purge_queue"],
        [queueName, audit.actor, audit.reason, audit.requestId],
      );
      return expectOneRow(result, "workhorse.purge_queue_v1").deleted_count;
    } catch (error) {
      const conflict = purgeConflict(error);
      if (conflict) throw conflict;
      throw error;
    }
  }

  queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    return this.modules.operatorReads.queueMetricSnapshot();
  }

  health(): Promise<QueueHealth> {
    return this.modules.operatorReads.health();
  }

  async concurrencyPolicies(queueNames: readonly string[] = []): Promise<ConcurrencyPolicy[]> {
    const result = await this.database.query<ConcurrencyPolicyRow>(
      SQL_STATEMENTS["concurrency_policy"],
      [queueNames],
    );
    return result.rows.map(concurrencyPolicy);
  }

  getRetentionPolicy(): Promise<RetentionPolicy> {
    return this.modules.retentionMaintenance.getRetentionPolicy();
  }

  previewRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
  ): Promise<RetentionPolicyImpact> {
    return this.modules.retentionMaintenance.previewRetentionPolicy(definition);
  }

  getMaintenancePolicy(): Promise<MaintenancePolicy> {
    return this.modules.retentionMaintenance.getMaintenancePolicy();
  }

  schedules(namespaces: readonly string[]): Promise<StoredSchedule[]> {
    return this.modules.cronSchedules.schedules(namespaces);
  }
}

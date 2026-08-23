import type { QueryResult } from "pg";
import { databaseErrorCode, expectOneRow, WorkhorseError } from "./errors.js";
import { logInfo, type QueueMetricSnapshot } from "./telemetry.js";
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
  WorkerPauseResult,
  WorkerRegistryEntry,
} from "./types.js";
import { MAX_JOB_QUERY_PAGE_SIZE, MAX_REDRIVE_BATCH_SIZE } from "./types.js";
import type { SignalWaitPage } from "./queue/signals.js";
import type { HumanWaitPage } from "./queue/human-waits.js";
import type { ExternalWaitListOptions } from "./queue/external-waits.js";
import { createQueueModuleContext } from "./queue/module-context.js";
import { createQueueModules, type QueueModules } from "./queue/modules.js";
import { nullableRowTimestamp } from "./queue/row-mapping.js";
import { validateQueueOptions } from "./queue/enqueue-contracts.js";
import { concurrencyPolicy, type ConcurrencyPolicyRow } from "./queue/operator-reads.js";

/** Audit identity required by every operator mutation. */
export interface AdminAuditContext {
  actor: string;
  reason: string;
  requestId: string;
}

/** A purge request ID was replayed with different attribution or a different queue. */
export class PurgeIdempotencyConflictError extends WorkhorseError {
  constructor(options?: ErrorOptions) {
    super("Purge request conflicts with a retained request", options);
    this.name = "PurgeIdempotencyConflictError";
  }
}

function validateAdminAudit(audit: AdminAuditContext): void {
  if (!audit || typeof audit !== "object") throw new TypeError("Admin audit context is required");
  if (typeof audit.actor !== "string" || audit.actor.length === 0 || audit.actor.length > 200) {
    throw new TypeError("Admin audit actor must contain between 1 and 200 characters");
  }
  if (
    typeof audit.reason !== "string" ||
    audit.reason.length === 0 ||
    audit.reason.length > 2_000
  ) {
    throw new TypeError("Admin audit reason must contain between 1 and 2000 characters");
  }
  if (
    typeof audit.requestId !== "string" ||
    audit.requestId.length === 0 ||
    new TextEncoder().encode(audit.requestId).byteLength > 512
  ) {
    throw new TypeError("Admin audit requestId must contain between 1 and 512 UTF-8 bytes");
  }
}

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

/** Public operator facade over the versioned PostgreSQL protocol. */
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

  redrive(sourceJobId: string, audit: AdminAuditContext): Promise<RedriveResult> {
    validateAdminAudit(audit);
    return this.modules.operatorReads.redrive(sourceJobId, {
      requestedBy: audit.actor,
      reason: audit.reason,
      requestId: audit.requestId,
    });
  }

  redriveMany(
    filter: DeadLetterFilter,
    audit: AdminAuditContext,
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
    audit: AdminAuditContext,
  ): Promise<WorkerPauseResult | null> {
    validateAdminAudit(audit);
    return this.modules.workerRegistry.setWorkerPaused(workerId, paused, {
      requestedBy: audit.actor,
      reason: audit.reason,
    });
  }

  async pauseQueue(queueName: string, audit: AdminAuditContext): Promise<void> {
    validateAdminAudit(audit);
    await this.modules.queueAdministration.pauseQueue(queueName);
  }

  async resumeQueue(queueName: string, audit: AdminAuditContext): Promise<void> {
    validateAdminAudit(audit);
    await this.modules.queueAdministration.resumeQueue(queueName);
  }

  async purgeQueue(queueName: string, audit: AdminAuditContext): Promise<number> {
    validateAdminAudit(audit);
    let result: QueryResult<{ count: number }>;
    try {
      result = await this.database.query<{ count: number }>(
        "SELECT workhorse.purge_queue_v1($1::text, $2::text, $3::text, $4::text) AS count",
        [queueName, audit.actor, audit.reason, audit.requestId],
      );
    } catch (error) {
      if (databaseErrorCode(error) === "P1006") {
        throw new PurgeIdempotencyConflictError({ cause: error });
      }
      throw error;
    }
    const count = expectOneRow(result, "workhorse.purge_queue_v1").count;
    logInfo("workhorse.queue.purged", "Queue purged", {
      "workhorse.queue.name": queueName,
      "workhorse.job.count": count,
    });
    return count;
  }

  async runTaskNow(jobId: string, audit: AdminAuditContext): Promise<RunTaskNowResult> {
    validateAdminAudit(audit);
    const result = await this.database.query<{
      status: RunTaskNowStatus;
      state: string | null;
      run_at: Date | string | null;
    }>("SELECT status, state, run_at FROM workhorse.run_task_now_v1($1::uuid)", [jobId]);
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

  health(): Promise<QueueHealth> {
    return this.modules.operatorReads.health();
  }

  queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    return this.modules.operatorReads.queueMetricSnapshot();
  }

  getMaintenancePolicy(): Promise<MaintenancePolicy> {
    return this.modules.retentionMaintenance.getMaintenancePolicy();
  }

  getRetentionPolicy(): Promise<RetentionPolicy> {
    return this.modules.retentionMaintenance.getRetentionPolicy();
  }

  async concurrencyPolicies(queueNames: readonly string[] = []): Promise<ConcurrencyPolicy[]> {
    const result = await this.database.query<ConcurrencyPolicyRow>(
      `SELECT namespace, queue_name, max_active, max_active_per_key, updated_at
         FROM workhorse.concurrency_policy
        WHERE cardinality($1::text[]) = 0 OR queue_name = ANY($1::text[])
        ORDER BY queue_name`,
      [queueNames],
    );
    return result.rows.map(concurrencyPolicy);
  }
}

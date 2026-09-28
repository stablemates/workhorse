import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
import type {
  BulkRedriveOptions,
  BulkRedrivePage,
  ChildLineage,
  Budget,
  ConcurrencyPolicy,
  DeadLetterFilter,
  DeadLetterPage,
  DeadLetterQuery,
  DependencyLineage,
  TaskCheckpoint,
  TaskListPage,
  TaskListQuery,
  TaskProgress,
  TaskSnapshot,
  TaskTimelinePage,
  TaskTimelineQuery,
  TaskWait,
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
import {
  databaseErrorCode,
  databaseErrorDetails,
  expectOneRow,
  fastTierRejection,
  WorkhorseError,
} from "./errors.js";
import { MAX_TASK_QUERY_PAGE_SIZE, MAX_REDRIVE_BATCH_SIZE } from "./types.js";
import type { BudgetMetricSnapshot, QueueMetricSnapshot } from "./telemetry.js";
import { logInfo } from "./telemetry.js";
import { createQueueModuleContext } from "./queue/module-context.js";
import type { QueueHistorySettings, QueueTier } from "./queue/queue-administration.js";
import { createQueueModules, type QueueModules } from "./queue/modules.js";
import { validateQueueOptions } from "./queue/enqueue-contracts.js";
import type { ExternalWaitQuery } from "./queue/external-waits.js";
import type { HumanWaitPage } from "./queue/human-waits.js";
import type { SignalWaitPage } from "./queue/signals.js";
import type { StoredSchedule } from "./queue/cron-schedules.js";
import { nullableRowTimestamp } from "./queue/row-mapping.js";
import {
  budget,
  concurrencyPolicy,
  type BudgetRow,
  type ConcurrencyPolicyRow,
} from "./queue/operator-reads.js";

export type RunTaskNowStatus =
  | "released"
  | "already_ready"
  | "not_scheduled"
  | "waiting"
  | "not_found";

export interface RunTaskNowResult {
  status: RunTaskNowStatus;
  taskId: string;
  state: string | null;
  runAt: Date | null;
}

/** Required attribution and replay identity for an administrative mutation. */
export interface AdminAudit {
  actor: string;
  reason: string;
  requestId: string;
}

/** The largest number of drifted dependents one drift read or repair examines. */
export const MAX_DEPENDENCY_DRIFT_LIMIT = 100_000;

/**
 * What a dependency repair does to one drifted blocked dependent.
 *
 * `recounted` stores the recount because a pending edge remains. `rejected` fails or cancels the
 * dependent after a rejecting resolution. `released` makes it ready or scheduled.
 */
export type DependencyRepairAction = "recounted" | "released" | "rejected";

/**
 * One blocked dependent whose counter or rejection flag disagrees with its dependency edges, or
 * whose edges are all resolved.
 */
export interface DependencyDrift {
  taskId: string;
  queueName: string;
  /** The counter the dependent's runtime row records. */
  pendingPrerequisites: number;
  /** The dependency edges that have not resolved. */
  pendingEdges: number;
  /** The rejection flag the dependent's runtime row records. */
  dependencyRejected: boolean;
  /** Whether any resolved edge rejected the dependent. */
  rejectedEdges: boolean;
  /** What a repair would do now. A repair recounts under lock, so it can act differently. */
  action: DependencyRepairAction;
}

/** One dependent a repair changed, and what it did. */
export interface DependencyRepair {
  taskId: string;
  /** The counter the dependent's runtime row recorded before the repair. */
  recordedPendingPrerequisites: number;
  pendingEdges: number;
  action: DependencyRepairAction;
}

function validateDependencyDriftLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DEPENDENCY_DRIFT_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_DEPENDENCY_DRIFT_LIMIT}`);
  }
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

  listTasks(query: TaskListQuery = {}): Promise<TaskListPage> {
    return this.modules.operatorReads.listTasks(query);
  }

  getTask<TResult extends Json = Json>(id: string): Promise<TaskSnapshot<TResult> | null> {
    return this.modules.operatorReads.getTask<TResult>(id);
  }

  getTaskTimeline(taskId: string, query: TaskTimelineQuery = {}): Promise<TaskTimelinePage> {
    return this.modules.operatorReads.getTaskTimeline(taskId, query);
  }

  listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterPage> {
    return this.modules.operatorReads.listDeadLetters(query);
  }

  redrive(sourceTaskId: string, audit: AdminAudit): Promise<RedriveResult> {
    validateAdminAudit(audit);
    return this.modules.operatorReads.redrive(sourceTaskId, {
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

  getRedriveLineage(taskId: string, limit = MAX_REDRIVE_BATCH_SIZE): Promise<RedriveLineage> {
    return this.modules.operatorReads.getRedriveLineage(taskId, limit);
  }

  getDependencyLineage(
    taskId: string,
    limit = MAX_TASK_QUERY_PAGE_SIZE,
  ): Promise<DependencyLineage> {
    return this.modules.operatorReads.getDependencyLineage(taskId, limit);
  }

  getChildLineage(taskId: string, limit = MAX_TASK_QUERY_PAGE_SIZE): Promise<ChildLineage> {
    return this.modules.operatorReads.getChildLineage(taskId, limit);
  }

  getCheckpoint<TValue extends Json = Json>(
    taskId: string,
    name: string,
  ): Promise<TaskCheckpoint<TValue> | null> {
    return this.modules.checkpointsProgressWaits.getCheckpoint<TValue>(taskId, name);
  }

  listCheckpoints<TValue extends Json = Json>(taskId: string): Promise<TaskCheckpoint<TValue>[]> {
    return this.modules.checkpointsProgressWaits.listCheckpoints<TValue>(taskId);
  }

  getProgress<TValue extends Json = Json>(taskId: string): Promise<TaskProgress<TValue> | null> {
    return this.modules.checkpointsProgressWaits.getProgress<TValue>(taskId);
  }

  getWait(taskId: string, name: string): Promise<TaskWait | null> {
    return this.modules.checkpointsProgressWaits.getWait(taskId, name);
  }

  listWaits(taskId: string): Promise<TaskWait[]> {
    return this.modules.checkpointsProgressWaits.listWaits(taskId);
  }

  listSignalWaits(options: ExternalWaitQuery = {}): Promise<SignalWaitPage> {
    return this.modules.signals.listSignalWaits(options);
  }

  listHumanWaits<TContext extends Json = Json>(
    options: ExternalWaitQuery = {},
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

  async runTaskNow(taskId: string, audit: AdminAudit): Promise<RunTaskNowResult> {
    validateAdminAudit(audit);
    const result = await this.database.query<{
      status: RunTaskNowStatus;
      state: string | null;
      run_at: Date | string | null;
    }>(SQL_STATEMENTS["run_task_now_v1"], [taskId, audit.actor, audit.reason, audit.requestId]);
    const row = expectOneRow(result, "workhorse.run_task_now_v1");
    logInfo("workhorse.task.run_now_requested", "Immediate task run requested", {
      "workhorse.task.id": taskId,
      "workhorse.task.state": row.state ?? "not_found",
      "workhorse.operation.status": row.status,
    });
    return {
      status: row.status,
      taskId,
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

  /**
   * Move a queue between the full and fast tiers. Workhorse refuses the change while the queue
   * holds a live task, so a task never changes tier.
   */
  async setQueueTier(queueName: string, tier: QueueTier, audit: AdminAudit): Promise<QueueTier> {
    validateAdminAudit(audit);
    if (tier !== "fast" && tier !== "full") throw new RangeError("tier must be fast or full");
    try {
      return await this.modules.queueAdministration.setQueueTier(queueName, tier, audit);
    } catch (error) {
      throw fastTierRejection(error) ?? error;
    }
  }

  /**
   * Choose the history a fast-tier queue writes. An omitted setting keeps its current value, and
   * the result reports both settings after the change.
   */
  async setQueueHistory(
    queueName: string,
    settings: Partial<QueueHistorySettings>,
  ): Promise<QueueHistorySettings> {
    return this.modules.queueAdministration.setQueueHistory(queueName, settings);
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

  /**
   * List blocked dependents whose dependency counters disagree with their edges, in task ID order.
   * It writes nothing, so it is the dry run of {@link repairDependencyDrift}.
   */
  async listDependencyDrift(limit = 1_000): Promise<DependencyDrift[]> {
    validateDependencyDriftLimit(limit);
    const result = await this.database.query<{
      task_id: string;
      queue_name: string;
      pending_prerequisites: number;
      pending_edges: number;
      dependency_rejected: boolean;
      rejected_edges: boolean;
      action: DependencyRepairAction;
    }>(SQL_STATEMENTS["list_dependency_drift"], [limit]);
    return result.rows.map((row) => ({
      taskId: row.task_id,
      queueName: row.queue_name,
      pendingPrerequisites: row.pending_prerequisites,
      pendingEdges: row.pending_edges,
      dependencyRejected: row.dependency_rejected,
      rejectedEdges: row.rejected_edges,
      action: row.action,
    }));
  }

  /**
   * Recount the drifted blocked dependents {@link listDependencyDrift} reports, and settle each
   * one with no pending edge. Each repaired dependent's `dependency_counter_repaired` event records
   * the audit. The request ID correlates the repair and is not an idempotency key: a rerun finds
   * only dependents that drifted again.
   */
  async repairDependencyDrift(audit: AdminAudit, limit = 1_000): Promise<DependencyRepair[]> {
    validateAdminAudit(audit);
    validateDependencyDriftLimit(limit);
    const result = await this.database.query<{
      task_id: string;
      recorded_pending_prerequisites: number;
      pending_edges: number;
      action: DependencyRepairAction;
    }>(SQL_STATEMENTS["repair_dependency_drift"], [
      limit,
      audit.actor,
      audit.reason,
      audit.requestId,
    ]);
    return result.rows.map((row) => ({
      taskId: row.task_id,
      recordedPendingPrerequisites: row.recorded_pending_prerequisites,
      pendingEdges: row.pending_edges,
      action: row.action,
    }));
  }

  queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    return this.modules.operatorReads.queueMetricSnapshot();
  }

  budgetMetricSnapshot(): Promise<BudgetMetricSnapshot[]> {
    return this.modules.operatorReads.budgetMetricSnapshot();
  }

  health(): Promise<QueueHealth> {
    return this.modules.operatorReads.health();
  }

  async listConcurrencyPolicies(queueNames: readonly string[] = []): Promise<ConcurrencyPolicy[]> {
    const result = await this.database.query<ConcurrencyPolicyRow>(
      SQL_STATEMENTS["concurrency_policy"],
      [queueNames],
    );
    return result.rows.map(concurrencyPolicy);
  }

  /** @deprecated Use `listConcurrencyPolicies`. Removed in 1.0.0. */
  concurrencyPolicies(queueNames: readonly string[] = []): Promise<ConcurrencyPolicy[]> {
    return this.listConcurrencyPolicies(queueNames);
  }

  async listBudgets(budgetNames: readonly string[] = []): Promise<Budget[]> {
    const result = await this.database.query<BudgetRow>(SQL_STATEMENTS["list_budgets"], [
      budgetNames,
    ]);
    return result.rows.map(budget);
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

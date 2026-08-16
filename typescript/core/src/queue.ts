import { expectOneRow } from "./errors.js";
import type {
  BulkRedrivePage,
  BulkRedriveOptions,
  ChildLineage,
  ChildJobOptions,
  ChildJobRequest,
  CancellationRequest,
  CancelResult,
  BatchExecutionRecord,
  ClaimedJob,
  CreateChildResult,
  CreateChildrenResult,
  ConcurrencyPolicy,
  ConcurrencyPolicyDefinition,
  RateLimitPolicy,
  RateLimitPolicyDefinition,
  RateLimitStatus,
  DeadLetterFilter,
  DeadLetterPage,
  DeadLetterQuery,
  DependencyLineage,
  EnqueueOptions,
  EnqueueRequest,
  EnqueueResult,
  ExpireOwnedStatus,
  JobListPage,
  JobListQuery,
  JobCheckpoint,
  JobProgress,
  JobSnapshot,
  JobTimelinePage,
  JobTimelineQuery,
  JobWait,
  HeartbeatStatus,
  Json,
  MaintenancePolicy,
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  Queryable,
  QueueOptions,
  QueueHealth,
  QueueHealthBudgets,
  RedriveLineage,
  RedriveRequest,
  RedriveResult,
  RetentionPolicy,
  RetentionPolicyDefinition,
  RetentionPolicyImpact,
  RetentionPolicySetting,
  WorkerPauseResult,
  WorkerRegistration,
  WorkerRegistryEntry,
} from "./types.js";
import { MAX_JOB_QUERY_PAGE_SIZE } from "./types.js";
import { logInfo, type QueueMetricSnapshot } from "./telemetry.js";
import {
  subscribeToJobNotifications,
  supportsJobNotifications,
  type JobNotificationSubscription,
} from "./notifications.js";
import { createQueueModuleContext } from "./queue/module-context.js";
import { createQueueModules, type QueueModules } from "./queue/modules.js";
import {
  RedriveIdempotencyConflictError,
  concurrencyPolicy,
  rateLimitPolicy,
  type ConcurrencyPolicyRow,
  type RateLimitPolicyRow,
} from "./queue/operator-reads.js";
import { errorForTelemetry } from "./queue/claim-lease-fence.js";
import {
  CheckpointConflictError,
  CheckpointLeaseLostError,
  ProgressLeaseLostError,
  ProgressRateLimitError,
  WaitConflictError,
  WaitLeaseLostError,
  WaitLimitExceededError,
  type ScheduleWaitRequest,
  type ScheduleWaitResult,
} from "./queue/checkpoints-progress-waits.js";
import {
  DependencyCycleError,
  DependencyLimitExceededError,
  type DependencyCycleDetails,
  type DependencyLimit,
  EnqueueIdempotencyConflictError,
  JobContractUnavailableError,
  JobContractValidationError,
  JobValueSizeLimitError,
  validateQueueOptions,
} from "./queue/enqueue-contracts.js";
import type {
  ScheduleDefinition,
  ScheduleJobDefinition,
  StoredSchedule,
} from "./queue/cron-schedules.js";
import type { MaintenancePhaseResult } from "./queue/retention-maintenance.js";
import {
  ChildConflictError,
  ChildLeaseLostError,
  ChildLimitExceededError,
  ChildResultLimitExceededError,
} from "./queue/child-jobs.js";
import {
  SignalIdempotencyConflictError,
  SignalWaitConflictError,
  SignalWaitLeaseLostError,
  SignalWaitLimitExceededError,
  type SendSignalRequest,
  type SendSignalResult,
  type SendSignalStatus,
  type SignalWait,
  type SignalWaitPage,
  type WaitForSignalResult,
  type WaitForSignalStatus,
} from "./queue/signals.js";
import {
  HumanWaitAlreadyWaitingError,
  HumanWaitConflictError,
  HumanWaitIdempotencyConflictError,
  HumanWaitLeaseLostError,
  HumanWaitLimitExceededError,
  type CompleteHumanWaitRequest,
  type CompleteHumanWaitResult,
  type CompleteHumanWaitStatus,
  type HumanWait,
  type HumanWaitPage,
  type WaitForHumanResult,
  type WaitForHumanStatus,
} from "./queue/human-waits.js";
import type {
  ExternalWaitDeliveryRequest,
  ExternalWaitCursor,
  ExternalWaitListOptions,
  ExternalWaitOptions,
} from "./queue/external-waits.js";

export type { MaintenancePhase, MaintenancePhaseResult } from "./queue/retention-maintenance.js";

export {
  CheckpointConflictError,
  CheckpointLeaseLostError,
  ChildConflictError,
  ChildLeaseLostError,
  ChildLimitExceededError,
  ChildResultLimitExceededError,
  DependencyCycleError,
  DependencyLimitExceededError,
  EnqueueIdempotencyConflictError,
  JobContractUnavailableError,
  JobContractValidationError,
  JobValueSizeLimitError,
  ProgressLeaseLostError,
  ProgressRateLimitError,
  RedriveIdempotencyConflictError,
  WaitConflictError,
  WaitLeaseLostError,
  WaitLimitExceededError,
  SignalIdempotencyConflictError,
  SignalWaitConflictError,
  SignalWaitLeaseLostError,
  SignalWaitLimitExceededError,
  HumanWaitAlreadyWaitingError,
  HumanWaitConflictError,
  HumanWaitIdempotencyConflictError,
  HumanWaitLeaseLostError,
  HumanWaitLimitExceededError,
};
export type {
  DependencyCycleDetails,
  DependencyLimit,
  ScheduleWaitRequest,
  ScheduleWaitResult,
  SendSignalRequest,
  SendSignalResult,
  SendSignalStatus,
  SignalWait,
  SignalWaitPage,
  WaitForSignalResult,
  WaitForSignalStatus,
  CompleteHumanWaitRequest,
  CompleteHumanWaitResult,
  CompleteHumanWaitStatus,
  HumanWait,
  HumanWaitPage,
  WaitForHumanResult,
  WaitForHumanStatus,
  ExternalWaitOptions,
  ExternalWaitDeliveryRequest,
  ExternalWaitCursor,
  ExternalWaitListOptions,
};
export type { ScheduleDefinition, ScheduleJobDefinition, StoredSchedule };
import { nullableRowTimestamp } from "./queue/row-mapping.js";

export { errorForTelemetry };

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

import { MAX_REDRIVE_BATCH_SIZE } from "./types.js";

/**
 * Thin TypeScript facade over the versioned PostgreSQL protocol.
 *
 * Correctness lives in SQL functions. Keeping this layer thin prevents each runtime client from
 * inventing its own locking, fencing, or history behavior.
 */
export class Queue {
  private readonly options: QueueOptions;
  private readonly modules: QueueModules;

  constructor(
    private readonly database: Queryable,
    readonly defaultQueue = "default",
    options: QueueOptions = {},
  ) {
    this.options = validateQueueOptions(options);
    this.modules = createQueueModules(
      createQueueModuleContext(database, defaultQueue, this.options),
    );
  }

  /** @internal Whether workers can reserve a node-postgres LISTEN connection. */
  supportsJobNotifications(): boolean {
    return supportsJobNotifications(this.database);
  }

  /** @internal Subscribe a worker to the process-local notification hub for this database. */
  subscribeToJobNotifications(
    queueName: string,
    wake: () => void,
    error: (error: unknown) => void,
  ): Promise<JobNotificationSubscription | null> {
    return subscribeToJobNotifications(this.database, { queueName, wake, error });
  }

  async enqueue<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.database,
  ): Promise<string> {
    return this.modules.enqueueContracts.enqueue(type, payload, options, transaction);
  }

  async enqueueWithResult<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.database,
  ): Promise<EnqueueResult> {
    return this.modules.enqueueContracts.enqueueWithResult(type, payload, options, transaction);
  }

  async enqueueMany(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<string[]> {
    return this.modules.enqueueContracts.enqueueMany(requests, transaction);
  }

  async enqueueManyWithResults(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<EnqueueResult[]> {
    return this.modules.enqueueContracts.enqueueManyWithResults(requests, transaction);
  }

  async promote(limit = 100): Promise<number> {
    return this.modules.queueAdministration.promote(limit);
  }

  async pauseQueue(queueName = this.defaultQueue): Promise<void> {
    return this.modules.queueAdministration.pauseQueue(queueName);
  }

  async resumeQueue(queueName = this.defaultQueue): Promise<void> {
    return this.modules.queueAdministration.resumeQueue(queueName);
  }

  async purgeQueue(queueName = this.defaultQueue): Promise<number> {
    return this.modules.queueAdministration.purgeQueue(queueName);
  }

  /**
   * Announce or refresh this worker's registration and read back the operator-requested pause flag.
   *
   * One round trip pushes the runtime state the worker owns and pulls the pause decision
   * PostgreSQL owns, so an operator surface in a different process can observe and control a
   * worker fleet it does not host.
   *
   * `instanceId` identifies this process incarnation. A refresh from the same instance keeps any
   * operator pause; a new instance of the same worker id clears it, which is what makes pause
   * process-scoped rather than a flag that outlives the process it was aimed at.
   */
  async registerWorker(registration: WorkerRegistration): Promise<{ paused: boolean }> {
    return this.modules.workerRegistry.registerWorker(registration);
  }

  /** Remove one worker registration. A killed worker instead ages out of the fleet view. */
  async deregisterWorker(workerId: string): Promise<boolean> {
    return this.modules.workerRegistry.deregisterWorker(workerId);
  }

  /**
   * Request or clear an operator pause for one registered worker.
   *
   * `requestedBy` and `reason` are bounded audit attribution rather than authorization. The pause
   * is cooperative: the worker stops claiming when it next refreshes its registration, and any
   * in-flight handler runs to completion. Returns null when the worker is not registered.
   */
  async setWorkerPaused(
    workerId: string,
    paused: boolean,
    options: { requestedBy?: string; reason?: string } = {},
  ): Promise<WorkerPauseResult | null> {
    return this.modules.workerRegistry.setWorkerPaused(workerId, paused, options);
  }

  /** List every registered worker, most recently seen first. */
  async listWorkers(): Promise<WorkerRegistryEntry[]> {
    return this.modules.workerRegistry.listWorkers();
  }

  /** Drop registrations whose process stopped heartbeating longer ago than the given window. */
  async pruneWorkerRegistry(maxAgeMs = 24 * 60 * 60 * 1_000): Promise<number> {
    return this.modules.workerRegistry.pruneWorkerRegistry(maxAgeMs);
  }

  async tick(
    options: { promoteLimit?: number; recoverLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.modules.retentionMaintenance.tick(options);
  }

  async prepareHistoryPartitions(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.modules.retentionMaintenance.prepareHistoryPartitions(options);
  }

  /**
   * Materialize closed minutes of rolling statistics and advance the rollup watermark.
   *
   * Operator time windows read these aggregates instead of scanning retained history, so this pass
   * is what keeps a dashboard's cost proportional to the window rather than to throughput. It is
   * safe to run from every worker and safe to run repeatedly: a bucket is a pure function of the
   * raw history in its minute, and passes serialize on an advisory lock.
   */
  async rollupStatistics(
    options: { now?: Date; maxBuckets?: number; recomputeBuckets?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.modules.retentionMaintenance.rollupStatistics(options);
  }

  async retainHistory(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.modules.retentionMaintenance.retainHistory(options);
  }

  async pruneTerminalStorage(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.modules.retentionMaintenance.pruneTerminalStorage(options);
  }

  async syncRetentionPolicy(
    definition: RetentionPolicyDefinition,
    options: { force?: boolean } = {},
  ): Promise<RetentionPolicy> {
    return this.modules.retentionMaintenance.syncRetentionPolicy(definition, options);
  }

  async syncConcurrencyPolicies(
    namespace: string,
    definitions: readonly ConcurrencyPolicyDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<ConcurrencyPolicy[]> {
    const input = definitions.map((definition) => ({
      queue: definition.queue,
      maxActive: definition.maxActive,
      maxActivePerKey: definition.maxActivePerKey ?? null,
    }));
    const result = await this.database.query<ConcurrencyPolicyRow>(
      "SELECT * FROM workhorse.sync_concurrency_policies_v1($1::text, $2::jsonb, $3::boolean)",
      [namespace, JSON.stringify(input), options.prune ?? true],
    );
    return result.rows.map(concurrencyPolicy);
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

  async syncRateLimitPolicies(
    namespace: string,
    definitions: readonly RateLimitPolicyDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<RateLimitPolicy[]> {
    const input = definitions.map((definition) => ({
      queue: definition.queue,
      rate: definition.rate,
      perKey: definition.perKey ?? null,
    }));
    const result = await this.database.query<RateLimitPolicyRow>(
      "SELECT * FROM workhorse.sync_rate_limit_policies_v1($1, $2::jsonb, $3)",
      [namespace, JSON.stringify(input), options.prune ?? true],
    );
    return result.rows.map(rateLimitPolicy);
  }

  async rateLimitPolicies(queueNames: readonly string[] = []): Promise<RateLimitPolicy[]> {
    const result = await this.database.query<RateLimitPolicyRow>(
      `SELECT namespace, queue_name, rate_limit, rate_interval_ms, rate_burst,
              per_key_limit, per_key_interval_ms, per_key_burst, updated_at
         FROM workhorse.rate_limit_policy
        WHERE cardinality($1::text[]) = 0 OR queue_name = ANY($1::text[])
        ORDER BY queue_name`,
      [queueNames],
    );
    return result.rows.map(rateLimitPolicy);
  }

  async rateLimitStatuses(queueNames: readonly string[] = []): Promise<RateLimitStatus[]> {
    return this.modules.operatorReads.rateLimitStatuses(queueNames);
  }

  async overrideRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
  ): Promise<RetentionPolicy> {
    return this.modules.retentionMaintenance.overrideRetentionPolicy(definition);
  }

  async revertRetentionPolicy(
    settings: readonly RetentionPolicySetting[],
  ): Promise<RetentionPolicy> {
    return this.modules.retentionMaintenance.revertRetentionPolicy(settings);
  }

  async previewRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
  ): Promise<RetentionPolicyImpact> {
    return this.modules.retentionMaintenance.previewRetentionPolicy(definition);
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    return this.modules.retentionMaintenance.getRetentionPolicy();
  }

  async syncMaintenancePolicy(
    definition: MaintenancePolicyDefinition,
    options: { force?: boolean } = {},
  ): Promise<MaintenancePolicy> {
    return this.modules.retentionMaintenance.syncMaintenancePolicy(definition, options);
  }

  async overrideMaintenancePolicy(
    definition: Partial<MaintenancePolicyDefinition>,
  ): Promise<MaintenancePolicy> {
    return this.modules.retentionMaintenance.overrideMaintenancePolicy(definition);
  }

  async revertMaintenancePolicy(
    settings: readonly MaintenancePolicySetting[],
  ): Promise<MaintenancePolicy> {
    return this.modules.retentionMaintenance.revertMaintenancePolicy(settings);
  }

  async getMaintenancePolicy(): Promise<MaintenancePolicy> {
    return this.modules.retentionMaintenance.getMaintenancePolicy();
  }

  async syncSchedules(
    namespace: string,
    definitions: readonly ScheduleDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    return this.modules.cronSchedules.syncSchedules(namespace, definitions, options);
  }

  async schedules(namespaces: readonly string[]): Promise<StoredSchedule[]> {
    return this.modules.cronSchedules.schedules(namespaces);
  }

  async fireSchedule(
    namespace: string,
    name: string,
    revision: bigint,
    occurrenceAt: Date,
  ): Promise<string | null> {
    return this.modules.cronSchedules.fireSchedule(namespace, name, revision, occurrenceAt);
  }

  async runTaskNow(jobId: string): Promise<RunTaskNowResult> {
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

  async cancel(jobId: string, request: CancellationRequest = {}): Promise<CancelResult> {
    return this.modules.claimLeaseFence.cancel(jobId, request);
  }

  async listJobs(query: JobListQuery = {}): Promise<JobListPage> {
    return this.modules.operatorReads.listJobs(query);
  }

  async getJobTimeline(jobId: string, query: JobTimelineQuery = {}): Promise<JobTimelinePage> {
    return this.modules.operatorReads.getJobTimeline(jobId, query);
  }

  async listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterPage> {
    return this.modules.operatorReads.listDeadLetters(query);
  }

  async redrive(sourceJobId: string, request: RedriveRequest): Promise<RedriveResult> {
    return this.modules.operatorReads.redrive(sourceJobId, request);
  }

  async redriveMany(
    filter: DeadLetterFilter,
    request: RedriveRequest,
    options: BulkRedriveOptions = {},
  ): Promise<BulkRedrivePage> {
    return this.modules.operatorReads.redriveMany(filter, request, options);
  }

  async getRedriveLineage(jobId: string, limit = MAX_REDRIVE_BATCH_SIZE): Promise<RedriveLineage> {
    return this.modules.operatorReads.getRedriveLineage(jobId, limit);
  }

  async getDependencyLineage(
    jobId: string,
    limit = MAX_JOB_QUERY_PAGE_SIZE,
  ): Promise<DependencyLineage> {
    return this.modules.operatorReads.getDependencyLineage(jobId, limit);
  }

  async getChildLineage(jobId: string, limit = MAX_JOB_QUERY_PAGE_SIZE): Promise<ChildLineage> {
    return this.modules.operatorReads.getChildLineage(jobId, limit);
  }

  async claim<TPayload = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedJob<TPayload> | null> {
    return this.modules.claimLeaseFence.claim<TPayload>(workerId, options);
  }

  /** @internal Persist the ordered membership chosen by a worker's batch coordinator. */
  async recordBatchDispatch(batch: BatchExecutionRecord): Promise<void> {
    return this.modules.claimLeaseFence.recordBatchDispatch(batch);
  }

  /** @internal Persist that the shared callback failed before returning per-member outcomes. */
  async recordBatchFailure(batch: BatchExecutionRecord): Promise<void> {
    return this.modules.claimLeaseFence.recordBatchFailure(batch);
  }

  async heartbeat(job: ClaimedJob<unknown>, workerId: string, leaseMs = 30_000): Promise<boolean> {
    return this.modules.claimLeaseFence.heartbeat(job, workerId, leaseMs);
  }

  async heartbeatStatus(
    job: ClaimedJob<unknown>,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<HeartbeatStatus> {
    return this.modules.claimLeaseFence.heartbeatStatus(job, workerId, leaseMs);
  }

  async expireOwned(job: ClaimedJob<unknown>, workerId: string): Promise<ExpireOwnedStatus> {
    return this.modules.claimLeaseFence.expireOwned(job, workerId);
  }

  async acknowledgeCancel(job: ClaimedJob<unknown>, workerId: string): Promise<boolean> {
    return this.modules.claimLeaseFence.acknowledgeCancel(job, workerId);
  }

  async getCheckpoint<TValue extends Json = Json>(
    jobId: string,
    name: string,
  ): Promise<JobCheckpoint<TValue> | null> {
    return this.modules.checkpointsProgressWaits.getCheckpoint<TValue>(jobId, name);
  }

  async listCheckpoints<TValue extends Json = Json>(
    jobId: string,
  ): Promise<JobCheckpoint<TValue>[]> {
    return this.modules.checkpointsProgressWaits.listCheckpoints<TValue>(jobId);
  }

  async saveCheckpoint<TValue extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    value: TValue,
  ): Promise<JobCheckpoint<TValue>> {
    return this.modules.checkpointsProgressWaits.saveCheckpoint(job, workerId, name, value);
  }

  async getProgress<TValue extends Json = Json>(
    jobId: string,
  ): Promise<JobProgress<TValue> | null> {
    return this.modules.checkpointsProgressWaits.getProgress<TValue>(jobId);
  }

  async updateProgress<TValue extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    value: TValue,
  ): Promise<JobProgress<TValue>> {
    return this.modules.checkpointsProgressWaits.updateProgress(job, workerId, value);
  }

  async getWait(jobId: string, name: string): Promise<JobWait | null> {
    return this.modules.checkpointsProgressWaits.getWait(jobId, name);
  }

  async listWaits(jobId: string): Promise<JobWait[]> {
    return this.modules.checkpointsProgressWaits.listWaits(jobId);
  }

  async scheduleWait(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    request: ScheduleWaitRequest,
  ): Promise<ScheduleWaitResult> {
    return this.modules.checkpointsProgressWaits.scheduleWait(job, workerId, name, request);
  }

  async waitForSignal<TPayload extends Json = Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForSignalResult<TPayload>> {
    return this.modules.signals.waitForSignal<TPayload>(job, workerId, name, options);
  }

  async listSignalWaits(options: ExternalWaitListOptions = {}): Promise<SignalWaitPage> {
    return this.modules.signals.listSignalWaits(options);
  }

  async sendSignal<TPayload extends Json>(
    jobId: string,
    name: string,
    payload: TPayload,
    request: SendSignalRequest,
  ): Promise<SendSignalResult<TPayload>> {
    return this.modules.signals.sendSignal(jobId, name, payload, request);
  }

  async waitForHuman<TContext extends Json, TResult extends Json = Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    context: TContext,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForHumanResult<TResult>> {
    return this.modules.humanWaits.waitForHuman<TContext, TResult>(
      job,
      workerId,
      name,
      context,
      options,
    );
  }

  async listHumanWaits<TContext extends Json = Json>(
    options: ExternalWaitListOptions = {},
  ): Promise<HumanWaitPage<TContext>> {
    return this.modules.humanWaits.listHumanWaits<TContext>(options);
  }

  async completeHumanWait<TResult extends Json>(
    jobId: string,
    name: string,
    result: TResult,
    request: CompleteHumanWaitRequest,
  ): Promise<CompleteHumanWaitResult<TResult>> {
    return this.modules.humanWaits.completeHumanWait(jobId, name, result, request);
  }

  async createChild<TPayload extends Json, TResult extends Json = Json>(
    parent: ClaimedJob<unknown>,
    workerId: string,
    name: string,
    type: string,
    payload: TPayload,
    options: ChildJobOptions = {},
  ): Promise<CreateChildResult<TResult>> {
    return this.modules.childJobs.createChild(parent, workerId, name, type, payload, options);
  }

  async createChildren<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedJob<unknown>,
    workerId: string,
    children: readonly ChildJobRequest[],
  ): Promise<CreateChildrenResult<TResult>> {
    return this.modules.childJobs.createChildren<TResult>(parent, workerId, children);
  }

  async complete<TResult extends Json>(
    job: ClaimedJob<unknown>,
    workerId: string,
    result: TResult,
  ): Promise<boolean> {
    return this.modules.claimLeaseFence.complete(job, workerId, result, () => {
      this.modules.enqueueContracts.validateResult(job, result);
    });
  }

  async fail(
    job: ClaimedJob<unknown>,
    workerId: string,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<
    | "ready"
    | "scheduled"
    | "failed"
    | "cancel_requested"
    | "deadline_exceeded"
    | "timeout_exceeded"
    | "stale"
  > {
    return this.modules.claimLeaseFence.fail(job, workerId, error, retryDelayMs);
  }

  async recoverExpired(limit = 100, retryDelayMs?: number): Promise<number> {
    return this.modules.claimLeaseFence.recoverExpired(limit, retryDelayMs);
  }

  async getJob<TResult = Json>(id: string): Promise<JobSnapshot<TResult> | null> {
    return this.modules.operatorReads.getJob<TResult>(id);
  }

  async health(options: { budgets?: Partial<QueueHealthBudgets> } = {}): Promise<QueueHealth> {
    return this.modules.operatorReads.health(options);
  }

  /** Read the per-queue live pressure used by OpenTelemetry observable instruments. */
  async queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    return this.modules.operatorReads.queueMetricSnapshot();
  }
}

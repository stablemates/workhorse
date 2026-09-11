import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
import type {
  ChildTaskOptions,
  ChildOutcomes,
  ChildTaskRequest,
  CancellationRequest,
  CancelResult,
  BatchExecutionRecord,
  ClaimedTask,
  CreateChildResult,
  CreateChildrenResult,
  ConcurrencyPolicy,
  ConcurrencyPolicyDefinition,
  RateLimitPolicy,
  RateLimitPolicyDefinition,
  RateLimitStatus,
  EnqueueOptions,
  EnqueueRequest,
  EnqueueResult,
  ExpireOwnedStatus,
  TaskCheckpoint,
  TaskProgress,
  TaskWait,
  HeartbeatStatus,
  Json,
  MaintenancePolicy,
  MaintenancePolicyDefinition,
  MaintenancePolicySetting,
  Queryable,
  QueueOptions,
  QueueHealth,
  RetentionPolicy,
  RetentionPolicyDefinition,
  RetentionPolicyImpact,
  RetentionPolicySetting,
  WorkerRegistration,
} from "./types.js";
import type { QueueMetricSnapshot } from "./telemetry.js";
import {
  subscribeToTaskNotifications,
  supportsTaskNotifications,
  type TaskNotificationSubscription,
} from "./notifications.js";
import { createQueueModuleContext } from "./queue/module-context.js";
import {
  createQueueModules,
  createQueueModuleState,
  type QueueModules,
  type QueueModuleState,
} from "./queue/modules.js";
import {
  RedriveIdempotencyConflictError,
  concurrencyPolicy,
  rateLimitPolicy,
  type ConcurrencyPolicyRow,
  type RateLimitPolicyRow,
} from "./queue/operator-reads.js";
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
  TaskContractUnavailableError,
  TaskContractValidationError,
  TaskValueSizeLimitError,
  validateQueueOptions,
} from "./queue/enqueue-contracts.js";
import type { ScheduleDefinition, ScheduledTask, StoredSchedule } from "./queue/cron-schedules.js";
import type { MaintenancePhaseResult } from "./queue/retention-maintenance.js";
import {
  ChildConflictError,
  ChildLeaseLostError,
  ChildLimitExceededError,
  ChildResultLimitExceededError,
} from "./queue/child-tasks.js";
import {
  SignalIdempotencyConflictError,
  SignalWaitConflictError,
  SignalWaitLeaseLostError,
  SignalWaitLimitExceededError,
  type SendSignalRequest,
  type SignalDeliveryResult,
  type SignalDeliveryStatus,
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
  type HumanWaitCompletionResult,
  type HumanWaitCompletionStatus,
  type HumanWait,
  type HumanWaitPage,
  type WaitForHumanResult,
  type WaitForHumanStatus,
} from "./queue/human-waits.js";
import type {
  ExternalWaitDeliveryRequest,
  ExternalWaitCursor,
  ExternalWaitQuery,
  ExternalWaitOptions,
} from "./queue/external-waits.js";
import { workerCheckpointsRead, workerProgressRead, workerWaitsRead } from "./worker-internal.js";

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
  TaskContractUnavailableError,
  TaskContractValidationError,
  TaskValueSizeLimitError,
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
  SignalDeliveryResult,
  SignalDeliveryStatus,
  SignalWait,
  SignalWaitPage,
  WaitForSignalResult,
  WaitForSignalStatus,
  CompleteHumanWaitRequest,
  HumanWaitCompletionResult,
  HumanWaitCompletionStatus,
  HumanWait,
  HumanWaitPage,
  WaitForHumanResult,
  WaitForHumanStatus,
  ExternalWaitOptions,
  ExternalWaitDeliveryRequest,
  ExternalWaitCursor,
  ExternalWaitQuery,
};
export type { ScheduleDefinition, ScheduledTask, StoredSchedule };

// Deprecated 0.x aliases for the names Python and Go already shared. Removed in 1.0.0.
export type { SendSignalResult, SendSignalStatus } from "./queue/signals.js";
export type { CompleteHumanWaitResult, CompleteHumanWaitStatus } from "./queue/human-waits.js";
export type { ExternalWaitListOptions } from "./queue/external-waits.js";
export type { ScheduleTaskDefinition } from "./queue/cron-schedules.js";

/**
 * Thin TypeScript facade over the versioned PostgreSQL protocol.
 *
 * Correctness lives in SQL functions. Keeping this layer thin prevents each runtime client from
 * inventing its own locking, fencing, or history behavior.
 */
export class Queue {
  private readonly options: QueueOptions;
  private readonly modules: QueueModules;
  private readonly moduleState: QueueModuleState;

  constructor(database: Queryable, defaultQueue?: string, options?: QueueOptions);
  /** @internal */
  constructor(
    database: Queryable,
    defaultQueue: string,
    options: QueueOptions,
    moduleState: QueueModuleState,
  );
  constructor(
    private readonly database: Queryable,
    readonly defaultQueue = "default",
    options: QueueOptions = {},
    moduleState: QueueModuleState = createQueueModuleState(),
  ) {
    this.options = validateQueueOptions(options);
    this.moduleState = moduleState;
    this.modules = createQueueModules(
      createQueueModuleContext(database, defaultQueue, this.options),
      moduleState,
    );
  }

  /** @internal Bind the facade to another database while retaining process-local module caches. */
  forDatabase(database: Queryable): Queue {
    return new Queue(database, this.defaultQueue, this.options, this.moduleState);
  }

  /** @internal Whether workers can reserve a node-postgres LISTEN connection. */
  supportsTaskNotifications(): boolean {
    return supportsTaskNotifications(this.database);
  }

  /** @internal Subscribe a worker to the process-local notification hub for this database. */
  subscribeToTaskNotifications(
    queueName: string,
    wake: () => void,
    error: (error: unknown) => void,
  ): Promise<TaskNotificationSubscription | null> {
    return subscribeToTaskNotifications(this.database, { queueName, wake, error });
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

  /** Drop registrations whose process stopped heartbeating longer ago than the given window. */
  async pruneWorkerRegistry(maxAgeMs = 60_000): Promise<number> {
    return this.modules.workerRegistry.pruneWorkerRegistry(maxAgeMs);
  }

  async tick(
    options: { promoteLimit?: number; recoverLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    return this.modules.retentionMaintenance.tick(options);
  }

  /** Offer every database-coordinated slow maintenance phase in its required order. */
  async runMaintenance(options: { now?: Date } = {}): Promise<MaintenancePhaseResult[]> {
    return this.modules.retentionMaintenance.runMaintenance(options);
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
   * raw history in its minute, and passes serialize on an advisory lock. The cadence, recompute
   * window, and group limit come from the maintenance policy; `force` bypasses the cadence gate.
   */
  async rollupStatistics(
    options: { force?: boolean; now?: Date; maxBuckets?: number } = {},
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
      SQL_STATEMENTS["sync_concurrency_policies_v1"],
      [namespace, JSON.stringify(input), options.prune ?? true],
    );
    return result.rows.map(concurrencyPolicy);
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
      SQL_STATEMENTS["sync_rate_limit_policies_v1__queue"],
      [namespace, JSON.stringify(input), options.prune ?? true],
    );
    return result.rows.map(rateLimitPolicy);
  }

  async listRateLimitPolicies(queueNames: readonly string[] = []): Promise<RateLimitPolicy[]> {
    const result = await this.database.query<RateLimitPolicyRow>(
      SQL_STATEMENTS["rate_limit_policy"],
      [queueNames],
    );
    return result.rows.map(rateLimitPolicy);
  }

  /** @deprecated Use `listRateLimitPolicies`. Removed in 1.0.0. */
  rateLimitPolicies(queueNames: readonly string[] = []): Promise<RateLimitPolicy[]> {
    return this.listRateLimitPolicies(queueNames);
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

  async fireDueSchedules(
    namespaces: readonly string[],
    now: Date,
    catchupLimit: number,
  ): Promise<void> {
    return this.modules.cronSchedules.fireDueSchedules(namespaces, now, catchupLimit);
  }

  async cancel(taskId: string, request: CancellationRequest = {}): Promise<CancelResult> {
    return this.modules.claimLeaseFence.cancel(taskId, request);
  }

  async claim<TPayload extends Json = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload> | null> {
    return this.modules.claimLeaseFence.claim<TPayload>(workerId, options);
  }

  async claimMany<TPayload extends Json = Json>(
    workerId: string,
    limit: number,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload>[]> {
    return this.modules.claimLeaseFence.claimMany<TPayload>(workerId, limit, options);
  }

  /** @internal Persist the ordered membership chosen by a worker's batch coordinator. */
  async recordBatchDispatch(batch: BatchExecutionRecord): Promise<void> {
    return this.modules.claimLeaseFence.recordBatchDispatch(batch);
  }

  /** @internal Persist that the shared callback failed before returning per-member outcomes. */
  async recordBatchFailure(batch: BatchExecutionRecord): Promise<void> {
    return this.modules.claimLeaseFence.recordBatchFailure(batch);
  }

  async heartbeat(task: ClaimedTask, workerId: string, leaseMs = 30_000): Promise<boolean> {
    return this.modules.claimLeaseFence.heartbeat(task, workerId, leaseMs);
  }

  async heartbeatStatus(
    task: ClaimedTask,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<HeartbeatStatus> {
    return this.modules.claimLeaseFence.heartbeatStatus(task, workerId, leaseMs);
  }

  /** @internal Renew every active lease owned by one worker in a single statement. */
  async heartbeatMany(
    tasks: readonly ClaimedTask[],
    workerId: string,
    leaseMs = 30_000,
  ): Promise<Map<string, HeartbeatStatus>> {
    return this.modules.claimLeaseFence.heartbeatMany(tasks, workerId, leaseMs);
  }

  async expireOwned(task: ClaimedTask, workerId: string): Promise<ExpireOwnedStatus> {
    return this.modules.claimLeaseFence.expireOwned(task, workerId);
  }

  async acknowledgeCancel(task: ClaimedTask, workerId: string): Promise<boolean> {
    return this.modules.claimLeaseFence.acknowledgeCancel(task, workerId);
  }

  async [workerCheckpointsRead]<TValue extends Json = Json>(
    taskId: string,
  ): Promise<TaskCheckpoint<TValue>[]> {
    return this.modules.checkpointsProgressWaits.listCheckpoints<TValue>(taskId);
  }

  async saveCheckpoint<TValue extends Json>(
    task: ClaimedTask,
    workerId: string,
    name: string,
    value: TValue,
  ): Promise<TaskCheckpoint<TValue>> {
    return this.modules.checkpointsProgressWaits.saveCheckpoint(task, workerId, name, value);
  }

  async [workerProgressRead]<TValue extends Json = Json>(
    taskId: string,
  ): Promise<TaskProgress<TValue> | null> {
    return this.modules.checkpointsProgressWaits.getProgress<TValue>(taskId);
  }

  async updateProgress<TValue extends Json>(
    task: ClaimedTask,
    workerId: string,
    value: TValue,
  ): Promise<TaskProgress<TValue>> {
    return this.modules.checkpointsProgressWaits.updateProgress(task, workerId, value);
  }

  async [workerWaitsRead](taskId: string): Promise<TaskWait[]> {
    return this.modules.checkpointsProgressWaits.listWaits(taskId);
  }

  async scheduleWait(
    task: ClaimedTask,
    workerId: string,
    name: string,
    request: ScheduleWaitRequest,
  ): Promise<ScheduleWaitResult> {
    return this.modules.checkpointsProgressWaits.scheduleWait(task, workerId, name, request);
  }

  async waitForSignal<TPayload extends Json = Json>(
    task: ClaimedTask,
    workerId: string,
    name: string,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForSignalResult<TPayload>> {
    return this.modules.signals.waitForSignal<TPayload>(task, workerId, name, options);
  }

  async sendSignal<TPayload extends Json>(
    taskId: string,
    name: string,
    payload: TPayload,
    request: SendSignalRequest,
  ): Promise<SignalDeliveryResult<TPayload>> {
    return this.modules.signals.sendSignal(taskId, name, payload, request);
  }

  async waitForHuman<TContext extends Json, TResult extends Json = Json>(
    task: ClaimedTask,
    workerId: string,
    name: string,
    context: TContext,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForHumanResult<TResult>> {
    return this.modules.humanWaits.waitForHuman<TContext, TResult>(
      task,
      workerId,
      name,
      context,
      options,
    );
  }

  async completeHumanWait<TResult extends Json>(
    taskId: string,
    name: string,
    result: TResult,
    request: CompleteHumanWaitRequest,
  ): Promise<HumanWaitCompletionResult<TResult>> {
    return this.modules.humanWaits.completeHumanWait(taskId, name, result, request);
  }

  async createChild<TPayload extends Json, TResult extends Json = Json>(
    parent: ClaimedTask,
    workerId: string,
    name: string,
    type: string,
    payload: TPayload,
    options: ChildTaskOptions = {},
  ): Promise<CreateChildResult<TResult>> {
    return this.modules.childTasks.createChild(parent, workerId, name, type, payload, options);
  }

  async createChildren<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedTask,
    workerId: string,
    children: readonly ChildTaskRequest[],
  ): Promise<CreateChildrenResult<ChildOutcomes<TResult>>> {
    return this.modules.childTasks.createChildren<TResult>(parent, workerId, children);
  }

  async createChildrenAll<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedTask,
    workerId: string,
    children: readonly ChildTaskRequest[],
  ): Promise<CreateChildrenResult<TResult>> {
    return this.modules.childTasks.createChildrenAll<TResult>(parent, workerId, children);
  }

  async complete<TResult extends Json>(
    task: ClaimedTask,
    workerId: string,
    result: TResult,
  ): Promise<boolean> {
    return this.modules.claimLeaseFence.complete(task, workerId, result, () =>
      this.modules.enqueueContracts.validateResult(task, result),
    );
  }

  /** Seed immutable JSON Schema contracts and the application-selected current versions. */
  async syncContracts(): Promise<void> {
    return this.modules.enqueueContracts.syncContracts();
  }

  async fail(
    task: ClaimedTask,
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
    return this.modules.claimLeaseFence.fail(task, workerId, error, retryDelayMs);
  }

  async recoverExpired(limit = 100, retryDelayMs?: number): Promise<number> {
    return this.modules.claimLeaseFence.recoverExpired(limit, retryDelayMs);
  }

  async health(): Promise<QueueHealth> {
    return this.modules.operatorReads.health();
  }

  /** Read the per-queue live pressure used by OpenTelemetry observable instruments. */
  async queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    return this.modules.operatorReads.queueMetricSnapshot();
  }
}

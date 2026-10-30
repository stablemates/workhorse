import { SQL_STATEMENTS } from "./queue/sql-catalogue.generated.js";
import type {
  ChildTaskOptions,
  ColdExportPolicyDefinition,
  ColdExportStatus,
  ChildOutcomes,
  ChildTaskRequest,
  CancellationRequest,
  CancelResult,
  BatchExecutionRecord,
  ClaimedTask,
  CompletionClaim,
  CompletionClaimResult,
  CreateChildResult,
  CreateChildrenResult,
  Budget,
  BudgetDefinition,
  BudgetStatus,
  ConcurrencyPolicy,
  ConcurrencyPolicyDefinition,
  RateLimitPolicy,
  RateLimitPolicyDefinition,
  RateLimitStatus,
  EnqueueOptions,
  EnqueueRequest,
  EnqueueResult,
  ExpireOwnedStatus,
  ReleaseOwnedStatus,
  SaveCheckpointOptions,
  TaskCheckpoint,
  TaskProgress,
  TaskWait,
  HeartbeatBatchStatus,
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
import type { BudgetMetricSnapshot, QueueMetricSnapshot } from "./telemetry.js";
import {
  listenerPoolMaxSize,
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
  budget,
  concurrencyPolicy,
  rateLimitPolicy,
  type BudgetRow,
  type ConcurrencyPolicyRow,
  type RateLimitPolicyRow,
} from "./queue/operator-reads.js";
import {
  CheckpointConflictError,
  CheckpointInputConflictError,
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
  maxAttemptsValue,
  validateEnqueueBatch,
  validateEnqueueOptions,
  validateQueueOptions,
  validateTaskPriority,
} from "./queue/enqueue-contracts.js";
import type {
  ScheduleCatchupPolicy,
  ScheduleDefinition,
  ScheduledTask,
  StoredSchedule,
} from "./queue/cron-schedules.js";
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
import {
  workerCheckpointsRead,
  workerCompletionPrepare,
  workerHeartbeatReservation,
  workerHeartbeatReservationProblem,
  workerStatementPoolCapacity,
  workerListenerPoolMaxSize,
  workerProgressRead,
  workerQueueTierRead,
  workerSchemaCheck,
  workerWaitsRead,
  type WorkerHeartbeatChannel,
} from "./worker-internal.js";
import {
  describePool,
  heartbeatReservationProblem,
  holdHeartbeatConnection,
} from "./heartbeat-connection.js";
import { statementPoolCapacity } from "./connection-pool.js";
import { FastTierUnsupportedError, SchemaCompatibilityError } from "./errors.js";
import { monotonicNow } from "./timers.js";
import { queryFencedWrite } from "./queue/fenced-write.js";
import { heartbeatLeaseBatches, reportHeartbeatStatuses } from "./queue/claim-lease-fence.js";
import type {
  TaskGroup,
  TaskGroupBlockResult,
  TaskGroupBuilder,
  TaskGroupCallbacks,
  TaskGroupLink,
  TaskGroupMemberPage,
  TaskGroupMemberQuery,
} from "./queue/task-groups.js";

export type { MaintenancePhase, MaintenancePhaseResult } from "./queue/retention-maintenance.js";

export {
  CheckpointConflictError,
  CheckpointInputConflictError,
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
export type { ScheduleCatchupPolicy, ScheduleDefinition, ScheduledTask, StoredSchedule };

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

  // Run the compatibility check through `database`, the connection of the call, unless the queue
  // has the answer. A schema the release cannot use then fails with `SchemaCompatibilityError`
  // before the first statement of the call.
  private checkSchema(database: Queryable = this.database): Promise<void> {
    return this.moduleState.compatibility.assert(database, "queue");
  }

  /** @internal */
  [workerSchemaCheck](): Promise<void> {
    return this.moduleState.compatibility.assert(this.database, "worker");
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
    // Refuse an invalid option before the compatibility check, so the refusal sends no statement.
    validateEnqueueOptions(options);
    await this.checkSchema(transaction);
    return this.modules.enqueueContracts.enqueue(type, payload, options, transaction);
  }

  async enqueueWithResult<TPayload extends Json>(
    type: string,
    payload: TPayload,
    options: EnqueueOptions = {},
    transaction: Queryable = this.database,
  ): Promise<EnqueueResult> {
    // Refuse an invalid option before the compatibility check, so the refusal sends no statement.
    validateEnqueueOptions(options);
    await this.checkSchema(transaction);
    return this.modules.enqueueContracts.enqueueWithResult(type, payload, options, transaction);
  }

  async enqueueMany(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<string[]> {
    // An empty batch sends no statement, so it needs no check. The options of every request are
    // checked before the compatibility check.
    validateEnqueueBatch(requests);
    if (requests.length > 0) await this.checkSchema(transaction);
    return this.modules.enqueueContracts.enqueueMany(requests, transaction);
  }

  async enqueueManyWithResults(
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<EnqueueResult[]> {
    // An empty batch sends no statement, so it needs no check. The options of every request are
    // checked before the compatibility check.
    validateEnqueueBatch(requests);
    if (requests.length > 0) await this.checkSchema(transaction);
    return this.modules.enqueueContracts.enqueueManyWithResults(requests, transaction);
  }

  /**
   * Create an open task group (ADR 0095). Add tasks with {@link addToTaskGroup}, then seal it with
   * {@link sealTaskGroup}. When the group is sealed and every member task is finished, Workhorse
   * enqueues the callbacks that the result selects.
   */
  async createTaskGroup(
    callbacks: TaskGroupCallbacks = {},
    transaction: Queryable = this.database,
  ): Promise<TaskGroup> {
    this.modules.taskGroups.validateCreate(callbacks);
    await this.checkSchema(transaction);
    return this.modules.taskGroups.create(callbacks, transaction);
  }

  /**
   * Create a task group, add the tasks that `build` collects, and seal the group, in one statement
   * and so in one transaction. A group with no tasks finishes at the seal.
   */
  async taskGroup(
    callbacks: TaskGroupCallbacks,
    build: (group: TaskGroupBuilder) => void | Promise<void>,
    transaction: Queryable = this.database,
  ): Promise<TaskGroupBlockResult> {
    // The group checks its callbacks and each added request before this compatibility check.
    return this.modules.taskGroups.createSealed(callbacks, build, transaction, () =>
      this.checkSchema(transaction),
    );
  }

  /**
   * Enqueue up to 1,000 tasks as members of an open group. A sealed group accepts tasks only from
   * a running member task, through its handler context.
   */
  async addToTaskGroup(
    groupId: string,
    requests: readonly EnqueueRequest[],
    transaction: Queryable = this.database,
  ): Promise<EnqueueResult[]> {
    this.modules.taskGroups.validateAdd(requests);
    await this.checkSchema(transaction);
    return this.modules.taskGroups.add(groupId, requests, transaction);
  }

  /** Add tasks to the group of a running member task, under that task's fenced lease. */
  async addToTaskGroupAsMember(
    task: ClaimedTask,
    workerId: string,
    requests: readonly EnqueueRequest[],
  ): Promise<EnqueueResult[]> {
    this.modules.taskGroups.validateAdd(requests);
    await this.checkSchema();
    return this.modules.taskGroups.addAsMember(task, workerId, requests);
  }

  /** Seal an open group. Sealing a sealed or finished group changes nothing. */
  async sealTaskGroup(groupId: string, transaction: Queryable = this.database): Promise<TaskGroup> {
    await this.checkSchema(transaction);
    return this.modules.taskGroups.seal(groupId, transaction);
  }

  async getTaskGroup(groupId: string): Promise<TaskGroup | null> {
    await this.checkSchema();
    return this.modules.taskGroups.get(groupId);
  }

  async listTaskGroupMembers(
    groupId: string,
    query: TaskGroupMemberQuery = {},
  ): Promise<TaskGroupMemberPage> {
    await this.checkSchema();
    return this.modules.taskGroups.listMembers(groupId, query);
  }

  /** The group a task is a member of, or whose callback the task is. */
  async findTaskGroup(taskId: string): Promise<TaskGroupLink | null> {
    await this.checkSchema();
    return this.modules.taskGroups.forTask(taskId);
  }

  async promote(limit = 100): Promise<number> {
    await this.checkSchema();
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
    await this.checkSchema();
    return this.modules.workerRegistry.registerWorker(registration);
  }

  /**
   * Remove one worker registration. A killed worker instead ages out of the fleet view.
   *
   * If `instanceId` is given, the row is removed only while it still names that instance, so a late
   * call for an ended run cannot remove the row of a later run. Without `instanceId`, the call is not
   * fenced: it removes the row by worker ID only, also when a later run registered that row.
   */
  async deregisterWorker(workerId: string, instanceId?: string): Promise<boolean> {
    await this.checkSchema();
    return this.modules.workerRegistry.deregisterWorker(workerId, instanceId);
  }

  /** Drop registrations whose process stopped heartbeating longer ago than the given window. */
  async pruneWorkerRegistry(maxAgeMs = 60_000): Promise<number> {
    await this.checkSchema();
    return this.modules.workerRegistry.pruneWorkerRegistry(maxAgeMs);
  }

  async tick(
    options: { promoteLimit?: number; recoverLimit?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.tick(options);
  }

  /**
   * Offer every database-coordinated slow maintenance phase in its required order.
   *
   * Without `now`, PostgreSQL uses its own clock at the start of the statement's transaction.
   * Pass `now` only to test or to repair at a fixed time. Inside a caller's transaction, the
   * default is the start time of that transaction.
   */
  async runMaintenance(options: { now?: Date } = {}): Promise<MaintenancePhaseResult[]> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.runMaintenance(options);
  }

  /** Without `now`, PostgreSQL uses its own clock. Pass `now` only to test or to repair. */
  async prepareHistoryPartitions(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    await this.checkSchema();
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
   *
   * Without `now`, PostgreSQL uses its own clock at the start of the statement's transaction.
   * Pass `now` only to test or to repair at a fixed time. Inside a caller's transaction, the
   * default is the start time of that transaction.
   */
  async rollupStatistics(
    options: { force?: boolean; now?: Date; maxBuckets?: number } = {},
  ): Promise<MaintenancePhaseResult[]> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.rollupStatistics(options);
  }

  /** Without `now`, PostgreSQL uses its own clock. Pass `now` only to test or to repair. */
  async retainHistory(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.retainHistory(options);
  }

  /** Without `now`, PostgreSQL uses its own clock. Pass `now` only to test or to repair. */
  async pruneTerminalStorage(
    options: { force?: boolean; now?: Date } = {},
  ): Promise<MaintenancePhaseResult[]> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.pruneTerminalStorage(options);
  }

  async syncRetentionPolicy(
    definition: RetentionPolicyDefinition,
    options: { force?: boolean } = {},
  ): Promise<RetentionPolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.syncRetentionPolicy(definition, options);
  }

  /**
   * Turn cold history export on or off. While it is on, history retention waits for every day no
   * completed export segment covers, so an exporter that falls behind, or one that was never run,
   * holds history rather than leaving the archive incomplete.
   */
  async setColdExportPolicy(definition: ColdExportPolicyDefinition): Promise<ColdExportStatus> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.setColdExportPolicy(definition);
  }

  async getColdExportStatus(): Promise<ColdExportStatus> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.getColdExportStatus();
  }

  async syncConcurrencyPolicies(
    namespace: string,
    definitions: readonly ConcurrencyPolicyDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<ConcurrencyPolicy[]> {
    await this.checkSchema();
    const input = definitions.map((definition) => ({
      queue: definition.queue,
      maxActive: definition.maxActive,
      maxActivePerKey: definition.maxActivePerKey ?? null,
    }));
    const result = await queryFencedWrite<ConcurrencyPolicyRow>(
      this.database,
      SQL_STATEMENTS["sync_concurrency_policies_v1"],
      [namespace, JSON.stringify(input), options.prune ?? true],
    );
    return result.rows.map(concurrencyPolicy);
  }

  async listConcurrencyPolicies(queueNames: readonly string[] = []): Promise<ConcurrencyPolicy[]> {
    await this.checkSchema();
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
    await this.checkSchema();
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
    await this.checkSchema();
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
    await this.checkSchema();
    return this.modules.operatorReads.rateLimitStatuses(queueNames);
  }

  async syncBudgets(
    namespace: string,
    definitions: readonly BudgetDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<Budget[]> {
    await this.checkSchema();
    const input = definitions.map((definition) => ({
      name: definition.name,
      maxActive: definition.maxActive ?? null,
      rate: definition.rate ?? null,
    }));
    const result = await this.database.query<BudgetRow>(SQL_STATEMENTS["sync_budgets_v1"], [
      namespace,
      JSON.stringify(input),
      options.prune ?? true,
    ]);
    return result.rows.map(budget);
  }

  async listBudgets(budgetNames: readonly string[] = []): Promise<Budget[]> {
    await this.checkSchema();
    const result = await this.database.query<BudgetRow>(SQL_STATEMENTS["list_budgets"], [
      budgetNames,
    ]);
    return result.rows.map(budget);
  }

  async budgetStatuses(budgetNames: readonly string[] = []): Promise<BudgetStatus[]> {
    await this.checkSchema();
    return this.modules.operatorReads.budgetStatuses(budgetNames);
  }

  async overrideRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
  ): Promise<RetentionPolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.overrideRetentionPolicy(definition);
  }

  async revertRetentionPolicy(
    settings: readonly RetentionPolicySetting[],
  ): Promise<RetentionPolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.revertRetentionPolicy(settings);
  }

  async previewRetentionPolicy(
    definition: Partial<RetentionPolicyDefinition>,
  ): Promise<RetentionPolicyImpact> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.previewRetentionPolicy(definition);
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.getRetentionPolicy();
  }

  async syncMaintenancePolicy(
    definition: MaintenancePolicyDefinition,
    options: { force?: boolean } = {},
  ): Promise<MaintenancePolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.syncMaintenancePolicy(definition, options);
  }

  async overrideMaintenancePolicy(
    definition: Partial<MaintenancePolicyDefinition>,
  ): Promise<MaintenancePolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.overrideMaintenancePolicy(definition);
  }

  async revertMaintenancePolicy(
    settings: readonly MaintenancePolicySetting[],
  ): Promise<MaintenancePolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.revertMaintenancePolicy(settings);
  }

  async getMaintenancePolicy(): Promise<MaintenancePolicy> {
    await this.checkSchema();
    return this.modules.retentionMaintenance.getMaintenancePolicy();
  }

  async syncSchedules(
    namespace: string,
    definitions: readonly ScheduleDefinition[],
    options: { prune?: boolean } = {},
  ): Promise<void> {
    // Refuse an invalid attempt limit or priority before the compatibility check, so the refusal
    // sends no statement.
    for (const definition of definitions) {
      maxAttemptsValue(definition.task.maxAttempts);
      validateTaskPriority(definition.task.priority);
    }
    await this.checkSchema();
    return this.modules.cronSchedules.syncSchedules(namespace, definitions, options);
  }

  async schedules(namespaces: readonly string[]): Promise<StoredSchedule[]> {
    await this.checkSchema();
    return this.modules.cronSchedules.schedules(namespaces);
  }

  async fireSchedule(
    namespace: string,
    name: string,
    revision: bigint,
    occurrenceAt: Date,
  ): Promise<string | null> {
    await this.checkSchema();
    return this.modules.cronSchedules.fireSchedule(namespace, name, revision, occurrenceAt);
  }

  async fireDueSchedules(
    namespaces: readonly string[],
    now: Date | null,
    catchupLimit: number,
    evaluationWindowMs: number,
  ): Promise<void> {
    await this.checkSchema();
    return this.modules.cronSchedules.fireDueSchedules(
      namespaces,
      now,
      catchupLimit,
      evaluationWindowMs,
    );
  }

  async cancel(taskId: string, request: CancellationRequest = {}): Promise<CancelResult> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.cancel(taskId, request);
  }

  async claim<TPayload extends Json = Json>(
    workerId: string,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload> | null> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.claim<TPayload>(workerId, options);
  }

  async claimMany<TPayload extends Json = Json>(
    workerId: string,
    limit: number,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload>[]> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.claimMany<TPayload>(workerId, limit, options);
  }

  /** @internal Persist the ordered membership chosen by a worker's batch coordinator. */
  async recordBatchDispatch(batch: BatchExecutionRecord): Promise<void> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.recordBatchDispatch(batch);
  }

  /** @internal Persist that the shared callback failed before returning per-member outcomes. */
  async recordBatchFailure(batch: BatchExecutionRecord): Promise<void> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.recordBatchFailure(batch);
  }

  async heartbeat(task: ClaimedTask, workerId: string, leaseMs = 30_000): Promise<boolean> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.heartbeat(task, workerId, leaseMs);
  }

  async heartbeatStatus(
    task: ClaimedTask,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<HeartbeatStatus> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.heartbeatStatus(task, workerId, leaseMs);
  }

  /**
   * Renew one lease without a wait for a row lock that another transaction holds.
   *
   * The result is a {@link HeartbeatStatus} or `busy`. `busy` means that another transaction
   * locks the row: Workhorse did not renew the lease and gives no ownership verdict. Call again
   * later. {@link Queue.heartbeat} and {@link Queue.heartbeatStatus} wait for the lock instead.
   */
  async tryHeartbeat(
    task: ClaimedTask,
    workerId: string,
    leaseMs = 30_000,
  ): Promise<HeartbeatBatchStatus> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.tryHeartbeat(task, workerId, leaseMs);
  }

  /** @internal Renew every active lease owned by one worker in a single statement. */
  async heartbeatMany(
    tasks: readonly ClaimedTask[],
    workerId: string,
    leaseMs = 30_000,
  ): Promise<Map<string, HeartbeatBatchStatus>> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.heartbeatMany(tasks, workerId, leaseMs);
  }

  async expireOwned(task: ClaimedTask, workerId: string): Promise<ExpireOwnedStatus> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.expireOwned(task, workerId);
  }

  /** Give an owned task back to its queue with its attempt intact. */
  async releaseOwned(task: ClaimedTask, workerId: string): Promise<ReleaseOwnedStatus> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.releaseOwned(task, workerId);
  }

  async acknowledgeCancel(task: ClaimedTask, workerId: string): Promise<boolean> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.acknowledgeCancel(task, workerId);
  }

  async [workerCheckpointsRead]<TValue extends Json = Json>(
    taskId: string,
  ): Promise<TaskCheckpoint<TValue>[]> {
    await this.checkSchema();
    return this.modules.checkpointsProgressWaits.listCheckpoints<TValue>(taskId);
  }

  async saveCheckpoint<TValue extends Json>(
    task: ClaimedTask,
    workerId: string,
    name: string,
    value: TValue,
    options: SaveCheckpointOptions = {},
  ): Promise<TaskCheckpoint<TValue>> {
    await this.checkSchema();
    return this.modules.checkpointsProgressWaits.saveCheckpoint(
      task,
      workerId,
      name,
      value,
      options,
    );
  }

  async [workerProgressRead]<TValue extends Json = Json>(
    taskId: string,
  ): Promise<TaskProgress<TValue> | null> {
    await this.checkSchema();
    return this.modules.checkpointsProgressWaits.getProgress<TValue>(taskId);
  }

  async updateProgress<TValue extends Json>(
    task: ClaimedTask,
    workerId: string,
    value: TValue,
  ): Promise<TaskProgress<TValue>> {
    await this.checkSchema();
    return this.modules.checkpointsProgressWaits.updateProgress(task, workerId, value);
  }

  async [workerWaitsRead](taskId: string): Promise<TaskWait[]> {
    await this.checkSchema();
    return this.modules.checkpointsProgressWaits.listWaits(taskId);
  }

  async scheduleWait(
    task: ClaimedTask,
    workerId: string,
    name: string,
    request: ScheduleWaitRequest,
  ): Promise<ScheduleWaitResult> {
    await this.checkSchema();
    return this.modules.checkpointsProgressWaits.scheduleWait(task, workerId, name, request);
  }

  async waitForSignal<TPayload extends Json = Json>(
    task: ClaimedTask,
    workerId: string,
    name: string,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForSignalResult<TPayload>> {
    await this.checkSchema();
    return this.modules.signals.waitForSignal<TPayload>(task, workerId, name, options);
  }

  async sendSignal<TPayload extends Json>(
    taskId: string,
    name: string,
    payload: TPayload,
    request: SendSignalRequest,
  ): Promise<SignalDeliveryResult<TPayload>> {
    await this.checkSchema();
    return this.modules.signals.sendSignal(taskId, name, payload, request);
  }

  async waitForHuman<TContext extends Json, TResult extends Json = Json>(
    task: ClaimedTask,
    workerId: string,
    name: string,
    context: TContext,
    options: ExternalWaitOptions = {},
  ): Promise<WaitForHumanResult<TResult>> {
    await this.checkSchema();
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
    await this.checkSchema();
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
    this.modules.childTasks.validateChild(workerId, name, options);
    await this.checkSchema();
    return this.modules.childTasks.createChild(parent, workerId, name, type, payload, options);
  }

  async createChildren<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedTask,
    workerId: string,
    children: readonly ChildTaskRequest[],
  ): Promise<CreateChildrenResult<ChildOutcomes<TResult>>> {
    this.modules.childTasks.validateChildren(parent, workerId, children);
    await this.checkSchema();
    return this.modules.childTasks.createChildren<TResult>(parent, workerId, children);
  }

  async createChildrenAll<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedTask,
    workerId: string,
    children: readonly ChildTaskRequest[],
  ): Promise<CreateChildrenResult<TResult>> {
    this.modules.childTasks.validateChildren(parent, workerId, children);
    await this.checkSchema();
    return this.modules.childTasks.createChildrenAll<TResult>(parent, workerId, children);
  }

  async complete<TResult extends Json>(
    task: ClaimedTask,
    workerId: string,
    result: TResult,
  ): Promise<boolean> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.complete(task, workerId, result, () =>
      this.modules.enqueueContracts.validateResult(task, result),
    );
  }

  /**
   * Completes a fast-tier attempt and claims up to `claim.limit` replacements from `claim.queue` in
   * the same round trip (ADR 0077). Rejects with `FastTierUnsupportedError` when that queue is
   * full-tier. Concurrent calls from one worker for one queue share one statement.
   */
  async completeAndClaim<TResult extends Json, TPayload extends Json = Json>(
    task: ClaimedTask,
    workerId: string,
    result: TResult,
    claim: CompletionClaim,
  ): Promise<CompletionClaimResult<TPayload>> {
    await this.checkSchema();
    const serialized = await this.modules.enqueueContracts.validateResult(task, result);
    return (await this.modules.claimLeaseFence.completeAndClaim(
      task,
      workerId,
      serialized,
      claim,
    )) as CompletionClaimResult<TPayload>;
  }

  /**
   * Claims up to `limit` tasks from a fast-tier queue. Rejects with `FastTierUnsupportedError` when
   * the queue is full-tier; `claimMany` claims from either tier.
   */
  async claimFast<TPayload extends Json = Json>(
    workerId: string,
    limit: number,
    options: { queue?: string; leaseMs?: number } = {},
  ): Promise<ClaimedTask<TPayload>[]> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.claimFast<TPayload>(workerId, limit, options);
  }

  async [workerQueueTierRead](queueName: string): Promise<boolean> {
    await this.checkSchema();
    return (await this.modules.queueAdministration.queueTier(queueName)) === "fast";
  }

  async [workerCompletionPrepare](
    task: ClaimedTask,
    workerId: string,
    result: Json,
  ): Promise<(claim?: CompletionClaim) => Promise<CompletionClaimResult>> {
    await this.checkSchema();
    const serialized = await this.modules.enqueueContracts.validateResult(task, result);
    const complete = async (): Promise<CompletionClaimResult> => ({
      accepted: await this.modules.claimLeaseFence.complete(
        task,
        workerId,
        result,
        async () => serialized,
      ),
      claimed: [],
    });
    return async (claim) => {
      if (claim === undefined) return complete();
      try {
        return await this.modules.claimLeaseFence.completeAndClaim(
          task,
          workerId,
          serialized,
          claim,
        );
      } catch (error) {
        // The queue left the fast tier after this worker last claimed from it. complete_v1 settles
        // an attempt on either tier.
        if (
          !(error instanceof FastTierUnsupportedError) ||
          error.feature !== "batched completion"
        ) {
          throw error;
        }
        return complete();
      }
    };
  }

  [workerHeartbeatReservationProblem](): string | undefined {
    return heartbeatReservationProblem(this.database);
  }

  [workerStatementPoolCapacity](): number | undefined {
    return statementPoolCapacity(this.database);
  }

  [workerListenerPoolMaxSize](): number | undefined {
    return listenerPoolMaxSize(this.database);
  }

  [workerHeartbeatReservation](heartbeatMs: number): WorkerHeartbeatChannel | undefined {
    const connection = holdHeartbeatConnection(this.database, heartbeatMs);
    if (connection === undefined) return undefined;
    const compatibility = this.moduleState.compatibility;
    return {
      pool: describePool(this.database),
      reserve: () => connection.reserve(),
      usable: () => connection.usable(),
      onReady: (listener) => connection.onReady(listener),
      ready: (timeoutMs, signal) => connection.ready(timeoutMs, signal),
      async checkReadiness(timeoutMs, signal) {
        const deadline = monotonicNow() + timeoutMs;
        if (!(await connection.ready(timeoutMs, signal))) {
          return signal?.aborted === true
            ? { step: "stopped" }
            : { step: "heartbeat", reason: "timeout" };
        }
        let borrowed: Awaited<ReturnType<typeof connection.borrow>>;
        try {
          borrowed = await connection.borrow(deadline - monotonicNow(), signal, (client) =>
            compatibility.assert(client, "worker"),
          );
        } catch (error) {
          // A schema verdict is not a connection budget problem, so it reaches the caller as is.
          if (error instanceof SchemaCompatibilityError) throw error;
          return { step: "ordinary", reason: "error", cause: error };
        }
        if (borrowed === "aborted") return { step: "stopped" };
        if (borrowed === "timeout") return { step: "ordinary", reason: "timeout" };
        return undefined;
      },
      // Every worker on the pool renews through one transaction for each round of the shared
      // connection, so this round sends its batches to the connection instead of statements.
      async heartbeatMany(tasks, workerId, leaseMs, timeoutMs) {
        if (tasks.length === 0) return new Map<string, HeartbeatBatchStatus>();
        const rows = await connection.renew(timeoutMs, () =>
          heartbeatLeaseBatches(tasks, leaseMs).map((leases) => ({ workerId, leases })),
        );
        const statuses = new Map<string, HeartbeatBatchStatus>(
          rows.map((row) => [row.task_id, row.status]),
        );
        reportHeartbeatStatuses(tasks, workerId, statuses);
        return statuses;
      },
      close: () => connection.close(),
    };
  }

  /** Seed immutable JSON Schema contracts and the application-selected current versions. */
  async syncContracts(): Promise<void> {
    await this.checkSchema();
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
    await this.checkSchema();
    return this.modules.claimLeaseFence.fail(task, workerId, error, retryDelayMs);
  }

  async recoverExpired(limit = 100, retryDelayMs?: number): Promise<number> {
    await this.checkSchema();
    return this.modules.claimLeaseFence.recoverExpired(limit, retryDelayMs);
  }

  async health(): Promise<QueueHealth> {
    await this.checkSchema();
    return this.modules.operatorReads.health();
  }

  /** Read the per-queue live pressure used by OpenTelemetry observable instruments. */
  async queueMetricSnapshot(): Promise<QueueMetricSnapshot[]> {
    await this.checkSchema();
    return this.modules.operatorReads.queueMetricSnapshot();
  }

  async budgetMetricSnapshot(): Promise<BudgetMetricSnapshot[]> {
    await this.checkSchema();
    return this.modules.operatorReads.budgetMetricSnapshot();
  }
}

import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { WorkhorseError } from "./errors.js";
import { Queue } from "./queue.js";
import { errorForTelemetry, type FailureStatus } from "./queue/claim-lease-fence.js";
import { ChildConflictError } from "./queue/child-jobs.js";
import { jitterDuration } from "./notifications.js";
import type { JobNotificationSubscription } from "./notifications.js";
import type {
  ScheduleWaitRequest,
  ScheduleWaitResult,
} from "./queue/checkpoints-progress-waits.js";
import type { ExternalWaitOptions } from "./queue/external-waits.js";
import type { WaitForSignalResult } from "./queue/signals.js";
import type { StoredSchedule } from "./queue/cron-schedules.js";
import type { MaintenancePhaseResult } from "./queue/retention-maintenance.js";
import {
  extractTraceContext,
  jobMetricAttributes,
  jobSpanAttributes,
  logDebug,
  logInfo,
  logWarn,
  recordHandlerExecution,
  recordMaintenanceMetrics,
  telemetryMetrics,
  type WorkhorseTelemetrySpan,
  withSpan,
  type JobExecutionOutcome,
} from "./telemetry.js";
import type {
  ChildJobOptions,
  ChildOutcomes,
  ChildJobRequest,
  BatchExecutionRecord,
  ClaimedJob,
  CreateChildResult,
  CreateChildrenResult,
  ExpireOwnedStatus,
  JobCheckpoint,
  JobProgress,
  JobWait,
  HeartbeatStatus,
  Json,
  WorkerRegistration,
} from "./types.js";
import { workerCheckpointsRead, workerProgressRead, workerWaitsRead } from "./worker-internal.js";

const DURABLE_WAIT_SUSPENSION = Symbol("workhorse.durableWaitSuspension");
const CHILD_JOB_SUSPENSION = Symbol("workhorse.childJobSuspension");
const DEFAULT_POLL_MS = 250;
const DEFAULT_NOTIFICATION_FALLBACK_POLL_MS = 5_000;
const MAX_EMPTY_POLL_MS = 5_000;
const NOTIFICATION_CLAIM_DELAY_MS = 50;

type AttemptOutcome =
  | "completed"
  | "failed"
  | "lease_expired"
  | "deadline_exceeded"
  | "attempt_timeout"
  | "cancelled"
  | "suspended_for_wait"
  | "suspended_for_child";

class AttemptOutcomeArbiter {
  private accepted: AttemptOutcome | undefined;

  get outcome(): AttemptOutcome | undefined {
    return this.accepted;
  }

  submit(outcome: AttemptOutcome): boolean {
    if (this.accepted !== undefined) return false;
    this.accepted = outcome;
    return true;
  }

  is(outcome: AttemptOutcome): boolean {
    return this.accepted === outcome;
  }

  isSuspended(): boolean {
    return this.is("suspended_for_wait") || this.is("suspended_for_child");
  }
}

/**
 * @internal Crash boundary a test or benchmark asks a worker to model process loss at. This is
 * test support, not application API: `stripInternal` keeps it out of the published declarations,
 * and the repository's own suites import it from `src/worker.ts`.
 */
export type Failpoint =
  | "afterClaim"
  | "beforeHandler"
  | "afterHandler"
  | "beforeComplete"
  | "afterComplete";
export interface HandlerContext<TPayload extends Json = Json> {
  job: ClaimedJob<TPayload>;
  signal: AbortSignal;
  /** Read a previously persisted restart boundary without executing user code. */
  getCheckpoint<TValue extends Json = Json>(name: string): Promise<JobCheckpoint<TValue> | null>;
  /** Read an immutable named durable wait from the current handler activation's snapshot. */
  getWait(name: string): Promise<JobWait | null>;
  /** Read the latest mutable progress observed by this handler activation. */
  getProgress<TValue extends Json = Json>(): Promise<JobProgress<TValue> | null>;
  /** Replace the latest mutable progress under the current fenced lease. */
  setProgress<TValue extends Json>(value: TValue): Promise<JobProgress<TValue>>;
  /**
   * Return the persisted value when this name already exists. Otherwise run the operation and
   * immutably persist its JSON result under the current fenced lease.
   */
  checkpoint<TValue extends Json>(
    name: string,
    operation: () => Promise<TValue> | TValue,
  ): Promise<TValue>;
  /** Suspend this job without consuming its logical attempt until the relative timer is due. */
  sleep(name: string, durationMs: number): Promise<void>;
  /** Suspend this job without consuming its logical attempt until the absolute target is due. */
  sleepUntil(name: string, wakeAt: Date): Promise<void>;
  /** Suspend until one idempotent external delivery supplies this named signal payload. */
  waitForSignal<TPayload extends Json = Json>(
    name: string,
    options?: ExternalWaitOptions,
  ): Promise<TPayload>;
  /** Suspend until an operator completes this named human decision with a bounded result. */
  waitForHuman<TContext extends Json, TResult extends Json = Json>(
    name: string,
    context: TContext,
    options?: ExternalWaitOptions,
  ): Promise<TResult>;
  /** Create or replay one named child and return its retained successful result after resumption. */
  runChild<TChildPayload extends Json, TResult extends Json = Json>(
    name: string,
    type: string,
    payload: TChildPayload,
    options?: ChildJobOptions,
  ): Promise<TResult>;
  /** Create or replay a bounded named child set and return every terminal outcome by name. */
  runChildren<TResult extends Record<string, Json> = Record<string, Json>>(
    children: readonly ChildJobRequest[],
  ): Promise<ChildOutcomes<TResult>>;
  /** Join a bounded child set only when every child succeeds. */
  runChildrenAll<TResult extends Record<string, Json> = Record<string, Json>>(
    children: readonly ChildJobRequest[],
  ): Promise<TResult>;
}

export type Handler<TPayload extends Json = Json, TResult extends Json = Json> = (
  payload: TPayload,
  context: HandlerContext<TPayload>,
) => Promise<TResult> | TResult;

/** Per-job batch context without APIs that suspend and replay an individual handler. */
export type BatchHandlerContext<TPayload extends Json = Json> = Omit<
  HandlerContext<TPayload>,
  | "sleep"
  | "sleepUntil"
  | "waitForSignal"
  | "waitForHuman"
  | "runChild"
  | "runChildren"
  | "runChildrenAll"
>;

/** One independently leased job delivered to a shared batch-handler invocation. */
export interface BatchHandlerItem<TPayload extends Json = Json> {
  payload: TPayload;
  context: BatchHandlerContext<TPayload>;
}

/** The handler result for one independently settled member of a batch. */
export type BatchHandlerOutcome<TResult extends Json = Json> =
  | { status: "succeeded"; result: TResult }
  | { status: "failed"; error: unknown };

/**
 * A compatible group of jobs from one queue and job type. Outcomes correspond by array position;
 * throwing or returning an invalid outcome list fails every member through its own fenced lifecycle.
 */
export type BatchHandler<TPayload extends Json = Json, TResult extends Json = Json> = (
  items: readonly BatchHandlerItem<TPayload>[],
) => Promise<readonly BatchHandlerOutcome<TResult>[]> | readonly BatchHandlerOutcome<TResult>[];

export interface BatchHandlerOptions {
  /** Maximum jobs delivered in one invocation. It cannot exceed the worker's job concurrency. */
  maxSize: number;
  /** Maximum time after the first member arrives before a partial batch dispatches. */
  lingerMs: number;
}

export type WorkerMaintenanceLoop = "tick" | "statistics_rollup" | "background_tasks";

export interface WorkerMaintenanceTelemetry extends MaintenancePhaseResult {
  loop: WorkerMaintenanceLoop;
  observedAt: string;
}

/**
 * The queue protocol consumed by {@link Worker}.
 *
 * This interface is the wire boundary for future Worker SDKs. An implementation may execute the
 * operations in-process or transport them to another runtime, but it must preserve their durable
 * claim, fence, cancellation, wait, maintenance, and worker-registration semantics. Notification
 * methods are an optional wake-up capability; implementations that omit them retain correct
 * dispatch through bounded polling.
 */
export interface WorkerQueueApi {
  readonly defaultQueue: string;
  supportsJobNotifications?(): boolean;
  subscribeToJobNotifications?(
    queueName: string,
    wake: () => void,
    error: (error: unknown) => void,
  ): Promise<JobNotificationSubscription | null>;
  claim(
    workerId: string,
    options?: { queue?: string; leaseMs?: number },
  ): Promise<ClaimedJob | null>;
  claimMany?(
    workerId: string,
    limit: number,
    options?: { queue?: string; leaseMs?: number },
  ): Promise<ClaimedJob[]>;
  recordBatchDispatch?(batch: BatchExecutionRecord): Promise<void>;
  recordBatchFailure?(batch: BatchExecutionRecord): Promise<void>;
  heartbeatStatus(job: ClaimedJob, workerId: string, leaseMs?: number): Promise<HeartbeatStatus>;
  heartbeatMany?(
    jobs: readonly ClaimedJob[],
    workerId: string,
    leaseMs?: number,
  ): Promise<Map<string, HeartbeatStatus>>;
  expireOwned(job: ClaimedJob, workerId: string): Promise<ExpireOwnedStatus>;
  acknowledgeCancel(job: ClaimedJob, workerId: string): Promise<boolean>;
  listCheckpoints(jobId: string): Promise<JobCheckpoint[]>;
  saveCheckpoint<TValue extends Json>(
    job: ClaimedJob,
    workerId: string,
    name: string,
    value: TValue,
  ): Promise<JobCheckpoint<TValue>>;
  getProgress(jobId: string): Promise<JobProgress | null>;
  updateProgress<TValue extends Json>(
    job: ClaimedJob,
    workerId: string,
    value: TValue,
  ): Promise<JobProgress<TValue>>;
  listWaits(jobId: string): Promise<JobWait[]>;
  scheduleWait(
    job: ClaimedJob,
    workerId: string,
    name: string,
    request: ScheduleWaitRequest,
  ): Promise<ScheduleWaitResult>;
  waitForSignal<TPayload extends Json = Json>(
    job: ClaimedJob,
    workerId: string,
    name: string,
    options?: ExternalWaitOptions,
  ): Promise<WaitForSignalResult<TPayload>>;
  waitForHuman<TContext extends Json, TResult extends Json = Json>(
    job: ClaimedJob,
    workerId: string,
    name: string,
    context: TContext,
    options?: ExternalWaitOptions,
  ): Promise<import("./queue/human-waits.js").WaitForHumanResult<TResult>>;
  createChild<TPayload extends Json, TResult extends Json = Json>(
    parent: ClaimedJob,
    workerId: string,
    name: string,
    type: string,
    payload: TPayload,
    options?: ChildJobOptions,
  ): Promise<CreateChildResult<TResult>>;
  createChildren<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedJob,
    workerId: string,
    children: readonly ChildJobRequest[],
  ): Promise<CreateChildrenResult<ChildOutcomes<TResult>>>;
  createChildrenAll<TResult extends Record<string, Json> = Record<string, Json>>(
    parent: ClaimedJob,
    workerId: string,
    children: readonly ChildJobRequest[],
  ): Promise<CreateChildrenResult<TResult>>;
  complete<TResult extends Json>(
    job: ClaimedJob,
    workerId: string,
    result: TResult,
  ): Promise<boolean>;
  fail(
    job: ClaimedJob,
    workerId: string,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<FailureStatus>;
  tick(options?: {
    promoteLimit?: number;
    recoverLimit?: number;
  }): Promise<MaintenancePhaseResult[]>;
  runMaintenance(options?: { now?: Date }): Promise<MaintenancePhaseResult[]>;
  schedules(namespaces: readonly string[]): Promise<StoredSchedule[]>;
  fireSchedule(
    namespace: string,
    name: string,
    revision: bigint,
    occurrenceAt: Date,
  ): Promise<string | null>;
  fireDueSchedules(namespaces: readonly string[], now: Date, catchupLimit: number): Promise<void>;
  registerWorker(registration: WorkerRegistration): Promise<{ paused: boolean }>;
  deregisterWorker(workerId: string): Promise<boolean>;
  pruneWorkerRegistry(maxAgeMs?: number): Promise<number>;
}

/** @internal Raised by an injected {@link Failpoint}, so it never reaches an application. */
export class InjectedCrashError extends WorkhorseError {
  constructor(readonly failpoint: Failpoint) {
    super(`Injected crash at ${failpoint}`);
    this.name = "InjectedCrashError";
  }
}

/** AbortSignal reason used when PostgreSQL reports a cancellation request for an owned job. */
export class CancellationRequestedError extends WorkhorseError {
  constructor(readonly jobId: string) {
    super(`Cancellation was requested for job ${jobId}`);
    this.name = "CancellationRequestedError";
  }
}

/** AbortSignal reason used when a job's immutable absolute deadline is reached. */
export class DeadlineExceededError extends WorkhorseError {
  constructor(readonly jobId: string) {
    super(`Deadline was exceeded for job ${jobId}`);
    this.name = "DeadlineExceededError";
  }
}

/** AbortSignal reason used when one logical attempt consumes its active execution budget. */
export class ExecutionTimeoutError extends WorkhorseError {
  constructor(
    readonly jobId: string,
    readonly attempt: number,
  ) {
    super(`Execution timeout was exceeded for job ${jobId} attempt ${attempt}`);
    this.name = "ExecutionTimeoutError";
  }
}

export interface WorkerOptions {
  /** Queue name used for claims. */
  queue?: string;
  /** Queue names used for claims. The worker rotates across them under one concurrency budget. */
  queues?: readonly string[];
  /**
   * Durable lease owner identity. It must be unique among simultaneously running workers.
   *
   * Defaults to `<hostname>-<pid>-<random>`. Set a stable value when you want a recognizable name
   * in operator views; nothing about correctness depends on stability, because operator pause is
   * scoped to a running process rather than to this name.
   */
  workerId?: string;
  /** Maximum number of jobs this worker may execute concurrently. */
  concurrency?: number;
  /** Ownership duration granted by claim and every accepted heartbeat. */
  leaseMs?: number;
  /** Local heartbeat interval. It must remain shorter than leaseMs. */
  heartbeatMs?: number;
  /**
   * Idle fallback polling delay. `run()` defaults to five seconds with notification support and
   * 250 milliseconds without it; `runOnce()` retains the 250-millisecond compatibility default.
   */
  pollMs?: number;
  /** Minimum delay between worker-owned maintenance and recurring schedule passes. */
  maintenanceIntervalMs?: number;
  /**
   * Minimum delay between checks for database-scheduled background maintenance tasks, including
   * the rolling-statistics rollup. Each task's real cadence is maintenance policy read from
   * PostgreSQL; this option only bounds how often this process offers to run them.
   */
  maintenanceTaskPollMs?: number;
  /**
   * Minimum delay between durable worker-registry refreshes.
   *
   * Each refresh publishes this worker's runtime state and reads back the operator-requested pause
   * flag, which is how an operator surface running in another process observes and controls a
   * worker it does not host. A pause therefore takes effect within roughly one interval, and is
   * cleared automatically if this process is replaced. Set to 0 to opt out of registration.
   */
  registryIntervalMs?: number;
  /**
   * Receives registration failures.
   *
   * Registration is not part of the dispatch contract, so a failure must never stop a worker from
   * claiming. It must not be invisible either: a worker that cannot register disappears from every
   * operator surface while continuing to run, which is indistinguishable from being dead.
   */
  onRegistrationError?: (error: unknown) => void;
  /** Receives LISTEN connection failures while durable fallback polling continues. */
  onNotificationError?: (error: unknown) => void;
  /** Receives one telemetry event for every SQL-owned maintenance phase. */
  onMaintenance?: (telemetry: WorkerMaintenanceTelemetry) => void;
  /** Namespaces whose enabled recurring schedules this worker should evaluate and fire. */
  scheduleNamespaces?: readonly string[];
  /** Maximum missed occurrences fired for one schedule in one maintenance pass. */
  scheduleCatchupLimit?: number;
  /** Override SQL-owned retry backoff, either fixed or derived from the attempt and claimed job. */
  /** Return undefined to defer to the job's persisted policy or SQL compatibility default. */
  retryDelayMs?: number | ((attempt: number, job: ClaimedJob) => number | undefined);
  /** @internal Test-only crash hook. Injected crashes deliberately bypass normal fail/retry handling. */
  failpoint?: Failpoint | ((point: Failpoint, job: ClaimedJob) => boolean | Promise<boolean>);
}

/**
 * Generate a readable, unique default worker identity.
 *
 * Host and pid make a worker recognizable in an operator fleet view, which a bare UUID does not:
 * "which pod is that" is the first question anyone asks about a busy worker. The random suffix
 * keeps two workers in one process distinct.
 *
 * This identity is deliberately unstable across restarts, because it owns leases and attempt
 * history and must never be reused by a concurrently running process. That costs nothing
 * operationally: an operator pause is scoped to a process incarnation, not to this name.
 */
function workerHostname(): string {
  return hostname().replaceAll(/[^\w.-]/g, "-") || "unknown-host";
}

function defaultWorkerId(): string {
  return `${workerHostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

export interface WorkerRuntimeState {
  concurrency: number;
  activeSlots: number;
  /** Effective pause: either a local `pause()` call or an operator pause recorded in PostgreSQL. */
  paused: boolean;
  /** True only for a local `pause()` call. */
  locallyPaused: boolean;
  /** True only for an operator pause read back from the durable worker registry. */
  remotelyPaused: boolean;
  draining: boolean;
}

function queueAsWorkerApi(queue: Queue): WorkerQueueApi {
  return new Proxy(queue, {
    get(target, property) {
      if (property === "listCheckpoints") return target[workerCheckpointsRead].bind(target);
      if (property === "getProgress") return target[workerProgressRead].bind(target);
      if (property === "listWaits") return target[workerWaitsRead].bind(target);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as WorkerQueueApi;
}

/**
 * Bounded-concurrency polling worker for the validation protocol.
 *
 * PostgreSQL SKIP LOCKED distributes ready rows between workers, while each instance claims only
 * enough jobs to fill its configured local execution slots.
 */
export class Worker {
  private readonly queue: WorkerQueueApi;
  private readonly handlers = new Map<string, Handler>();
  private readonly workerId: string;
  private readonly queueNames: readonly string[];
  private nextQueueIndex = 0;
  private get workerQueueAttributes(): { "workhorse.worker.queues": string[] } {
    return { "workhorse.worker.queues": [...this.queueNames] };
  }
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly dispatchPollMs: number;
  private readonly supportsNotifications: boolean;
  private readonly maintenanceIntervalMs: number;
  private readonly maintenanceTaskPollMs: number;
  private readonly registryIntervalMs: number;
  private readonly scheduleNamespaces: readonly string[];
  private readonly scheduleCatchupLimit: number;
  public readonly concurrency: number;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastMaintenanceTaskPollAt = Number.NEGATIVE_INFINITY;
  /**
   * Identifies this Worker instance to the durable registry.
   *
   * Generated once per object, so every restart or replacement of a worker id arrives as a new
   * incarnation. That is what lets PostgreSQL scope an operator pause to a running process instead
   * of leaving it attached to a name that a later deployment will reuse.
   */
  private readonly instanceId = randomUUID();
  private lastRegistryRefreshAt = Number.NEGATIVE_INFINITY;
  private registered = false;
  private pendingStopRegistrationRefresh: Promise<void> | undefined;
  private loggedRegistrationState:
    | { activeSlots: number; draining: boolean; paused: boolean }
    | undefined;
  private lastClaimAt = Number.NEGATIVE_INFINITY;
  private previousPassWorked = false;
  private readonly latestMaintenance = new Map<string, WorkerMaintenanceTelemetry>();
  private stopping = false;
  private locallyPaused = false;
  private remotelyPaused = false;
  private activeSlots = 0;
  private draining = false;
  private running = false;
  private stopVersion = 0;
  private executionTail: Promise<void> = Promise.resolve();
  /** Serializes only durable batch announcements; batch callbacks still execute concurrently. */
  private batchDispatchRecording: Promise<void> = Promise.resolve();
  private readonly heartbeatLeases = new Map<
    string,
    {
      job: ClaimedJob;
      status: (status: HeartbeatStatus) => void;
      error: (error: unknown) => void;
    }
  >();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  private scheduleHeartbeatBatch(): void {
    if (this.heartbeatTimer !== undefined || this.heartbeatLeases.size === 0) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      const leases = [...this.heartbeatLeases.values()];
      const heartbeat = this.queue.heartbeatMany
        ? this.queue.heartbeatMany(
            leases.map((lease) => lease.job),
            this.workerId,
            this.leaseMs,
          )
        : Promise.all(
            leases.map(
              async (lease) =>
                [
                  lease.job.id,
                  await this.queue.heartbeatStatus(lease.job, this.workerId, this.leaseMs),
                ] as const,
            ),
          ).then((statuses) => new Map(statuses));
      void heartbeat
        .then(
          (statuses) => {
            for (const lease of leases) {
              if (this.heartbeatLeases.get(lease.job.id) !== lease) continue;
              lease.status(statuses.get(lease.job.id) ?? "stale");
            }
          },
          (error: unknown) => {
            for (const lease of leases) {
              if (this.heartbeatLeases.get(lease.job.id) === lease) lease.error(error);
            }
          },
        )
        .finally(() => this.scheduleHeartbeatBatch());
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private addHeartbeatLease(
    job: ClaimedJob,
    status: (status: HeartbeatStatus) => void,
    error: (error: unknown) => void,
  ): () => void {
    const lease = { job, status, error };
    this.heartbeatLeases.set(job.id, lease);
    this.scheduleHeartbeatBatch();
    return () => {
      if (this.heartbeatLeases.get(job.id) === lease) this.heartbeatLeases.delete(job.id);
      if (this.heartbeatLeases.size === 0 && this.heartbeatTimer !== undefined) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
    };
  }
  private wakeController = new AbortController();
  private wakeVersion = 0;
  private dispatchWakeController = new AbortController();
  private dispatchWakeVersion = 0;
  private consecutiveEmptyClaims = 0;
  private notificationClaimDelayPending = false;
  private notificationSubscriptions: JobNotificationSubscription[] = [];

  constructor(
    queue: WorkerQueueApi | Queue,
    private readonly options: WorkerOptions = {},
  ) {
    this.queue = queue instanceof Queue ? queueAsWorkerApi(queue) : queue;
    this.workerId = options.workerId ?? defaultWorkerId();
    if (options.queue !== undefined && options.queues !== undefined) {
      throw new Error("queue and queues cannot be configured together");
    }
    const configuredQueues = options.queues ?? [options.queue ?? this.queue.defaultQueue];
    this.queueNames = [...new Set(configuredQueues)];
    if (
      this.queueNames.length === 0 ||
      this.queueNames.some((queueName) => typeof queueName !== "string" || queueName.length === 0)
    ) {
      throw new Error("queues must contain at least one non-empty queue name");
    }
    this.concurrency = options.concurrency ?? 1;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(this.leaseMs / 3));
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.supportsNotifications = this.queue.supportsJobNotifications?.() ?? false;
    this.dispatchPollMs =
      options.pollMs ??
      (this.supportsNotifications ? DEFAULT_NOTIFICATION_FALLBACK_POLL_MS : DEFAULT_POLL_MS);
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 1_000;
    this.maintenanceTaskPollMs = options.maintenanceTaskPollMs ?? 60_000;
    this.registryIntervalMs = options.registryIntervalMs ?? 5_000;
    this.scheduleNamespaces = [...new Set(options.scheduleNamespaces ?? [])];
    this.scheduleCatchupLimit = options.scheduleCatchupLimit ?? 100;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 100)
      throw new Error("concurrency must be a safe integer between 1 and 100");
    if (this.heartbeatMs >= this.leaseMs) throw new Error("heartbeatMs must be less than leaseMs");
    if (this.maintenanceIntervalMs < 100)
      throw new Error("maintenanceIntervalMs must be at least 100");
    if (this.maintenanceTaskPollMs < 100)
      throw new Error("maintenanceTaskPollMs must be at least 100");
    if (this.registryIntervalMs !== 0 && this.registryIntervalMs < 100)
      throw new Error("registryIntervalMs must be 0 or at least 100");
    if (this.scheduleCatchupLimit < 1 || this.scheduleCatchupLimit > 10_000)
      throw new Error("scheduleCatchupLimit must be between 1 and 10000");
  }

  handle<TPayload extends Json = Json, TResult extends Json = Json>(
    type: string,
    handler: Handler<TPayload, TResult>,
  ): this {
    this.handlers.set(type, handler as unknown as Handler);
    logDebug("workhorse.handler.registered", "Job handler registered", {
      "workhorse.job.type": type,
      "workhorse.worker.id": this.workerId,
    });
    return this;
  }

  handleBatch<TPayload extends Json = Json, TResult extends Json = Json>(
    type: string,
    options: BatchHandlerOptions,
    handler: BatchHandler<TPayload, TResult>,
  ): this {
    if (!Number.isSafeInteger(options.maxSize) || options.maxSize < 1 || options.maxSize > 100) {
      throw new Error("maxSize must be a safe integer between 1 and 100");
    }
    if (options.maxSize > this.concurrency) {
      throw new Error("maxSize must not exceed worker concurrency");
    }
    if (
      !Number.isSafeInteger(options.lingerMs) ||
      options.lingerMs < 0 ||
      options.lingerMs > 60_000
    ) {
      throw new Error("lingerMs must be a safe integer between 0 and 60000");
    }
    const maxSize = options.maxSize;
    const lingerMs = options.lingerMs;

    type PendingItem = {
      arrivalOrder: number;
      arrivedAt: number;
      priority: number;
      item: BatchHandlerItem<TPayload>;
      resolve: (result: TResult) => void;
      reject: (error: unknown) => void;
    };
    type PendingQueue = {
      items: PendingItem[];
      lingerTimer: ReturnType<typeof setTimeout> | undefined;
    };
    const pendingQueues = new Map<string, PendingQueue>();
    let nextArrival = 0;

    const dispatch = (queueName: string): void => {
      const pending = pendingQueues.get(queueName);
      if (!pending || pending.items.length === 0) return;
      if (pending.lingerTimer !== undefined) {
        clearTimeout(pending.lingerTimer);
        pending.lingerTimer = undefined;
      }
      const batch: PendingItem[] = [];
      for (const member of pending.items.splice(0, maxSize)) {
        const insertionIndex = batch.findIndex(
          (candidate) =>
            candidate.priority < member.priority ||
            (candidate.priority === member.priority &&
              candidate.arrivalOrder > member.arrivalOrder),
        );
        if (insertionIndex === -1) batch.push(member);
        else batch.splice(insertionIndex, 0, member);
      }
      const full = batch.length === maxSize;
      const batchId = randomUUID();
      const firstArrivedAt = Math.min(...batch.map((member) => member.arrivedAt));
      const actualLingerMs = Math.max(0, performance.now() - firstArrivedAt);
      const attributes = {
        "workhorse.queue.name": queueName,
        "workhorse.job.type": type,
        "workhorse.handler.batch.full": full,
      };
      telemetryMetrics.handlerBatchSize.record(batch.length, attributes);
      telemetryMetrics.handlerBatchLinger.record(actualLingerMs, attributes);
      logInfo("workhorse.handler.batch_dispatched", "Job batch dispatched", {
        ...attributes,
        "workhorse.handler.batch.size": batch.length,
        "workhorse.handler.batch.linger_ms": actualLingerMs,
        "workhorse.worker.id": this.workerId,
      });

      const batchRecord: BatchExecutionRecord = {
        batchId,
        jobs: batch.map(({ item }) => item.context.job),
        workerId: this.workerId,
      };
      const recordEvidence = async (
        phase: "dispatch" | "failure",
        operation: (() => Promise<void>) | undefined,
      ): Promise<void> => {
        if (operation === undefined) {
          logWarn(
            "workhorse.handler.batch_evidence_failed",
            "Batch execution evidence is not supported by the queue implementation",
            {
              ...attributes,
              "workhorse.handler.batch.size": batch.length,
              "workhorse.handler.batch.evidence_phase": phase,
              "workhorse.worker.id": this.workerId,
              "error.type": "UnsupportedOperation",
            },
          );
          return;
        }
        try {
          await operation();
        } catch (error) {
          logWarn(
            "workhorse.handler.batch_evidence_failed",
            "Batch execution evidence could not be persisted",
            {
              ...attributes,
              "workhorse.handler.batch.size": batch.length,
              "workhorse.handler.batch.evidence_phase": phase,
              "workhorse.worker.id": this.workerId,
              "error.type": error instanceof Error ? error.name : typeof error,
            },
          );
        }
      };
      const evidence = this.batchDispatchRecording.then(() =>
        recordEvidence(
          "dispatch",
          this.queue.recordBatchDispatch === undefined
            ? undefined
            : () => this.queue.recordBatchDispatch!(batchRecord),
        ),
      );
      const execution = evidence.then(() => {
        return handler(batch.map(({ item }) => item));
      });
      this.batchDispatchRecording = evidence.then(
        () => undefined,
        () => undefined,
      );
      void execution
        .then((outcomes) => {
          if (!Array.isArray(outcomes) || outcomes.length !== batch.length) {
            throw new Error(
              `Batch handler for ${type} returned ${Array.isArray(outcomes) ? outcomes.length : "a non-array value"} outcomes for ${batch.length} jobs`,
            );
          }
          const invalidIndex = outcomes.findIndex((outcome) => {
            if (typeof outcome !== "object" || outcome === null) return true;
            if (outcome.status === "succeeded") return !Object.hasOwn(outcome, "result");
            if (outcome.status === "failed") return !Object.hasOwn(outcome, "error");
            return true;
          });
          if (invalidIndex !== -1) {
            throw new Error(
              `Batch handler for ${type} returned an invalid outcome at index ${invalidIndex}`,
            );
          }
          for (const [index, member] of batch.entries()) {
            const outcome = outcomes[index]!;
            if (outcome.status === "succeeded") member.resolve(outcome.result);
            else member.reject(outcome.error);
          }
        })
        .catch(async (error: unknown) => {
          await recordEvidence(
            "failure",
            this.queue.recordBatchFailure === undefined
              ? undefined
              : () => this.queue.recordBatchFailure!(batchRecord),
          );
          for (const member of batch) member.reject(error);
        });
    };

    const adapter: Handler<TPayload, TResult> = (payload, context) =>
      new Promise<TResult>((resolve, reject) => {
        const queueName = context.job.queue;
        const pending = pendingQueues.get(queueName) ?? { items: [], lingerTimer: undefined };
        pendingQueues.set(queueName, pending);
        pending.items.push({
          arrivalOrder: nextArrival,
          arrivedAt: performance.now(),
          priority: context.job.priority,
          item: { payload, context },
          resolve,
          reject,
        });
        nextArrival += 1;
        if (pending.items.length >= maxSize || lingerMs === 0) {
          dispatch(queueName);
        } else if (pending.lingerTimer === undefined) {
          pending.lingerTimer = setTimeout(() => dispatch(queueName), lingerMs);
        }
      });

    this.handlers.set(type, adapter as unknown as Handler);
    logDebug("workhorse.handler.registered", "Batch job handler registered", {
      "workhorse.job.type": type,
      "workhorse.handler.batch.max_size": maxSize,
      "workhorse.handler.batch.linger_ms": lingerMs,
      "workhorse.worker.id": this.workerId,
    });
    return this;
  }

  stop(): void {
    this.stopVersion += 1;
    this.stopping = true;
    this.draining = this.running || this.activeSlots > 0;
    // The maintenance loop exits immediately on stop, so a draining worker would otherwise never
    // publish that state and would simply vanish from an operator's fleet view mid-drain.
    if (this.draining && this.registered) {
      const previousRefresh = this.pendingStopRegistrationRefresh ?? Promise.resolve();
      const pendingRefresh = previousRefresh.then(() => this.refreshRegistration(true));
      this.pendingStopRegistrationRefresh = pendingRefresh;
      void pendingRefresh.catch(() => undefined);
    }
    logInfo("workhorse.worker.stop_requested", "Worker stop requested", {
      ...this.workerQueueAttributes,
      "workhorse.worker.id": this.workerId,
      "workhorse.worker.active_slots": this.activeSlots,
    });
    this.wakeLoops();
  }

  /**
   * Effective pause state.
   *
   * A local `pause()` call and an operator pause recorded in PostgreSQL are independent. Either one
   * stops claims, and a local `resume()` cannot override an operator pause that is still in effect.
   */
  private get paused(): boolean {
    return this.locallyPaused || this.remotelyPaused;
  }

  /** Stop claiming new jobs while leaving maintenance and any in-flight handler running. */
  pause(): void {
    this.locallyPaused = true;
    logInfo("workhorse.worker.paused", "Worker paused locally", {
      ...this.workerQueueAttributes,
      "workhorse.worker.id": this.workerId,
    });
    this.wakeLoops();
  }

  /** Resume claims immediately instead of waiting for the previous idle poll deadline. */
  resume(): void {
    this.locallyPaused = false;
    this.previousPassWorked = false;
    this.lastClaimAt = Number.NEGATIVE_INFINITY;
    logInfo("workhorse.worker.resumed", "Worker resumed locally", {
      ...this.workerQueueAttributes,
      "workhorse.worker.id": this.workerId,
    });
    this.wakeLoops();
  }

  isPaused(): boolean {
    return this.paused;
  }

  runtimeState(): WorkerRuntimeState {
    return {
      concurrency: this.concurrency,
      activeSlots: this.activeSlots,
      paused: this.paused,
      locallyPaused: this.locallyPaused,
      remotelyPaused: this.remotelyPaused,
      draining: this.draining,
    };
  }

  /** Stable durable identity used for leases, attempt history, and fleet registration. */
  get id(): string {
    return this.workerId;
  }

  maintenanceTelemetry(): WorkerMaintenanceTelemetry[] {
    return [...this.latestMaintenance.values()];
  }

  private async inject(point: Failpoint, job: ClaimedJob): Promise<void> {
    const configured = this.options.failpoint;
    const shouldCrash =
      typeof configured === "function" ? await configured(point, job) : configured === point;
    if (shouldCrash) throw new InjectedCrashError(point);
  }

  runOnce(): Promise<boolean> {
    return this.withExclusiveExecution(() => this.runBatch(true));
  }

  private async claimNextMany(limit: number): Promise<ClaimedJob[]> {
    const jobs: ClaimedJob[] = [];
    if (!this.queue.claimMany) {
      let emptyQueues = 0;
      while (jobs.length < limit && emptyQueues < this.queueNames.length) {
        const queueName = this.queueNames[this.nextQueueIndex]!;
        this.nextQueueIndex = (this.nextQueueIndex + 1) % this.queueNames.length;
        const job = await this.queue.claim(this.workerId, {
          queue: queueName,
          leaseMs: this.leaseMs,
        });
        if (job) {
          jobs.push(job);
          emptyQueues = 0;
        } else {
          emptyQueues += 1;
        }
      }
      return jobs;
    }
    for (let checked = 0; checked < this.queueNames.length && jobs.length < limit; checked += 1) {
      const queueName = this.queueNames[this.nextQueueIndex]!;
      this.nextQueueIndex = (this.nextQueueIndex + 1) % this.queueNames.length;
      const remaining = limit - jobs.length;
      jobs.push(
        ...(await this.queue.claimMany(this.workerId, remaining, {
          queue: queueName,
          leaseMs: this.leaseMs,
        })),
      );
    }
    return jobs;
  }

  private async claimNext(): Promise<ClaimedJob | null> {
    return (await this.claimNextMany(1))[0] ?? null;
  }

  private async runBatch(
    includeMaintenance: boolean,
    shouldStop: () => boolean = () => this.stopping,
  ): Promise<boolean> {
    if (includeMaintenance) await this.runMaintenance();
    if (shouldStop() || this.paused) return false;
    const nowMs = Date.now();
    if (!this.previousPassWorked && nowMs - this.lastClaimAt < this.pollMs) return false;

    this.lastClaimAt = nowMs;
    const executions: Array<Promise<PromiseSettledResult<void>>> = [];
    let claimError: unknown;
    let claimFailed = false;
    const freeSlots = this.concurrency - this.activeSlots;
    if (!shouldStop() && !this.paused && freeSlots > 0) {
      try {
        const jobs = await this.claimNextMany(freeSlots);
        executions.push(...jobs.map((job) => this.startExecution(job)));
      } catch (error) {
        claimError = error;
        claimFailed = true;
      }
    }

    const claimed = executions.length > 0;
    this.previousPassWorked = claimed;
    const settlements = await Promise.all(executions);
    const firstFailure = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );
    if (firstFailure) throw firstFailure.reason;
    if (claimFailed) throw claimError;
    return claimed;
  }

  private startExecution(job: ClaimedJob): Promise<PromiseSettledResult<void>> {
    this.activeSlots += 1;
    return this.executeJob(job)
      .then<PromiseSettledResult<void>, PromiseSettledResult<void>>(
        () => ({ status: "fulfilled", value: undefined }),
        (reason: unknown) => ({ status: "rejected", reason }),
      )
      .finally(() => {
        this.activeSlots -= 1;
        if (!this.running && this.activeSlots === 0) this.draining = false;
      });
  }

  private async executeJob(job: ClaimedJob): Promise<void> {
    const startedAt = performance.now();
    // executeJobWithinSpan records the outcome here so one handler-duration histogram carries it.
    // A second duration instrument dimensioned by outcome would double-count every activation.
    const activation: { outcome: JobExecutionOutcome } = { outcome: "unknown" };
    return withSpan(
      "workhorse.handler",
      {
        "workhorse.queue.name": job.queue,
        ...jobSpanAttributes(job),
      },
      async (span) => {
        logDebug("workhorse.handler.started", "Job handler started", {
          ...jobSpanAttributes(job),
          "workhorse.queue.name": job.queue,
          "workhorse.worker.id": this.workerId,
        });
        try {
          await this.executeJobWithinSpan(job, span, activation);
        } finally {
          const durationMs = performance.now() - startedAt;
          const attributes = jobMetricAttributes(job);
          telemetryMetrics.handlerDuration.record(durationMs, {
            ...attributes,
            "workhorse.handler.outcome": activation.outcome,
          });
          telemetryMetrics.handlerRuntime.add(durationMs, attributes);
          logDebug("workhorse.handler.finished", "Job handler finished", {
            ...jobSpanAttributes(job),
            "workhorse.queue.name": job.queue,
            "workhorse.worker.id": this.workerId,
            "workhorse.handler.duration_ms": durationMs,
          });
        }
      },
      extractTraceContext(job.traceContext),
      "consumer",
    );
  }

  private async executeJobWithinSpan(
    job: ClaimedJob,
    span: WorkhorseTelemetrySpan,
    activation: { outcome: JobExecutionOutcome },
  ): Promise<void> {
    // afterClaim is outside the committed claim transaction. Throwing here leaves the lease exactly
    // as a killed process would, which allows deterministic expiry-recovery testing.
    const recordExecution = (outcome: JobExecutionOutcome): void => {
      if (activation.outcome !== "unknown") return;
      activation.outcome = outcome;
      recordHandlerExecution(job.queue, job.type, outcome);
      logInfo("workhorse.job.execution_finished", "Job execution finished", {
        ...jobSpanAttributes(job),
        "workhorse.queue.name": job.queue,
        "workhorse.worker.id": this.workerId,
        "workhorse.handler.outcome": outcome,
      });
    };
    const recordFailure = (state: Awaited<ReturnType<WorkerQueueApi["fail"]>>): void => {
      if (state === "ready" || state === "scheduled") {
        if (arbiter.submit("failed")) recordExecution("retry");
      } else if (state === "failed") {
        if (arbiter.submit("failed")) recordExecution("failed");
      } else if (state === "deadline_exceeded") {
        if (arbiter.submit("deadline_exceeded")) recordExecution("deadline_exceeded");
      } else if (state === "timeout_exceeded") {
        if (arbiter.submit("attempt_timeout")) recordExecution("timeout");
      } else if (state === "stale") {
        if (arbiter.submit("lease_expired")) recordExecution("lease_lost");
      }
    };
    const controller = new AbortController();
    const arbiter = new AttemptOutcomeArbiter();
    const suspend = (outcome: "suspended_for_wait" | "suspended_for_child"): never => {
      const reason =
        outcome === "suspended_for_wait" ? DURABLE_WAIT_SUSPENSION : CHILD_JOB_SUSPENSION;
      if (arbiter.submit(outcome)) controller.abort(reason);
      throw reason;
    };
    let expirationTimer: NodeJS.Timeout | undefined;
    let expirationPromise: Promise<ExpireOwnedStatus> | undefined;
    let heartbeatStopped = false;
    let removeHeartbeatLease: (() => void) | undefined;
    const stopHeartbeat = (): void => {
      heartbeatStopped = true;
      removeHeartbeatLease?.();
      if (expirationTimer) {
        clearTimeout(expirationTimer);
        expirationTimer = undefined;
      }
    };
    const markCancellationRequested = (): void => {
      arbiter.submit("cancelled");
      stopHeartbeat();
      if (!controller.signal.aborted) controller.abort(new CancellationRequestedError(job.id));
    };
    const acknowledgeCancellation = async (): Promise<boolean> => {
      const accepted = await this.queue.acknowledgeCancel(job, this.workerId);
      if (accepted && arbiter.is("cancelled")) recordExecution("canceled");
      return accepted;
    };
    const expireOwnership = (): Promise<ExpireOwnedStatus> => {
      expirationPromise ??= this.queue.expireOwned(job, this.workerId).then((status) => {
        if (status === "cancel_requested") markCancellationRequested();
        else if (status === "deadline_exceeded") arbiter.submit("deadline_exceeded");
        else if (status === "timeout_exceeded") arbiter.submit("attempt_timeout");
        else if (status === "stale") arbiter.submit("lease_expired");
        return status;
      });
      return expirationPromise;
    };
    const expireOwnershipInBackground = (): void => {
      // Observe the memoized promise without replacing it: the settlement path still awaits the
      // original rejection, while a handler that ignores abort cannot cause an unhandled rejection.
      void expireOwnership().catch((error: unknown) => controller.abort(error));
    };
    const refreshOwnership = (status: HeartbeatStatus): void => {
      if (status === "cancel_requested") {
        markCancellationRequested();
      } else if (status === "deadline_exceeded") {
        stopHeartbeat();
        expireOwnershipInBackground();
        if (!controller.signal.aborted) controller.abort(new DeadlineExceededError(job.id));
      } else if (status === "timeout_exceeded") {
        stopHeartbeat();
        expireOwnershipInBackground();
        if (!controller.signal.aborted)
          controller.abort(new ExecutionTimeoutError(job.id, job.attempt));
      } else if (status === "stale") {
        arbiter.submit("lease_expired");
        stopHeartbeat();
        if (!controller.signal.aborted) controller.abort(new Error("Job lease was lost"));
      }
    };
    const expirationAt = [job.deadlineAt, job.attemptTimeoutAt].reduce<Date | null>(
      (earliest, candidate) =>
        candidate !== null && (earliest === null || candidate < earliest) ? candidate : earliest,
      null,
    );
    if (expirationAt) {
      expirationTimer = setTimeout(
        () => {
          expirationTimer = undefined;
          const isDeadline =
            job.deadlineAt !== null &&
            (job.attemptTimeoutAt === null || job.deadlineAt <= job.attemptTimeoutAt);
          if (isDeadline) {
            if (!controller.signal.aborted) controller.abort(new DeadlineExceededError(job.id));
          } else {
            if (!controller.signal.aborted)
              controller.abort(new ExecutionTimeoutError(job.id, job.attempt));
          }
          stopHeartbeat();
          expireOwnershipInBackground();
        },
        // The extra millisecond keeps the timer from leading the database clock: expirationAt was
        // truncated to milliseconds on the way to the client, so firing at it exactly can precede
        // the stored microsecond value and earn a not_due answer from expiration.
        Math.max(0, expirationAt.getTime() + 1 - Date.now()),
      );
      expirationTimer.unref();
    }
    removeHeartbeatLease = this.addHeartbeatLease(job, refreshOwnership, (error) => {
      if (heartbeatStopped) return;
      stopHeartbeat();
      controller.abort(error);
    });

    try {
      await this.inject("afterClaim", job);
      const handler = this.handlers.get(job.type);
      if (!handler) {
        const error = new Error(`No handler registered for ${job.type}`);
        span.recordException(error);
        span.setStatus("error");
        const failed = await this.queue.fail(job, this.workerId, error);
        span.setAttribute("workhorse.handler.outcome", failed);
        if (failed === "cancel_requested") {
          markCancellationRequested();
          await acknowledgeCancellation();
        } else recordFailure(failed);
        return;
      }
      await this.inject("beforeHandler", job);
      let checkpoints: Map<string, JobCheckpoint> | undefined;
      let checkpointsLoad: Promise<Map<string, JobCheckpoint>> | undefined;
      const loadCheckpoints = (): Promise<Map<string, JobCheckpoint>> => {
        checkpointsLoad ??= this.queue.listCheckpoints(job.id).then((items) => {
          checkpoints = new Map(items.map((item) => [item.name, item]));
          return checkpoints;
        });
        return checkpointsLoad;
      };
      let waits: Map<string, JobWait> | undefined;
      let waitsLoad: Promise<Map<string, JobWait>> | undefined;
      const loadWaits = (): Promise<Map<string, JobWait>> => {
        waitsLoad ??= this.queue.listWaits(job.id).then((items) => {
          waits = new Map(items.map((item) => [item.name, item]));
          return waits;
        });
        return waitsLoad;
      };
      // No database transaction or row lock spans this call. Handlers are at least once and must
      // use external idempotency for effects that cannot safely repeat.
      const getCheckpoint: HandlerContext["getCheckpoint"] = async <TValue extends Json>(
        name: string,
      ) => ((await loadCheckpoints()).get(name) as JobCheckpoint<TValue> | undefined) ?? null;
      const getWait: HandlerContext["getWait"] = async (name: string) =>
        (await loadWaits()).get(name) ?? null;
      let progressLoad: Promise<JobProgress | null> | undefined;
      const getProgress: HandlerContext["getProgress"] = async <TValue extends Json>() => {
        progressLoad ??= this.queue.getProgress(job.id);
        return (await progressLoad) as JobProgress<TValue> | null;
      };
      const setProgress: HandlerContext["setProgress"] = async <TValue extends Json>(
        value: TValue,
      ) => {
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new Error("Job lease was lost");
        }
        const updated = await this.queue.updateProgress(job, this.workerId, value);
        progressLoad = Promise.resolve(updated);
        return updated;
      };
      const inFlightCheckpoints = new Map<string, Promise<Json>>();
      const checkpoint: HandlerContext["checkpoint"] = async <TValue extends Json>(
        name: string,
        operation: () => Promise<TValue> | TValue,
      ): Promise<TValue> => {
        const pending = inFlightCheckpoints.get(name);
        if (pending) return (await pending) as TValue;
        const execution = (async (): Promise<TValue> => {
          const checkpointCache = await loadCheckpoints();
          const existing = checkpointCache.get(name) as JobCheckpoint<TValue> | undefined;
          if (existing) return existing.value;
          if (controller.signal.aborted)
            throw controller.signal.reason ?? new Error("Job lease was lost");
          const value = await operation();
          const saved = await this.queue.saveCheckpoint(job, this.workerId, name, value);
          checkpointCache.set(name, saved);
          return saved.value;
        })();
        inFlightCheckpoints.set(name, execution);
        try {
          return await execution;
        } finally {
          if (inFlightCheckpoints.get(name) === execution) inFlightCheckpoints.delete(name);
        }
      };
      const inFlightWaits = new Map<string, Promise<void>>();
      const scheduleWait = (
        name: string,
        request: { durationMs: number } | { wakeAt: Date },
      ): Promise<void> => {
        const pending = inFlightWaits.get(name);
        if (pending) return pending;
        const execution = (async () => {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("Job lease was lost");
          }
          const scheduled = await this.queue.scheduleWait(job, this.workerId, name, request);
          waits?.set(name, scheduled.wait);
          if (scheduled.status === "scheduled" && arbiter.submit("suspended_for_wait")) {
            controller.abort(DURABLE_WAIT_SUSPENSION);
            throw DURABLE_WAIT_SUSPENSION;
          }
        })();
        inFlightWaits.set(name, execution);
        void execution
          .finally(() => {
            if (inFlightWaits.get(name) === execution) inFlightWaits.delete(name);
          })
          .catch(() => undefined);
        return execution;
      };
      const durableSleep: HandlerContext["sleep"] = (name, durationMs) =>
        scheduleWait(name, { durationMs });
      const sleepUntil: HandlerContext["sleepUntil"] = (name, wakeAt) =>
        scheduleWait(name, { wakeAt });
      const inFlightSignals = new Map<string, Promise<Json>>();
      const waitForSignal: HandlerContext["waitForSignal"] = async <TPayload extends Json>(
        name: string,
        options: ExternalWaitOptions = {},
      ): Promise<TPayload> => {
        const pending = inFlightSignals.get(name);
        if (pending) return (await pending) as TPayload;
        const execution = (async (): Promise<TPayload> => {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("Job lease was lost");
          }
          const signal = await this.queue.waitForSignal<TPayload>(
            job,
            this.workerId,
            name,
            options,
          );
          if (signal.status === "waiting") {
            suspend("suspended_for_wait");
          }
          return signal.payload as TPayload;
        })();
        inFlightSignals.set(name, execution);
        try {
          return await execution;
        } finally {
          if (inFlightSignals.get(name) === execution) inFlightSignals.delete(name);
        }
      };
      const inFlightHumanWaits = new Map<string, { context: Json; execution: Promise<Json> }>();
      const waitForHuman: HandlerContext["waitForHuman"] = async <
        TContext extends Json,
        TResult extends Json = Json,
      >(
        name: string,
        context: TContext,
        options: ExternalWaitOptions = {},
      ): Promise<TResult> => {
        const pending = inFlightHumanWaits.get(name);
        if (pending) {
          if (JSON.stringify(pending.context) !== JSON.stringify(context)) {
            throw new Error(`Human wait ${name} is already in flight with different context`);
          }
          return (await pending.execution) as TResult;
        }
        const execution = (async (): Promise<TResult> => {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("Job lease was lost");
          }
          const token = await this.queue.waitForHuman<TContext, TResult>(
            job,
            this.workerId,
            name,
            context,
            options,
          );
          if (token.status === "waiting") {
            suspend("suspended_for_wait");
          }
          return token.payload as TResult;
        })();
        inFlightHumanWaits.set(name, { context, execution });
        try {
          return await execution;
        } finally {
          const currentWait = inFlightHumanWaits.get(name);
          if (currentWait?.execution === execution) inFlightHumanWaits.delete(name);
        }
      };
      const inFlightChildren = new Map<string, { request: unknown; execution: Promise<Json> }>();
      const runChild: HandlerContext["runChild"] = <
        TChildPayload extends Json,
        TResult extends Json = Json,
      >(
        name: string,
        type: string,
        payload: TChildPayload,
        options?: ChildJobOptions,
      ): Promise<TResult> => {
        const request = structuredClone({ type, payload, options: options ?? {} });
        const pending = inFlightChildren.get(name);
        if (pending) {
          if (!isDeepStrictEqual(pending.request, request)) {
            return Promise.reject(new ChildConflictError(job.id, name));
          }
          return pending.execution as Promise<TResult>;
        }
        const execution = (async (): Promise<TResult> => {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("Job lease was lost");
          }
          const processed = await this.queue.createChild<TChildPayload, TResult>(
            job,
            this.workerId,
            name,
            type,
            payload,
            options,
          );
          if (processed.status === "created") {
            suspend("suspended_for_child");
          }
          return processed.child.result as TResult;
        })();
        inFlightChildren.set(name, { request, execution: execution as Promise<Json> });
        void execution
          .finally(() => {
            if (inFlightChildren.get(name)?.execution === execution) inFlightChildren.delete(name);
          })
          .catch(() => undefined);
        return execution;
      };
      let inFlightChildSet:
        | { request: unknown; execution: Promise<Record<string, Json>> }
        | undefined;
      const runChildSet = <TJoined extends Record<string, Json>>(
        children: readonly ChildJobRequest[],
        mode: "settled" | "all_success",
      ): Promise<TJoined> => {
        const request = { children: structuredClone(children), mode };
        if (inFlightChildSet) {
          if (!isDeepStrictEqual(inFlightChildSet.request, request)) {
            return Promise.reject(new ChildConflictError(job.id, "child set"));
          }
          return inFlightChildSet.execution as Promise<TJoined>;
        }
        const execution = (async (): Promise<TJoined> => {
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("Job lease was lost");
          }
          const processed =
            mode === "settled"
              ? await this.queue.createChildren(job, this.workerId, children)
              : await this.queue.createChildrenAll(job, this.workerId, children);
          if (processed.status === "created") {
            return suspend("suspended_for_child");
          }
          return processed.results as TJoined;
        })();
        inFlightChildSet = { request, execution: execution as Promise<Record<string, Json>> };
        void execution
          .finally(() => {
            if (inFlightChildSet?.execution === execution) inFlightChildSet = undefined;
          })
          .catch(() => undefined);
        return execution;
      };
      const runChildren: HandlerContext["runChildren"] = (children) =>
        runChildSet(children, "settled");
      const runChildrenAll: HandlerContext["runChildrenAll"] = (children) =>
        runChildSet(children, "all_success");
      const result = await handler(job.payload, {
        job,
        signal: controller.signal,
        getCheckpoint,
        getWait,
        getProgress,
        setProgress,
        checkpoint,
        sleep: durableSleep,
        sleepUntil,
        waitForSignal,
        waitForHuman,
        runChild,
        runChildren,
        runChildrenAll,
      });
      await this.inject("afterHandler", job);
      if (arbiter.isSuspended()) {
        logWarn("workhorse.handler.signal_swallowed", "Job handler swallowed its abort signal", {
          ...jobSpanAttributes(job),
          "workhorse.queue.name": job.queue,
          "workhorse.worker.id": this.workerId,
          "workhorse.handler.outcome": "suspended",
        });
        span.setAttribute("workhorse.handler.outcome", "suspended");
        recordExecution("suspended");
        return;
      }
      if (arbiter.is("cancelled")) {
        await acknowledgeCancellation();
        span.setAttribute("workhorse.handler.outcome", "canceled");
        return;
      }
      if (arbiter.is("lease_expired")) {
        span.setAttribute("workhorse.handler.outcome", "stale");
        recordExecution("lease_lost");
        return;
      }
      if (controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Job lease was lost");
      await this.inject("beforeComplete", job);
      const accepted = await this.queue.complete(job, this.workerId, result);
      if (!accepted) {
        if (await acknowledgeCancellation()) {
          span.setAttribute("workhorse.handler.outcome", "canceled");
          return;
        }
        throw new Error("Completion rejected because the lease is stale or expired");
      }
      if (!arbiter.submit("completed")) return;
      span.setAttribute("workhorse.handler.outcome", "succeeded");
      recordExecution("succeeded");
      await this.inject("afterComplete", job);
    } catch (error) {
      if (arbiter.isSuspended()) {
        span.setAttribute("workhorse.handler.outcome", "suspended");
        recordExecution("suspended");
        return;
      }
      // A crash failpoint models process disappearance, so converting it into fail_v1 would produce
      // the wrong durable state. Ordinary handler errors do close and retry the attempt.
      if (error instanceof InjectedCrashError) throw error;
      if (
        arbiter.is("cancelled") ||
        error instanceof CancellationRequestedError ||
        controller.signal.reason instanceof CancellationRequestedError
      ) {
        arbiter.submit("cancelled");
        await acknowledgeCancellation();
        span.setAttribute("workhorse.handler.outcome", "canceled");
        return;
      }
      if (
        arbiter.is("deadline_exceeded") ||
        arbiter.is("attempt_timeout") ||
        error instanceof DeadlineExceededError ||
        error instanceof ExecutionTimeoutError ||
        controller.signal.reason instanceof DeadlineExceededError ||
        controller.signal.reason instanceof ExecutionTimeoutError
      ) {
        // "not_due" is the database refusing the transition: its clock has not reached the stored
        // expiry the local timer fired for. Timestamps round-trip to the client at millisecond
        // precision while PostgreSQL stores microseconds, so the timer can lead by a fraction.
        // Ask again until the database agrees — returning on not_due would abandon an attempt the
        // handler already gave up, leaving it active under a live lease until lease recovery.
        let expirationStatus = await expirationPromise;
        const expirationRetryBudgetAt = Date.now() + 1_000;
        while (expirationStatus === "not_due" && Date.now() < expirationRetryBudgetAt) {
          await sleep(5);
          expirationPromise = undefined;
          expirationStatus = await expireOwnership();
        }
        if (arbiter.is("cancelled")) {
          await acknowledgeCancellation();
          span.setAttribute("workhorse.handler.outcome", "canceled");
          return;
        }
        if (arbiter.is("lease_expired")) {
          recordExecution("lease_lost");
          span.setAttribute("workhorse.handler.outcome", "stale");
          return;
        }
        if (arbiter.outcome === undefined) {
          arbiter.submit(
            error instanceof ExecutionTimeoutError ||
              controller.signal.reason instanceof ExecutionTimeoutError
              ? "attempt_timeout"
              : "deadline_exceeded",
          );
        }
        const executionTimedOut = arbiter.is("attempt_timeout");
        recordExecution(executionTimedOut ? "timeout" : "deadline_exceeded");
        span.setAttribute(
          "workhorse.handler.outcome",
          executionTimedOut ? "timeout_exceeded" : "deadline_exceeded",
        );
        return;
      }
      span.recordException(errorForTelemetry(error, job.redactErrorDetails));
      span.setStatus("error");
      const delay =
        typeof this.options.retryDelayMs === "function"
          ? this.options.retryDelayMs(job.attempt, job)
          : this.options.retryDelayMs;
      const failed = await this.queue.fail(job, this.workerId, error, delay);
      span.setAttribute("workhorse.handler.outcome", failed);
      if (failed === "cancel_requested") {
        markCancellationRequested();
        await acknowledgeCancellation();
      } else recordFailure(failed);
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Publish this worker's runtime state and read back the operator-requested pause flag.
   *
   * Registration failures are deliberately non-fatal. The durable registry is an operator
   * observability and control surface, not part of the dispatch contract, so a worker that cannot
   * reach it keeps claiming and executing exactly as before.
   */
  private async refreshRegistration(force = false): Promise<void> {
    if (this.registryIntervalMs === 0) return;
    const nowMs = Date.now();
    if (!force && nowMs - this.lastRegistryRefreshAt < this.registryIntervalMs) return;
    this.lastRegistryRefreshAt = nowMs;

    const wasRemotelyPaused = this.remotelyPaused;
    let paused: boolean;
    try {
      ({ paused } = await this.queue.registerWorker({
        workerId: this.workerId,
        instanceId: this.instanceId,
        hostname: workerHostname(),
        pid: process.pid,
        queues: this.queueNames,
        scheduleNamespaces: this.scheduleNamespaces,
        concurrency: this.concurrency,
        leaseMs: this.leaseMs,
        heartbeatMs: this.heartbeatMs,
        pollMs: this.pollMs,
        maintenanceIntervalMs: this.maintenanceIntervalMs,
        maintenanceTaskPollMs: this.maintenanceTaskPollMs,
        registryIntervalMs: this.registryIntervalMs,
        activeSlots: this.activeSlots,
        draining: this.draining,
      }));
    } catch (error) {
      // Keep the last known pause decision rather than silently resuming a paused worker.
      logInfo("workhorse.worker.registration_failed", "Worker registration failed", {
        ...this.workerQueueAttributes,
        "workhorse.worker.id": this.workerId,
      });
      this.options.onRegistrationError?.(error);
      return;
    }
    const registrationState = { activeSlots: this.activeSlots, draining: this.draining, paused };
    if (
      this.loggedRegistrationState === undefined ||
      this.loggedRegistrationState.activeSlots !== registrationState.activeSlots ||
      this.loggedRegistrationState.draining !== registrationState.draining ||
      this.loggedRegistrationState.paused !== registrationState.paused
    ) {
      logDebug("workhorse.worker.registered", "Worker registration changed", {
        ...this.workerQueueAttributes,
        "workhorse.worker.id": this.workerId,
        "workhorse.worker.concurrency": this.concurrency,
        "workhorse.worker.active_slots": registrationState.activeSlots,
        "workhorse.worker.draining": registrationState.draining,
        "workhorse.worker.paused": registrationState.paused,
      });
      this.loggedRegistrationState = registrationState;
    }
    this.registered = true;
    this.remotelyPaused = paused;
    // Resuming must not wait for the next idle poll deadline, exactly like a local resume().
    if (wasRemotelyPaused && !paused) {
      this.previousPassWorked = false;
      this.lastClaimAt = Number.NEGATIVE_INFINITY;
    }
    if (wasRemotelyPaused !== paused) {
      logInfo(
        paused ? "workhorse.worker.paused" : "workhorse.worker.resumed",
        paused ? "Worker paused remotely" : "Worker resumed remotely",
        {
          ...this.workerQueueAttributes,
          "workhorse.worker.id": this.workerId,
        },
      );
      this.wakeLoops();
    }
  }

  /** Best-effort removal of this worker's registration once its loop has stopped. */
  private async deregister(): Promise<void> {
    if (!this.registered) return;
    let refreshFailure: { error: unknown } | undefined;
    try {
      await this.pendingStopRegistrationRefresh;
    } catch (error) {
      refreshFailure = { error };
    }
    this.pendingStopRegistrationRefresh = undefined;
    this.registered = false;
    this.loggedRegistrationState = undefined;
    try {
      await this.queue.deregisterWorker(this.workerId);
    } catch {
      // A worker that cannot deregister ages out of the fleet view on its heartbeat window.
    }
    if (refreshFailure) throw refreshFailure.error;
  }

  private async runMaintenance(): Promise<void> {
    await this.refreshRegistration();
    const nowMs = Date.now();
    if (nowMs - this.lastTickAt >= this.maintenanceIntervalMs) {
      this.recordMaintenanceDrift(nowMs, this.lastTickAt, this.maintenanceIntervalMs, "tick");
      const tick = await this.queue.tick();
      for (const result of tick) this.recordMaintenance("tick", result);
      this.lastTickAt = nowMs;

      if (this.scheduleNamespaces.length > 0) {
        await this.queue.fireDueSchedules(
          this.scheduleNamespaces,
          new Date(),
          this.scheduleCatchupLimit,
        );
      }
    }

    if (nowMs - this.lastMaintenanceTaskPollAt >= this.maintenanceTaskPollMs) {
      this.recordMaintenanceDrift(
        nowMs,
        this.lastMaintenanceTaskPollAt,
        this.maintenanceTaskPollMs,
        "background_tasks",
      );
      for (const result of await this.queue.runMaintenance()) {
        this.recordMaintenance(
          result.phase.startsWith("stat_") ? "statistics_rollup" : "background_tasks",
          result,
        );
      }
      this.lastMaintenanceTaskPollAt = nowMs;
    }
  }

  private recordMaintenanceDrift(
    nowMs: number,
    lastRunAt: number,
    cadenceMs: number,
    loop: WorkerMaintenanceLoop,
  ): void {
    if (!Number.isFinite(lastRunAt)) return;
    telemetryMetrics.maintenanceDrift.record(Math.max(0, nowMs - lastRunAt - cadenceMs), {
      "workhorse.maintenance.loop": loop,
    });
  }

  private recordMaintenance(
    loop: WorkerMaintenanceTelemetry["loop"],
    result: MaintenancePhaseResult,
  ): void {
    const telemetry = { ...result, loop, observedAt: new Date().toISOString() };
    this.latestMaintenance.set(`${loop}:${result.phase}`, telemetry);
    recordMaintenanceMetrics(telemetry);
    this.options.onMaintenance?.(telemetry);
  }

  run(signal?: AbortSignal): Promise<void> {
    const requestedStopVersion = this.stopVersion;
    return this.withExclusiveExecution(() => this.runLoop(signal, requestedStopVersion));
  }

  private async runLoop(
    signal: AbortSignal | undefined,
    requestedStopVersion: number,
  ): Promise<void> {
    this.stopping = this.stopVersion !== requestedStopVersion;
    this.draining = false;
    this.running = true;
    logInfo("workhorse.worker.started", "Worker started", {
      ...this.workerQueueAttributes,
      "workhorse.worker.id": this.workerId,
      "workhorse.worker.concurrency": this.concurrency,
    });
    let firstError: unknown;
    const shouldStop = () => this.stopping || signal?.aborted === true;
    const fail = (error: unknown): void => {
      firstError ??= error;
      this.stopping = true;
      this.draining = this.running || this.activeSlots > 0;
      this.wakeLoops();
    };

    const notificationSubscriptions: JobNotificationSubscription[] = [];
    this.notificationSubscriptions = notificationSubscriptions;
    const runFailure = await (async () => {
      if (shouldStop()) return;
      await this.runMaintenance();
      if (shouldStop()) return;

      const subscribeToJobNotifications = this.queue.subscribeToJobNotifications;
      if (typeof subscribeToJobNotifications === "function") {
        for (const queueName of this.queueNames) {
          const subscription = await subscribeToJobNotifications.call(
            this.queue,
            queueName,
            () => {
              this.notificationClaimDelayPending = true;
              this.wakeDispatch();
            },
            (error) => this.options.onNotificationError?.(error),
          );
          if (subscription) notificationSubscriptions.push(subscription);
        }
      }

      const maintenance = this.maintenanceLoop(shouldStop, signal).catch(fail);
      const registration = this.registrationLoop(shouldStop, signal).catch(fail);
      const dispatch = this.dispatchLoop(shouldStop, signal).catch(fail);
      await Promise.all([maintenance, registration, dispatch]);
      if (firstError !== undefined) throw firstError;
    })().then(
      () => undefined,
      (error: unknown) => ({ error }),
    );

    this.running = false;
    this.draining = this.activeSlots > 0;
    const failures: unknown[] = [];
    if (runFailure) failures.push(runFailure.error);
    for (const subscription of notificationSubscriptions) {
      try {
        await subscription.close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.notificationSubscriptions = [];
    try {
      await this.deregister();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Worker shutdown failed");
    logInfo("workhorse.worker.stopped", "Worker stopped", {
      ...this.workerQueueAttributes,
      "workhorse.worker.id": this.workerId,
      "workhorse.worker.active_slots": this.activeSlots,
    });
  }

  /**
   * Refresh this worker's registration on its own cadence.
   *
   * This is deliberately a separate loop from maintenance. A maintenance pass runs `tick_v1` and
   * offers this worker's schedule namespaces, so sharing a loop would let a slow or busy pass
   * starve fleet liveness. Operator visibility and the pause signal must not degrade because
   * schedule evaluation got expensive.
   */
  private async registrationLoop(shouldStop: () => boolean, signal?: AbortSignal): Promise<void> {
    if (this.registryIntervalMs === 0) return;
    while (!shouldStop()) {
      await this.refreshRegistration();
      if (shouldStop()) break;
      await this.waitForWake(this.registryIntervalMs, signal);
    }
  }

  private async maintenanceLoop(shouldStop: () => boolean, signal?: AbortSignal): Promise<void> {
    const intervalMs = Math.min(this.maintenanceIntervalMs, this.maintenanceTaskPollMs);
    while (!shouldStop()) {
      await this.waitForWake(intervalMs, signal);
      if (shouldStop()) break;
      await this.runMaintenance();
    }
  }

  private async dispatchLoop(shouldStop: () => boolean, signal?: AbortSignal): Promise<void> {
    type DispatchSettlement = {
      executionId: number;
      settlement: PromiseSettledResult<void>;
    };

    const active = new Map<number, Promise<DispatchSettlement>>();
    let nextExecutionId = 0;
    let firstFailure: { executionId: number; reason: unknown } | undefined;
    let claimError: unknown;
    const observe = ({ executionId, settlement }: DispatchSettlement): void => {
      active.delete(executionId);
      if (settlement.status !== "rejected") return;
      if (!firstFailure || executionId < firstFailure.executionId) {
        firstFailure = { executionId, reason: settlement.reason };
      }
    };
    const launch = (job: ClaimedJob): void => {
      const executionId = nextExecutionId;
      nextExecutionId += 1;
      active.set(
        executionId,
        this.startExecution(job).then((settlement) => ({ executionId, settlement })),
      );
    };
    const waitForOne = async (): Promise<void> => {
      observe(await Promise.race(active.values()));
    };
    const waitThroughEmptyPoll = async (observedWakeVersion: number): Promise<void> => {
      const deadline = Date.now() + this.nextDispatchPollMs();
      while (true) {
        if (shouldStop() || this.paused || firstFailure) return;
        if (this.dispatchWakeVersion !== observedWakeVersion) return;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return;
        const wake = this.waitForDispatchWake(remainingMs, signal, observedWakeVersion).then(
          () => null,
        );
        const result = await Promise.race<DispatchSettlement | null>([...active.values(), wake]);
        if (result === null) return;
        observe(result);
      }
    };

    while (true) {
      if (shouldStop() || firstFailure || claimError !== undefined) break;
      if (this.paused) {
        if (active.size === 0) {
          await this.waitForDispatchWake(this.nextDispatchPollMs(), signal);
        } else {
          const wake = this.waitForDispatchWake(this.nextDispatchPollMs(), signal).then(() => null);
          const result = await Promise.race<DispatchSettlement | null>([...active.values(), wake]);
          if (result) observe(result);
        }
        continue;
      }

      let empty = false;
      let emptyWakeVersion = this.dispatchWakeVersion;
      while (active.size < this.concurrency && !shouldStop() && !this.paused) {
        if (this.notificationClaimDelayPending) {
          this.notificationClaimDelayPending = false;
          await sleep(Math.random() * NOTIFICATION_CLAIM_DELAY_MS);
          if (shouldStop() || this.paused) break;
        }
        this.lastClaimAt = Date.now();
        const claimWakeVersion = this.dispatchWakeVersion;
        let jobs: ClaimedJob[];
        try {
          jobs = await this.claimNextMany(this.concurrency - active.size);
        } catch (error) {
          claimError = error;
          break;
        }
        if (jobs.length === 0) {
          this.previousPassWorked = false;
          this.consecutiveEmptyClaims += 1;
          empty = true;
          emptyWakeVersion = claimWakeVersion;
          break;
        }
        this.previousPassWorked = true;
        this.consecutiveEmptyClaims = 0;
        for (const job of jobs) launch(job);
      }

      if (shouldStop() || this.paused || firstFailure || claimError !== undefined) continue;
      if (empty) {
        await waitThroughEmptyPoll(emptyWakeVersion);
      } else if (active.size >= this.concurrency) {
        await waitForOne();
      }
    }

    const remaining = await Promise.all(active.values());
    for (const settlement of remaining) observe(settlement);
    if (firstFailure) throw firstFailure.reason;
    if (claimError !== undefined) throw claimError;
  }

  private nextDispatchPollMs(): number {
    const listening = this.notificationSubscriptions.some(
      (subscription) => subscription.isListening?.() === true,
    );
    const exponent = listening ? 0 : Math.max(0, this.consecutiveEmptyClaims - 1);
    const durationMs = Math.min(
      MAX_EMPTY_POLL_MS,
      Math.max(1, this.dispatchPollMs) * 2 ** Math.min(exponent, 30),
    );
    return jitterDuration(durationMs);
  }

  private async waitForWake(
    durationMs: number,
    signal?: AbortSignal,
    observedWakeVersion = this.wakeVersion,
  ): Promise<void> {
    const wakeSignal = this.wakeController.signal;
    if (this.wakeVersion !== observedWakeVersion) return;
    const waitSignal = signal ? AbortSignal.any([wakeSignal, signal]) : wakeSignal;
    await sleep(durationMs, undefined, { signal: waitSignal }).catch(() => undefined);
  }

  private async waitForDispatchWake(
    durationMs: number,
    signal?: AbortSignal,
    observedWakeVersion = this.dispatchWakeVersion,
  ): Promise<void> {
    const wakeSignal = this.dispatchWakeController.signal;
    if (this.dispatchWakeVersion !== observedWakeVersion) return;
    const waitSignal = signal ? AbortSignal.any([wakeSignal, signal]) : wakeSignal;
    await sleep(durationMs, undefined, { signal: waitSignal }).catch(() => undefined);
  }

  private wakeDispatch(): void {
    const waiting = this.dispatchWakeController;
    this.dispatchWakeController = new AbortController();
    this.dispatchWakeVersion += 1;
    waiting.abort();
  }

  private wakeLoops(): void {
    const waiting = this.wakeController;
    this.wakeController = new AbortController();
    this.wakeVersion += 1;
    waiting.abort();
    this.wakeDispatch();
  }

  private async withExclusiveExecution<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

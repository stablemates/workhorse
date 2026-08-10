import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { CronExpressionParser } from "cron-parser";
import { SpanKind, SpanStatusCode, type Span } from "@opentelemetry/api";
import { errorForTelemetry, Queue } from "./queue.js";
import { recordJobExecution, recordMaintenanceMetrics } from "./metrics.js";
import type { JobExecutionOutcome } from "./metrics.js";
import type { MaintenancePhaseResult } from "./queue.js";
import {
  extractTraceContext,
  jobMetricAttributes,
  jobSpanAttributes,
  telemetryMetrics,
  withSpan,
} from "./telemetry.js";
import type {
  ClaimedJob,
  ExpireOwnedStatus,
  JobCheckpoint,
  JobProgress,
  JobWait,
  Json,
} from "./types.js";

const DURABLE_WAIT_SUSPENSION = Symbol("workhorse.durableWaitSuspension");

export type Failpoint =
  | "afterClaim"
  | "beforeHandler"
  | "afterHandler"
  | "beforeComplete"
  | "afterComplete";
export interface HandlerContext<TPayload = Json> {
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
}

export type Handler<TPayload = Json, TResult extends Json = Json> = (
  payload: TPayload,
  context: HandlerContext<TPayload>,
) => Promise<TResult> | TResult;

export interface WorkerMaintenanceTelemetry extends MaintenancePhaseResult {
  loop:
    | "tick"
    | "statistics_rollup"
    | "history_partitions"
    | "history_retention"
    | "terminal_storage";
  observedAt: string;
}

export class InjectedCrashError extends Error {
  constructor(readonly failpoint: Failpoint) {
    super(`Injected crash at ${failpoint}`);
    this.name = "InjectedCrashError";
  }
}

/** AbortSignal reason used when PostgreSQL reports a cancellation request for an owned job. */
export class CancellationRequestedError extends Error {
  constructor(readonly jobId: string) {
    super(`Cancellation was requested for job ${jobId}`);
    this.name = "CancellationRequestedError";
  }
}

/** AbortSignal reason used when a job's immutable absolute deadline is reached. */
export class DeadlineExceededError extends Error {
  constructor(readonly jobId: string) {
    super(`Deadline was exceeded for job ${jobId}`);
    this.name = "DeadlineExceededError";
  }
}

/** AbortSignal reason used when one logical attempt consumes its active execution budget. */
export class ExecutionTimeoutError extends Error {
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
  /** Idle polling delay. Polling is always the durable fallback even when NOTIFY is added later. */
  pollMs?: number;
  /** Minimum delay between worker-owned maintenance and recurring schedule passes. */
  maintenanceIntervalMs?: number;
  /** Minimum delay between checks for database-scheduled background maintenance tasks. */
  maintenanceTaskPollMs?: number;
  /**
   * Minimum delay between rolling-statistics passes. Defaults to one minute, which is the bucket
   * width: passing more often only rewrites the same closed minutes, and passing less often makes
   * operator windows derive a longer live tail from raw history. Set to 0 to opt out, which leaves
   * every window fully derived and holds history retention at the current watermark.
   */
  statisticsRollupIntervalMs?: number;
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
  /** Receives one telemetry event for every SQL-owned maintenance phase. */
  onMaintenance?: (telemetry: WorkerMaintenanceTelemetry) => void;
  /** Namespaces whose enabled recurring schedules this worker should evaluate and fire. */
  scheduleNamespaces?: readonly string[];
  /** Maximum missed occurrences fired for one schedule in one maintenance pass. */
  scheduleCatchupLimit?: number;
  /** Override SQL-owned retry backoff, either fixed or derived from the attempt and claimed job. */
  /** Return undefined to defer to the job's persisted policy or SQL compatibility default. */
  retryDelayMs?: number | ((attempt: number, job: ClaimedJob) => number | undefined);
  /** Test-only crash hook. Injected crashes deliberately bypass normal fail/retry handling. */
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

/**
 * Bounded-concurrency polling worker for the validation protocol.
 *
 * PostgreSQL SKIP LOCKED distributes ready rows between workers, while each instance claims only
 * enough jobs to fill its configured local execution slots.
 */
export class Worker {
  private readonly handlers = new Map<string, Handler>();
  private readonly workerId: string;
  private readonly queueName: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly maintenanceTaskPollMs: number;
  private readonly statisticsRollupIntervalMs: number;
  private readonly registryIntervalMs: number;
  private readonly scheduleNamespaces: readonly string[];
  private readonly scheduleCatchupLimit: number;
  public readonly concurrency: number;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastMaintenanceTaskPollAt = Number.NEGATIVE_INFINITY;
  private lastStatisticsRollupAt = Number.NEGATIVE_INFINITY;
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
  private wakeController = new AbortController();

  constructor(
    private readonly queue: Queue,
    private readonly options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? defaultWorkerId();
    this.queueName = options.queue ?? queue.defaultQueue;
    this.concurrency = options.concurrency ?? 1;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(this.leaseMs / 3));
    this.pollMs = options.pollMs ?? 250;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 1_000;
    this.maintenanceTaskPollMs = options.maintenanceTaskPollMs ?? 60_000;
    this.statisticsRollupIntervalMs = options.statisticsRollupIntervalMs ?? 60_000;
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
    if (this.statisticsRollupIntervalMs !== 0 && this.statisticsRollupIntervalMs < 1_000)
      throw new Error("statisticsRollupIntervalMs must be 0 or at least 1000");
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
    return this;
  }

  stop(): void {
    this.stopVersion += 1;
    this.stopping = true;
    this.draining = this.running || this.activeSlots > 0;
    // The maintenance loop exits immediately on stop, so a draining worker would otherwise never
    // publish that state and would simply vanish from an operator's fleet view mid-drain.
    if (this.draining && this.registered) void this.refreshRegistration(true);
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
    this.wakeLoops();
  }

  /** Resume claims immediately instead of waiting for the previous idle poll deadline. */
  resume(): void {
    this.locallyPaused = false;
    this.previousPassWorked = false;
    this.lastClaimAt = Number.NEGATIVE_INFINITY;
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
    for (let slot = 0; slot < freeSlots; slot += 1) {
      if (shouldStop() || this.paused) break;
      let job: ClaimedJob | null;
      try {
        job = await this.queue.claim(this.workerId, {
          queue: this.queueName,
          leaseMs: this.leaseMs,
        });
      } catch (error) {
        claimError = error;
        claimFailed = true;
        break;
      }
      if (!job) break;

      executions.push(this.startExecution(job));
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
    return withSpan(
      "workhorse.handler",
      {
        "workhorse.queue.name": this.queueName,
        ...jobSpanAttributes(job),
      },
      async (span) => {
        try {
          await this.executeJobWithinSpan(job, span);
        } finally {
          const durationMs = performance.now() - startedAt;
          const attributes = jobMetricAttributes(job);
          telemetryMetrics.handlerDuration.record(durationMs, attributes);
          telemetryMetrics.handlerRuntime.add(durationMs, attributes);
        }
      },
      extractTraceContext(job.traceContext),
      SpanKind.CONSUMER,
    );
  }

  private async executeJobWithinSpan(job: ClaimedJob, span: Span): Promise<void> {
    // afterClaim is outside the committed claim transaction. Throwing here leaves the lease exactly
    // as a killed process would, which allows deterministic expiry-recovery testing.
    const executionStartedAt = performance.now();
    let executionRecorded = false;
    const recordExecution = (outcome: JobExecutionOutcome): void => {
      if (executionRecorded) return;
      executionRecorded = true;
      recordJobExecution(
        this.queueName,
        job.type,
        outcome,
        (performance.now() - executionStartedAt) / 1_000,
      );
    };
    const recordFailure = (state: Awaited<ReturnType<Queue["fail"]>>): void => {
      if (state === "ready" || state === "scheduled") recordExecution("retry");
      else if (state === "failed") recordExecution("failed");
      else if (state === "deadline_exceeded") recordExecution("deadline_exceeded");
      else if (state === "timeout_exceeded") recordExecution("timeout");
      else if (state === "stale") recordExecution("lease_lost");
    };
    const controller = new AbortController();
    let leaseLost = false;
    let cancellationRequested = false;
    let deadlineExceeded = false;
    let timeoutExceeded = false;
    let durablySuspended = false;
    // Each job owns an independent self-scheduling heartbeat. The next delay starts only after the
    // previous query settles, so a slow database call cannot overlap another heartbeat for this job.
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let expirationTimer: NodeJS.Timeout | undefined;
    let expirationPromise: Promise<ExpireOwnedStatus> | undefined;
    let heartbeatStopped = false;
    const stopHeartbeat = (): void => {
      heartbeatStopped = true;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (expirationTimer) {
        clearTimeout(expirationTimer);
        expirationTimer = undefined;
      }
    };
    const markCancellationRequested = (): void => {
      cancellationRequested = true;
      stopHeartbeat();
      if (!controller.signal.aborted) controller.abort(new CancellationRequestedError(job.id));
    };
    const acknowledgeCancellation = async (): Promise<boolean> => {
      const accepted = await this.queue.acknowledgeCancel(job, this.workerId);
      if (accepted) recordExecution("canceled");
      return accepted;
    };
    const expireOwnership = (): Promise<ExpireOwnedStatus> => {
      expirationPromise ??= this.queue.expireOwned(job, this.workerId).then((status) => {
        if (status === "cancel_requested") markCancellationRequested();
        return status;
      });
      return expirationPromise;
    };
    const refreshOwnership = async () => {
      const status = await this.queue.heartbeatStatus(job, this.workerId, this.leaseMs);
      if (status === "cancel_requested") {
        markCancellationRequested();
      } else if (status === "deadline_exceeded") {
        deadlineExceeded = true;
        stopHeartbeat();
        void expireOwnership();
        if (!controller.signal.aborted) controller.abort(new DeadlineExceededError(job.id));
      } else if (status === "timeout_exceeded") {
        timeoutExceeded = true;
        stopHeartbeat();
        void expireOwnership();
        if (!controller.signal.aborted)
          controller.abort(new ExecutionTimeoutError(job.id, job.attempt));
      } else if (status === "stale") {
        leaseLost = true;
        stopHeartbeat();
        if (!controller.signal.aborted) controller.abort(new Error("Job lease was lost"));
      }
      return status;
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
            deadlineExceeded = true;
            if (!controller.signal.aborted) controller.abort(new DeadlineExceededError(job.id));
          } else {
            timeoutExceeded = true;
            if (!controller.signal.aborted)
              controller.abort(new ExecutionTimeoutError(job.id, job.attempt));
          }
          stopHeartbeat();
          void expireOwnership();
        },
        Math.max(0, expirationAt.getTime() - Date.now()),
      );
      expirationTimer.unref();
    }
    const scheduleHeartbeat = (): void => {
      if (heartbeatStopped) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        void Promise.resolve()
          .then(() => refreshOwnership())
          .then(
            () => {
              if (heartbeatStopped) return;
            },
            (error: unknown) => {
              if (heartbeatStopped) return;
              leaseLost = true;
              stopHeartbeat();
              controller.abort(error);
            },
          )
          .finally(() => {
            if (!heartbeatStopped && !controller.signal.aborted) scheduleHeartbeat();
          });
      }, this.heartbeatMs);
      heartbeatTimer.unref();
    };
    scheduleHeartbeat();

    try {
      await this.inject("afterClaim", job);
      const handler = this.handlers.get(job.type);
      if (!handler) {
        const error = new Error(`No handler registered for ${job.type}`);
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
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
          if (scheduled.status === "scheduled") {
            durablySuspended = true;
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
      });
      await this.inject("afterHandler", job);
      if (cancellationRequested) {
        await acknowledgeCancellation();
        span.setAttribute("workhorse.handler.outcome", "canceled");
        return;
      }
      if (leaseLost || controller.signal.aborted)
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
      span.setAttribute("workhorse.handler.outcome", "succeeded");
      recordExecution("succeeded");
      await this.inject("afterComplete", job);
    } catch (error) {
      if (
        durablySuspended ||
        error === DURABLE_WAIT_SUSPENSION ||
        controller.signal.reason === DURABLE_WAIT_SUSPENSION
      ) {
        span.setAttribute("workhorse.handler.outcome", "suspended");
        recordExecution("suspended");
        return;
      }
      // A crash failpoint models process disappearance, so converting it into fail_v1 would produce
      // the wrong durable state. Ordinary handler errors do close and retry the attempt.
      if (error instanceof InjectedCrashError) throw error;
      if (
        cancellationRequested ||
        error instanceof CancellationRequestedError ||
        controller.signal.reason instanceof CancellationRequestedError
      ) {
        await acknowledgeCancellation();
        span.setAttribute("workhorse.handler.outcome", "canceled");
        return;
      }
      if (
        deadlineExceeded ||
        timeoutExceeded ||
        error instanceof DeadlineExceededError ||
        error instanceof ExecutionTimeoutError ||
        controller.signal.reason instanceof DeadlineExceededError ||
        controller.signal.reason instanceof ExecutionTimeoutError
      ) {
        const expirationStatus = await expirationPromise;
        if (expirationStatus === "cancel_requested") {
          await acknowledgeCancellation();
          span.setAttribute("workhorse.handler.outcome", "canceled");
          return;
        }
        if (expirationStatus === "stale") {
          recordExecution("lease_lost");
          span.setAttribute("workhorse.handler.outcome", "stale");
          return;
        }
        const executionTimedOut =
          expirationStatus === "timeout_exceeded" ||
          (expirationStatus === undefined && timeoutExceeded) ||
          error instanceof ExecutionTimeoutError ||
          controller.signal.reason instanceof ExecutionTimeoutError;
        recordExecution(executionTimedOut ? "timeout" : "deadline_exceeded");
        span.setAttribute(
          "workhorse.handler.outcome",
          executionTimedOut ? "timeout_exceeded" : "deadline_exceeded",
        );
        return;
      }
      span.recordException(errorForTelemetry(error, job.redactErrorDetails));
      span.setStatus({ code: SpanStatusCode.ERROR });
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
        queue: this.queueName,
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
      this.options.onRegistrationError?.(error);
      return;
    }
    this.registered = true;
    this.remotelyPaused = paused;
    // Resuming must not wait for the next idle poll deadline, exactly like a local resume().
    if (wasRemotelyPaused && !paused) {
      this.previousPassWorked = false;
      this.lastClaimAt = Number.NEGATIVE_INFINITY;
    }
    if (wasRemotelyPaused !== paused) this.wakeLoops();
  }

  /** Best-effort removal of this worker's registration once its loop has stopped. */
  private async deregister(): Promise<void> {
    if (!this.registered) return;
    this.registered = false;
    try {
      await this.queue.deregisterWorker(this.workerId);
    } catch {
      // A worker that cannot deregister ages out of the fleet view on its heartbeat window.
    }
  }

  private async runMaintenance(): Promise<void> {
    await this.refreshRegistration();
    const nowMs = Date.now();
    if (nowMs - this.lastTickAt >= this.maintenanceIntervalMs) {
      this.recordMaintenanceDrift(nowMs, this.lastTickAt, this.maintenanceIntervalMs, "tick");
      const tick = await this.queue.tick();
      for (const result of tick) this.recordMaintenance("tick", result);
      this.lastTickAt = nowMs;

      const ownsTick = tick.length > 0 && tick.every((result) => !result.skippedLock);
      if (ownsTick && this.scheduleNamespaces.length > 0) {
        const now = new Date();
        for (const schedule of await this.queue.schedules(this.scheduleNamespaces)) {
          for (const occurrence of dueOccurrences(
            schedule.schedule,
            schedule.lastOccurrenceAt,
            now,
            this.scheduleCatchupLimit,
          )) {
            await this.queue.fireSchedule(
              schedule.namespace,
              schedule.name,
              schedule.revision,
              occurrence,
            );
          }
        }
      }
    }

    // Statistics roll up before retention rather than after it. Retention refuses to delete raw
    // history past the rollup watermark, so advancing the watermark first is what lets the same
    // pass reclaim the history it just summarized.
    if (
      this.statisticsRollupIntervalMs !== 0 &&
      nowMs - this.lastStatisticsRollupAt >= this.statisticsRollupIntervalMs
    ) {
      this.recordMaintenanceDrift(
        nowMs,
        this.lastStatisticsRollupAt,
        this.statisticsRollupIntervalMs,
        "statistics_rollup",
      );
      for (const result of await this.queue.rollupStatistics())
        this.recordMaintenance("statistics_rollup", result);
      this.lastStatisticsRollupAt = nowMs;
    }

    if (nowMs - this.lastMaintenanceTaskPollAt >= this.maintenanceTaskPollMs) {
      this.recordMaintenanceDrift(
        nowMs,
        this.lastMaintenanceTaskPollAt,
        this.maintenanceTaskPollMs,
        "background_tasks",
      );
      for (const result of await this.queue.prepareHistoryPartitions())
        this.recordMaintenance("history_partitions", result);
      for (const result of await this.queue.retainHistory())
        this.recordMaintenance("history_retention", result);
      for (const result of await this.queue.pruneTerminalStorage())
        this.recordMaintenance("terminal_storage", result);
      // Registrations are operator state, not lifecycle attribution, so a failed prune must never
      // stop maintenance that retention and partitioning depend on.
      if (this.registryIntervalMs !== 0) {
        await this.queue.pruneWorkerRegistry().catch(() => 0);
      }
      this.lastMaintenanceTaskPollAt = nowMs;
    }
  }

  private recordMaintenanceDrift(
    nowMs: number,
    lastRunAt: number,
    cadenceMs: number,
    loop: "tick" | "statistics_rollup" | "background_tasks",
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
    let firstError: unknown;
    const shouldStop = () => this.stopping || signal?.aborted === true;
    const fail = (error: unknown): void => {
      firstError ??= error;
      this.stopping = true;
      this.draining = this.running || this.activeSlots > 0;
      this.wakeLoops();
    };

    try {
      if (shouldStop()) return;
      await this.runMaintenance();
      if (shouldStop()) return;

      const maintenance = this.maintenanceLoop(shouldStop, signal).catch(fail);
      const registration = this.registrationLoop(shouldStop, signal).catch(fail);
      const dispatch = this.dispatchLoop(shouldStop, signal).catch(fail);
      await Promise.all([maintenance, registration, dispatch]);
      if (firstError !== undefined) throw firstError;
    } finally {
      this.running = false;
      this.draining = this.activeSlots > 0;
      await this.deregister();
    }
  }

  /**
   * Refresh this worker's registration on its own cadence.
   *
   * This is deliberately a separate loop from maintenance. A maintenance pass runs `tick_v1` and,
   * when it owns the tick, evaluates and fires every due schedule, so sharing a loop would let a
   * slow or busy maintenance pass starve fleet liveness. Operator visibility and the pause signal
   * must not degrade because schedule evaluation got expensive.
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
    const waitThroughEmptyPoll = async (): Promise<void> => {
      const deadline = Date.now() + Math.max(1, this.pollMs);
      while (true) {
        if (shouldStop() || this.paused || firstFailure) return;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return;
        const wake = this.waitForWake(remainingMs, signal).then(() => null);
        const result = await Promise.race<DispatchSettlement | null>([...active.values(), wake]);
        if (result === null) return;
        observe(result);
      }
    };

    while (true) {
      if (shouldStop() || firstFailure || claimError !== undefined) break;
      if (this.paused) {
        if (active.size === 0) {
          await this.waitForWake(Math.max(1, this.pollMs), signal);
        } else {
          const wake = this.waitForWake(Math.max(1, this.pollMs), signal).then(() => null);
          const result = await Promise.race<DispatchSettlement | null>([...active.values(), wake]);
          if (result) observe(result);
        }
        continue;
      }

      let empty = false;
      while (active.size < this.concurrency && !shouldStop() && !this.paused) {
        this.lastClaimAt = Date.now();
        let job: ClaimedJob | null;
        try {
          job = await this.queue.claim(this.workerId, {
            queue: this.queueName,
            leaseMs: this.leaseMs,
          });
        } catch (error) {
          claimError = error;
          break;
        }
        if (!job) {
          this.previousPassWorked = false;
          empty = true;
          break;
        }
        this.previousPassWorked = true;
        launch(job);
      }

      if (shouldStop() || this.paused || firstFailure || claimError !== undefined) continue;
      if (empty) {
        await waitThroughEmptyPoll();
      } else if (active.size >= this.concurrency) {
        await waitForOne();
      }
    }

    const remaining = await Promise.all(active.values());
    for (const settlement of remaining) observe(settlement);
    if (firstFailure) throw firstFailure.reason;
    if (claimError !== undefined) throw claimError;
  }

  private async waitForWake(durationMs: number, signal?: AbortSignal): Promise<void> {
    const wakeSignal = this.wakeController.signal;
    const waitSignal = signal ? AbortSignal.any([wakeSignal, signal]) : wakeSignal;
    await sleep(durationMs, undefined, { signal: waitSignal }).catch(() => undefined);
  }

  private wakeLoops(): void {
    const waiting = this.wakeController;
    this.wakeController = new AbortController();
    waiting.abort();
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

function dueOccurrences(
  expression: string,
  lastOccurrenceAt: Date | null,
  now: Date,
  limit: number,
): Date[] {
  if (!lastOccurrenceAt) {
    const cron = CronExpressionParser.parse(expression, {
      currentDate: new Date(now.getTime() + 1_000),
    });
    return [cron.prev().toDate()];
  }

  const cron = CronExpressionParser.parse(expression, { currentDate: lastOccurrenceAt });
  const occurrences: Date[] = [];
  while (occurrences.length < limit) {
    const occurrence = cron.next().toDate();
    if (occurrence.getTime() > now.getTime()) break;
    occurrences.push(occurrence);
  }
  return occurrences;
}

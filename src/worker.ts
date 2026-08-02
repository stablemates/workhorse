import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { Queue } from "./queue.js";
import type { MaintenancePhaseResult } from "./queue.js";
import type { ClaimedJob, JobCheckpoint, JobWait, Json } from "./types.js";

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
  loop: "tick" | "history_partitions" | "history_retention" | "terminal_storage";
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

export interface WorkerOptions {
  /** Queue name used for claims. */
  queue?: string;
  /** Durable lease owner identity. It should be unique among simultaneously running workers. */
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

export interface WorkerRuntimeState {
  concurrency: number;
  activeSlots: number;
  paused: boolean;
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
  private readonly scheduleNamespaces: readonly string[];
  private readonly scheduleCatchupLimit: number;
  public readonly concurrency: number;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastMaintenanceTaskPollAt = Number.NEGATIVE_INFINITY;
  private lastClaimAt = Number.NEGATIVE_INFINITY;
  private previousPassWorked = false;
  private readonly latestMaintenance = new Map<string, WorkerMaintenanceTelemetry>();
  private stopping = false;
  private paused = false;
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
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
    this.queueName = options.queue ?? queue.defaultQueue;
    this.concurrency = options.concurrency ?? 1;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(this.leaseMs / 3));
    this.pollMs = options.pollMs ?? 250;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 1_000;
    this.maintenanceTaskPollMs = options.maintenanceTaskPollMs ?? 60_000;
    this.scheduleNamespaces = [...new Set(options.scheduleNamespaces ?? [])];
    this.scheduleCatchupLimit = options.scheduleCatchupLimit ?? 100;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 100)
      throw new Error("concurrency must be a safe integer between 1 and 100");
    if (this.heartbeatMs >= this.leaseMs) throw new Error("heartbeatMs must be less than leaseMs");
    if (this.maintenanceIntervalMs < 100)
      throw new Error("maintenanceIntervalMs must be at least 100");
    if (this.maintenanceTaskPollMs < 100)
      throw new Error("maintenanceTaskPollMs must be at least 100");
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
    this.wakeLoops();
  }

  /** Stop claiming new jobs while leaving maintenance and any in-flight handler running. */
  pause(): void {
    this.paused = true;
    this.wakeLoops();
  }

  /** Resume claims immediately instead of waiting for the previous idle poll deadline. */
  resume(): void {
    this.paused = false;
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
      draining: this.draining,
    };
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
    // afterClaim is outside the committed claim transaction. Throwing here leaves the lease exactly
    // as a killed process would, which allows deterministic expiry-recovery testing.
    const controller = new AbortController();
    let leaseLost = false;
    let cancellationRequested = false;
    let durablySuspended = false;
    // Each job owns an independent self-scheduling heartbeat. The next delay starts only after the
    // previous query settles, so a slow database call cannot overlap another heartbeat for this job.
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatStopped = false;
    const stopHeartbeat = (): void => {
      heartbeatStopped = true;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    const markCancellationRequested = (): void => {
      cancellationRequested = true;
      stopHeartbeat();
      if (!controller.signal.aborted) controller.abort(new CancellationRequestedError(job.id));
    };
    const refreshOwnership = async (): Promise<"accepted" | "cancel_requested" | "stale"> => {
      const status = await this.queue.heartbeatStatus(job, this.workerId, this.leaseMs);
      if (status === "cancel_requested") {
        markCancellationRequested();
      } else if (status === "stale") {
        leaseLost = true;
        stopHeartbeat();
        if (!controller.signal.aborted) controller.abort(new Error("Job lease was lost"));
      }
      return status;
    };
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
        const failed = await this.queue.fail(
          job,
          this.workerId,
          new Error(`No handler registered for ${job.type}`),
        );
        if (failed === "cancel_requested") {
          markCancellationRequested();
          await this.queue.acknowledgeCancel(job, this.workerId);
        }
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
        checkpoint,
        sleep: durableSleep,
        sleepUntil,
      });
      await this.inject("afterHandler", job);
      if (cancellationRequested) {
        await this.queue.acknowledgeCancel(job, this.workerId);
        return;
      }
      if (leaseLost || controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Job lease was lost");
      await this.inject("beforeComplete", job);
      const accepted = await this.queue.complete(job, this.workerId, result);
      if (!accepted) {
        if (await this.queue.acknowledgeCancel(job, this.workerId)) return;
        throw new Error("Completion rejected because the lease is stale or expired");
      }
      await this.inject("afterComplete", job);
    } catch (error) {
      if (
        durablySuspended ||
        error === DURABLE_WAIT_SUSPENSION ||
        controller.signal.reason === DURABLE_WAIT_SUSPENSION
      ) {
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
        await this.queue.acknowledgeCancel(job, this.workerId);
        return;
      }
      const delay =
        typeof this.options.retryDelayMs === "function"
          ? this.options.retryDelayMs(job.attempt, job)
          : this.options.retryDelayMs;
      const failed = await this.queue.fail(job, this.workerId, error, delay);
      if (failed === "cancel_requested") {
        markCancellationRequested();
        await this.queue.acknowledgeCancel(job, this.workerId);
      }
    } finally {
      stopHeartbeat();
    }
  }

  private async runMaintenance(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastTickAt >= this.maintenanceIntervalMs) {
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

    if (nowMs - this.lastMaintenanceTaskPollAt >= this.maintenanceTaskPollMs) {
      for (const result of await this.queue.prepareHistoryPartitions())
        this.recordMaintenance("history_partitions", result);
      for (const result of await this.queue.retainHistory())
        this.recordMaintenance("history_retention", result);
      for (const result of await this.queue.pruneTerminalStorage())
        this.recordMaintenance("terminal_storage", result);
      this.lastMaintenanceTaskPollAt = nowMs;
    }
  }

  private recordMaintenance(
    loop: WorkerMaintenanceTelemetry["loop"],
    result: MaintenancePhaseResult,
  ): void {
    const telemetry = { ...result, loop, observedAt: new Date().toISOString() };
    this.latestMaintenance.set(`${loop}:${result.phase}`, telemetry);
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
      const dispatch = this.dispatchLoop(shouldStop, signal).catch(fail);
      await Promise.all([maintenance, dispatch]);
      if (firstError !== undefined) throw firstError;
    } finally {
      this.running = false;
      this.draining = this.activeSlots > 0;
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

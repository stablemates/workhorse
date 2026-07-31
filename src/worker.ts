import { setTimeout as sleep } from "node:timers/promises";
import { CronExpressionParser } from "cron-parser";
import { Queue } from "./queue.js";
import type { MaintenancePhaseResult } from "./queue.js";
import type { ClaimedJob, JobCheckpoint, Json } from "./types.js";

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
  /**
   * Return the persisted value when this name already exists. Otherwise run the operation and
   * immutably persist its JSON result under the current fenced lease.
   */
  checkpoint<TValue extends Json>(
    name: string,
    operation: () => Promise<TValue> | TValue,
  ): Promise<TValue>;
}

export type Handler<TPayload = Json, TResult extends Json = Json> = (
  payload: TPayload,
  context: HandlerContext<TPayload>,
) => Promise<TResult> | TResult;

export interface WorkerMaintenanceTelemetry extends MaintenancePhaseResult {
  loop: "tick" | "housekeeping";
  observedAt: string;
}

export class InjectedCrashError extends Error {
  constructor(readonly failpoint: Failpoint) {
    super(`Injected crash at ${failpoint}`);
    this.name = "InjectedCrashError";
  }
}

export interface WorkerOptions {
  /** Queue name used for claims. */
  queue?: string;
  /** Durable lease owner identity. It should be unique among simultaneously running workers. */
  workerId?: string;
  /** Ownership duration granted by claim and every accepted heartbeat. */
  leaseMs?: number;
  /** Local heartbeat interval. It must remain shorter than leaseMs. */
  heartbeatMs?: number;
  /** Idle polling delay. Polling is always the durable fallback even when NOTIFY is added later. */
  pollMs?: number;
  /** Minimum delay between worker-owned maintenance and recurring schedule passes. */
  maintenanceIntervalMs?: number;
  /** Minimum delay between partition replenishment and occurrence-pruning passes. */
  housekeepingIntervalMs?: number;
  /** Receives one telemetry event for every SQL-owned maintenance phase. */
  onMaintenance?: (telemetry: WorkerMaintenanceTelemetry) => void;
  /** Namespaces whose enabled recurring schedules this worker should evaluate and fire. */
  scheduleNamespaces?: readonly string[];
  /** Maximum missed occurrences fired for one schedule in one maintenance pass. */
  scheduleCatchupLimit?: number;
  /** Override SQL-owned retry backoff, either fixed or derived from the one-based attempt number. */
  retryDelayMs?: number | ((attempt: number) => number);
  /** Test-only crash hook. Injected crashes deliberately bypass normal fail/retry handling. */
  failpoint?: Failpoint | ((point: Failpoint, job: ClaimedJob) => boolean | Promise<boolean>);
}

/**
 * Single-concurrency polling worker for the validation protocol.
 *
 * One Worker instance runs one handler at a time. Scale-out is achieved with more instances, and
 * PostgreSQL SKIP LOCKED distributes ready rows between them.
 */
export class Worker {
  private readonly handlers = new Map<string, Handler>();
  private readonly workerId: string;
  private readonly queueName: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly housekeepingIntervalMs: number;
  private readonly scheduleNamespaces: readonly string[];
  private readonly scheduleCatchupLimit: number;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastHousekeepingAt = Number.NEGATIVE_INFINITY;
  private lastClaimAt = Number.NEGATIVE_INFINITY;
  private previousPassWorked = false;
  private readonly latestMaintenance = new Map<string, WorkerMaintenanceTelemetry>();
  private stopping = false;
  private paused = false;

  constructor(
    private readonly queue: Queue,
    private readonly options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.queueName = options.queue ?? queue.defaultQueue;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(this.leaseMs / 3));
    this.pollMs = options.pollMs ?? 250;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 1_000;
    this.housekeepingIntervalMs = options.housekeepingIntervalMs ?? 60_000;
    this.scheduleNamespaces = [...new Set(options.scheduleNamespaces ?? [])];
    this.scheduleCatchupLimit = options.scheduleCatchupLimit ?? 100;
    if (this.heartbeatMs >= this.leaseMs) throw new Error("heartbeatMs must be less than leaseMs");
    if (this.maintenanceIntervalMs < 100)
      throw new Error("maintenanceIntervalMs must be at least 100");
    if (this.housekeepingIntervalMs < 100)
      throw new Error("housekeepingIntervalMs must be at least 100");
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
    this.stopping = true;
  }

  /** Stop claiming new jobs while leaving maintenance and any in-flight handler running. */
  pause(): void {
    this.paused = true;
  }

  /** Resume claims immediately instead of waiting for the previous idle poll deadline. */
  resume(): void {
    this.paused = false;
    this.previousPassWorked = false;
    this.lastClaimAt = Number.NEGATIVE_INFINITY;
  }

  isPaused(): boolean {
    return this.paused;
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

  async runOnce(): Promise<boolean> {
    await this.runMaintenance();
    if (this.paused) return false;
    const nowMs = Date.now();
    if (!this.previousPassWorked && nowMs - this.lastClaimAt < this.pollMs) return false;

    this.lastClaimAt = nowMs;
    const job = await this.queue.claim(this.workerId, {
      queue: this.queueName,
      leaseMs: this.leaseMs,
    });
    this.previousPassWorked = job !== null;
    if (!job) return false;

    // afterClaim is outside the committed claim transaction. Throwing here leaves the lease exactly
    // as a killed process would, which allows deterministic expiry-recovery testing.
    await this.inject("afterClaim", job);
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.queue.fail(job, this.workerId, new Error(`No handler registered for ${job.type}`));
      return true;
    }

    const controller = new AbortController();
    let leaseLost = false;
    // The heartbeat timer runs only while user code is active. A rejected heartbeat aborts the
    // cooperative signal, but cannot forcibly interrupt arbitrary JavaScript or external effects.
    const heartbeat = setInterval(() => {
      void this.queue
        .heartbeat(job, this.workerId, this.leaseMs)
        .then((accepted) => {
          if (!accepted) {
            leaseLost = true;
            controller.abort(new Error("Job lease was lost"));
          }
        })
        .catch((error: unknown) => controller.abort(error));
    }, this.heartbeatMs);
    heartbeat.unref();

    try {
      await this.inject("beforeHandler", job);
      // No database transaction or row lock spans this call. Handlers are at least once and must
      // use external idempotency for effects that cannot safely repeat.
      const getCheckpoint: HandlerContext["getCheckpoint"] = <TValue extends Json>(name: string) =>
        this.queue.getCheckpoint<TValue>(job.id, name);
      const inFlightCheckpoints = new Map<string, Promise<Json>>();
      const checkpoint: HandlerContext["checkpoint"] = async <TValue extends Json>(
        name: string,
        operation: () => Promise<TValue> | TValue,
      ): Promise<TValue> => {
        const pending = inFlightCheckpoints.get(name);
        if (pending) return (await pending) as TValue;
        const execution = (async (): Promise<TValue> => {
          const existing = await this.queue.getCheckpoint<TValue>(job.id, name);
          if (existing) return existing.value;
          if (controller.signal.aborted)
            throw controller.signal.reason ?? new Error("Job lease was lost");
          const value = await operation();
          const saved = await this.queue.saveCheckpoint(job, this.workerId, name, value);
          return saved.value;
        })();
        inFlightCheckpoints.set(name, execution);
        try {
          return await execution;
        } finally {
          if (inFlightCheckpoints.get(name) === execution) inFlightCheckpoints.delete(name);
        }
      };
      const result = await handler(job.payload, {
        job,
        signal: controller.signal,
        getCheckpoint,
        checkpoint,
      });
      await this.inject("afterHandler", job);
      if (leaseLost || controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Job lease was lost");
      await this.inject("beforeComplete", job);
      const accepted = await this.queue.complete(job, this.workerId, result);
      if (!accepted) throw new Error("Completion rejected because the lease is stale or expired");
      await this.inject("afterComplete", job);
    } catch (error) {
      // A crash failpoint models process disappearance, so converting it into fail_v1 would produce
      // the wrong durable state. Ordinary handler errors do close and retry the attempt.
      if (error instanceof InjectedCrashError) throw error;
      const delay =
        typeof this.options.retryDelayMs === "function"
          ? this.options.retryDelayMs(job.attempt)
          : this.options.retryDelayMs;
      await this.queue.fail(job, this.workerId, error, delay);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
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

    if (nowMs - this.lastHousekeepingAt >= this.housekeepingIntervalMs) {
      for (const result of await this.queue.housekeep())
        this.recordMaintenance("housekeeping", result);
      this.lastHousekeepingAt = nowMs;
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

  async run(signal?: AbortSignal): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      if (signal?.aborted) break;
      const worked = await this.runOnce();
      // Do not sleep after work. This drains a backlog quickly while avoiding an idle busy loop.
      if (!worked) {
        await sleep(
          Math.min(this.pollMs, this.maintenanceIntervalMs, this.housekeepingIntervalMs),
          undefined,
          { signal },
        ).catch(() => undefined);
      }
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

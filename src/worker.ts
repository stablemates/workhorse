import { setTimeout as sleep } from "node:timers/promises";
import { Queue } from "./queue.js";
import type { ClaimedJob, Json } from "./types.js";

export type Failpoint =
  | "afterClaim"
  | "beforeHandler"
  | "afterHandler"
  | "beforeComplete"
  | "afterComplete";
export type Handler<TPayload = Json, TResult extends Json = Json> = (
  payload: TPayload,
  context: { job: ClaimedJob<TPayload>; signal: AbortSignal },
) => Promise<TResult> | TResult;

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
  /** Delay before the next attempt, either fixed or derived from the one-based attempt number. */
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
  private stopping = false;

  constructor(
    private readonly queue: Queue,
    private readonly options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.queueName = options.queue ?? queue.defaultQueue;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(100, Math.floor(this.leaseMs / 3));
    this.pollMs = options.pollMs ?? 250;
    if (this.heartbeatMs >= this.leaseMs) throw new Error("heartbeatMs must be less than leaseMs");
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

  private async inject(point: Failpoint, job: ClaimedJob): Promise<void> {
    const configured = this.options.failpoint;
    const shouldCrash =
      typeof configured === "function" ? await configured(point, job) : configured === point;
    if (shouldCrash) throw new InjectedCrashError(point);
  }

  async runOnce(): Promise<boolean> {
    // Maintenance precedes claim so a worker can make due or abandoned work eligible without a
    // separate scheduler process. Both operations are bounded inside PostgreSQL.
    await this.queue.promote(100);
    await this.queue.recoverExpired(100);
    const job = await this.queue.claim(this.workerId, {
      queue: this.queueName,
      leaseMs: this.leaseMs,
    });
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
      const result = await handler(job.payload, { job, signal: controller.signal });
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
          : (this.options.retryDelayMs ?? 0);
      await this.queue.fail(job, this.workerId, error, delay);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async run(signal?: AbortSignal): Promise<void> {
    this.stopping = false;
    while (!this.stopping) {
      if (signal?.aborted) break;
      const worked = await this.runOnce();
      // Do not sleep after work. This drains a backlog quickly while avoiding an idle busy loop.
      if (!worked) await sleep(this.pollMs, undefined, { signal }).catch(() => undefined);
    }
  }
}

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
  queue?: string;
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  retryDelayMs?: number | ((attempt: number) => number);
  failpoint?: Failpoint | ((point: Failpoint, job: ClaimedJob) => boolean | Promise<boolean>);
}

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
    await this.queue.promote(100);
    await this.queue.recoverExpired(100);
    const job = await this.queue.claim(this.workerId, {
      queue: this.queueName,
      leaseMs: this.leaseMs,
    });
    if (!job) return false;

    await this.inject("afterClaim", job);
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.queue.fail(job, this.workerId, new Error(`No handler registered for ${job.type}`));
      return true;
    }

    const controller = new AbortController();
    let leaseLost = false;
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
      const result = await handler(job.payload, { job, signal: controller.signal });
      await this.inject("afterHandler", job);
      if (leaseLost || controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Job lease was lost");
      await this.inject("beforeComplete", job);
      const accepted = await this.queue.complete(job, this.workerId, result);
      if (!accepted) throw new Error("Completion rejected because the lease is stale or expired");
      await this.inject("afterComplete", job);
    } catch (error) {
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
      if (!worked) await sleep(this.pollMs, undefined, { signal }).catch(() => undefined);
    }
  }
}

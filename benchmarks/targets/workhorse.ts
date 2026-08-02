import type { Pool } from "pg";
import { Queue, Worker, installSchema } from "../../src/index.js";
import type { Json } from "../../src/types.js";
import { CompletionTarget, type TargetMetadata, type WorkItem } from "./types.js";

export class WorkhorseTarget extends CompletionTarget {
  metadata: TargetMetadata = {
    name: "workhorse",
    packageName: "@workhorse/core",
    version: "0.1.0",
    schema: "workhorse",
    queue: "competitor_baseline",
    configuration: {
      maxAttempts: 1,
      leaseMs: 30_000,
      databasePoolMax: 32,
      polling: "native Worker loop with 1ms benchmark fallback polling",
      workers: "one Worker instance using WorkerOptions.concurrency",
      stop: "native graceful Worker.stop() drain",
    },
    capabilities: {
      bulkEnqueue: true,
      nativeWorkerLoop: true,
      claimLatencyComparable: false,
      fencingComparable: true,
      successRetention: "retained",
    },
    notes: [
      "Uses the public Worker runtime so concurrency means local handler slots, matching the product API.",
      "Worker.stop() prevents new claims and drains already active handlers before the run settles.",
      "Success rows and history are retained, unlike Graphile Worker.",
    ],
  };
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly pool: Pool) {
    super();
    this.queue = new Queue(pool, this.metadata.queue);
  }
  async reset(): Promise<void> {
    await this.stop();
    await installSchema(this.pool);
    await this.pool.query(
      "TRUNCATE workhorse.job, workhorse.job_event, workhorse.attempt_history RESTART IDENTITY CASCADE",
    );
    await this.pool.query("ALTER SEQUENCE workhorse.fence_token_seq RESTART WITH 1");
    this.completed.clear();
  }
  async setup(): Promise<void> {
    await installSchema(this.pool);
  }
  async enqueueMany(items: readonly WorkItem[]): Promise<void> {
    await this.queue.enqueueMany(
      items.map((item) => ({
        type: "competitor_baseline",
        payload: { id: item.id, payload: item.payload } as Json,
        options: { maxAttempts: 1 },
      })),
    );
  }
  async startConsumers(concurrency: number): Promise<void> {
    if (this.running) throw new Error("Workhorse consumers are already running");
    this.worker = new Worker(this.queue, {
      concurrency,
      workerId: "competitor-baseline-workhorse",
      leaseMs: 30_000,
      pollMs: 1,
    }).handle<{ id: string }>(this.metadata.queue, async ({ id }) => {
      this.recordCompletion(id);
      return { ok: true };
    });
    this.running = this.worker.run();
  }
  async stop(): Promise<void> {
    const worker = this.worker;
    const running = this.running;
    if (!worker || !running) return;
    worker.stop();
    try {
      await running;
    } finally {
      this.worker = null;
      this.running = null;
    }
  }
  async close(): Promise<void> {
    await this.stop();
  }
}

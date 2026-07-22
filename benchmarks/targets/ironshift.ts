import type { Pool } from "pg";
import { Queue, installSchema } from "../../src/index.js";
import type { ClaimedJob, Json } from "../../src/types.js";
import { CompletionTarget, type TargetMetadata, type WorkItem } from "./types.js";

export class IronshiftTarget extends CompletionTarget {
  metadata: TargetMetadata = {
    name: "ironshift",
    packageName: "ironshift",
    version: "0.1.0",
    schema: "ironshift",
    queue: "competitor_baseline",
    configuration: {
      maxAttempts: 1,
      leaseMs: 30_000,
      databasePoolMax: 32,
      polling: "public Queue claim loop",
    },
    capabilities: {
      bulkEnqueue: true,
      nativeWorkerLoop: false,
      claimLatencyComparable: true,
      fencingComparable: true,
      successRetention: "retained",
    },
    notes: [
      "Uses the public Queue/SQL protocol.",
      "Success rows and history are retained, unlike Graphile Worker.",
    ],
  };
  private readonly queue: Queue;
  private stopping = false;
  private workers: Promise<void>[] = [];
  constructor(private readonly pool: Pool) {
    super();
    this.queue = new Queue(pool, this.metadata.queue);
  }
  async reset(): Promise<void> {
    await this.stop();
    await installSchema(this.pool);
    await this.pool.query(
      "TRUNCATE ironshift.job, ironshift.job_event, ironshift.attempt_history RESTART IDENTITY CASCADE",
    );
    await this.pool.query("ALTER SEQUENCE ironshift.fence_token_seq RESTART WITH 1");
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
    this.stopping = false;
    this.workers = Array.from({ length: concurrency }, (_, index) =>
      this.work(`ironshift-${index + 1}`),
    );
  }
  private async work(workerId: string): Promise<void> {
    while (!this.stopping) {
      const job = await this.queue.claim<{ id: string }>(workerId, { leaseMs: 30_000 });
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      const accepted = await this.queue.complete(job as ClaimedJob<unknown>, workerId, {
        ok: true,
      });
      if (!accepted) throw new Error("Ironshift rejected completion");
      this.recordCompletion(job.payload.id);
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.workers);
    this.workers = [];
  }
  async close(): Promise<void> {
    await this.stop();
  }
}

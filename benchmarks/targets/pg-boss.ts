import type { Pool } from "pg";
import { CompletionTarget, dropSchema, type TargetMetadata, type WorkItem } from "./types.js";

export interface PgBossLike {
  start(): Promise<unknown>;
  stop(options?: unknown): Promise<unknown>;
  createQueue(name: string, options: unknown): Promise<unknown>;
  insert(name: string, jobs: unknown[], options?: unknown): Promise<unknown>;
  work(name: string, options: unknown, handler: (jobs: unknown) => Promise<void>): Promise<unknown>;
}
export class PgBossTarget extends CompletionTarget {
  metadata: TargetMetadata = {
    name: "pg-boss",
    packageName: "pg-boss",
    version: "12.26.2",
    schema: "pgboss_competitor",
    queue: "competitor_baseline",
    configuration: {
      retryLimit: 0,
      deleteAfterSeconds: 0,
      notify: true,
      databasePoolMax: 32,
      enqueue: "insert() batching",
      workers: "work() localConcurrency, batchSize 10, burstWhenBatchFull",
      stop: "graceful",
    },
    capabilities: {
      bulkEnqueue: true,
      nativeWorkerLoop: true,
      claimLatencyComparable: false,
      fencingComparable: false,
      successRetention: "retained",
    },
    notes: [
      "Public work() owns claim and completion, so manual claim latency and Ironshift fencing are not directly comparable.",
      "deleteAfterSeconds 0 disables age-based deletion for benchmark retention.",
    ],
  };
  private boss: PgBossLike | null = null;
  constructor(
    private readonly pool: Pool,
    private readonly factory?: () => Promise<PgBossLike>,
  ) {
    super();
  }
  private async create(): Promise<PgBossLike> {
    if (this.factory) return this.factory();
    const module = await import("pg-boss");
    const PgBoss = module.PgBoss as unknown as new (options: unknown) => PgBossLike;
    return new PgBoss({
      connectionString: this.pool.options.connectionString,
      schema: this.metadata.schema,
      max: 32,
    });
  }
  async reset(): Promise<void> {
    await this.stop();
    await dropSchema(this.pool, this.metadata.schema);
    this.completed.clear();
  }
  async setup(): Promise<void> {
    this.boss = await this.create();
    await this.boss.start();
    await this.boss.createQueue(this.metadata.queue, {
      retryLimit: 0,
      deleteAfterSeconds: 0,
      notify: true,
    });
  }
  async enqueueMany(items: readonly WorkItem[]): Promise<void> {
    if (!this.boss) throw new Error("pg-boss target is not setup");
    await this.boss.insert(
      this.metadata.queue,
      items.map((item) => ({ data: item, retryLimit: 0 })),
    );
  }
  async startConsumers(concurrency: number): Promise<void> {
    if (!this.boss) throw new Error("pg-boss target is not setup");
    await this.boss.work(
      this.metadata.queue,
      {
        localConcurrency: concurrency,
        batchSize: 10,
        burstWhenBatchFull: true,
        pollingIntervalSeconds: 0.5,
        notifyPollingIntervalSeconds: 0.5,
      },
      async (value) => {
        const jobs = Array.isArray(value) ? value : [value];
        for (const raw of jobs as Array<{ data?: WorkItem }>) {
          const item = raw.data;
          if (!item?.id) throw new Error("pg-boss handler received a job without benchmark id");
          this.completed.add(item.id);
        }
      },
    );
  }
  async stop(): Promise<void> {
    if (this.boss) {
      await this.boss.stop({ graceful: true });
      this.boss = null;
    }
  }
  async close(): Promise<void> {
    await this.stop();
  }
}

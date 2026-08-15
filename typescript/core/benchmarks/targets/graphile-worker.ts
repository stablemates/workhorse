import type { Pool } from "pg";
import { CompletionTarget, dropSchema, type TargetMetadata, type WorkItem } from "./types.js";
import { installedVersion } from "./versions.js";

export interface WorkerUtilsLike {
  migrate(): Promise<unknown>;
  addJobs(jobs: unknown[]): Promise<unknown>;
  release(): Promise<unknown>;
}
export interface RunnerLike {
  stop(): Promise<unknown>;
}
export interface GraphileFactory {
  makeWorkerUtils(options: unknown): Promise<WorkerUtilsLike>;
  run(options: unknown): Promise<RunnerLike>;
}
export class GraphileWorkerTarget extends CompletionTarget {
  metadata: TargetMetadata = {
    name: "graphile-worker",
    packageName: "graphile-worker",
    version: installedVersion("graphile-worker"),
    schema: "graphile_worker_competitor",
    queue: "competitor_baseline",
    configuration: {
      maxAttempts: 1,
      databasePoolMax: 32,
      enqueue: "makeWorkerUtils().addJobs",
      workers: "run() taskList/concurrency",
      stop: "graceful runner.stop()",
    },
    capabilities: {
      bulkEnqueue: true,
      nativeWorkerLoop: true,
      claimLatencyComparable: false,
      fencingComparable: false,
      successRetention: "deleted",
    },
    notes: [
      "Successful jobs are deleted, so storage and WAL describe Graphile Worker's native retention semantics.",
      "run() owns claiming; claim latency and Workhorse fence-token behavior are not directly comparable.",
    ],
  };
  private utils: WorkerUtilsLike | null = null;
  private runner: RunnerLike | null = null;
  constructor(
    private readonly pool: Pool,
    private readonly injected?: GraphileFactory,
  ) {
    super();
  }
  private async factory(): Promise<GraphileFactory> {
    if (this.injected) return this.injected;
    return (await import("graphile-worker")) as unknown as GraphileFactory;
  }
  private options(): Record<string, unknown> {
    return { pgPool: this.pool, schema: this.metadata.schema };
  }
  async reset(): Promise<void> {
    await this.stop();
    if (this.utils) {
      await this.utils.release();
      this.utils = null;
    }
    await dropSchema(this.pool, this.metadata.schema);
    this.completed.clear();
  }
  async setup(): Promise<void> {
    const factory = await this.factory();
    this.utils = await factory.makeWorkerUtils(this.options());
    await this.utils.migrate();
  }
  async enqueueMany(items: readonly WorkItem[]): Promise<void> {
    if (!this.utils) throw new Error("Graphile Worker target is not setup");
    await this.utils.addJobs(
      items.map((item) => ({
        identifier: this.metadata.queue,
        payload: item,
        maxAttempts: 1,
      })) as unknown[],
    );
  }
  async startConsumers(concurrency: number): Promise<void> {
    const factory = await this.factory();
    this.runner = await factory.run({
      ...this.options(),
      concurrency,
      noHandleSignals: true,
      taskList: {
        [this.metadata.queue]: async (payload: WorkItem) => {
          if (!payload.id) throw new Error("Graphile task received no benchmark id");
          this.recordCompletion(payload.id);
        },
      },
    });
  }
  async stop(): Promise<void> {
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
    }
  }
  async close(): Promise<void> {
    await this.stop();
    if (this.utils) {
      await this.utils.release();
      this.utils = null;
    }
  }
}

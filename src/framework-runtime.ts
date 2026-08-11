import type { WorkhorseAdapter } from "./adapter.js";
import type { Queue } from "./queue.js";
import type { Queryable } from "./types.js";
import type { Worker, WorkerOptions } from "./worker.js";

export interface WorkhorseRuntimeContext<TTransaction> {
  readonly queue: Queue;
  forTransaction(transaction: TTransaction): Queue;
}

export interface WorkhorseRuntimeWorkerDefinition {
  options?: WorkerOptions;
  configure(worker: Worker): void;
}

export interface WorkhorseRuntimeOptions {
  workers?: readonly WorkhorseRuntimeWorkerDefinition[];
  onWorkerError?: (error: unknown, worker: Worker) => void;
}

/** Framework-neutral lifecycle for workers co-hosted with one application process. */
export class WorkhorseRuntime<TTransaction> {
  readonly database: Queryable;
  readonly context: WorkhorseRuntimeContext<TTransaction>;
  private readonly workers: Worker[] = [];
  private readonly runs: Promise<void>[] = [];
  private started = false;
  private quiescePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly adapter: WorkhorseAdapter<TTransaction>,
    private readonly options: WorkhorseRuntimeOptions = {},
    private readonly runtimeName = "WorkhorseRuntime",
  ) {
    this.database = adapter.database;
    this.context = {
      queue: adapter.queue,
      forTransaction: (transaction) => adapter.forTransaction(transaction),
    };
  }

  start(): void {
    if (this.started) return;
    if (this.quiescePromise || this.closePromise) {
      throw new Error(`A stopped ${this.runtimeName} runtime cannot be restarted`);
    }
    this.started = true;

    for (const definition of this.options.workers ?? []) {
      const worker = this.adapter.createWorker(definition.options);
      definition.configure(worker);
      this.workers.push(worker);
      this.runs.push(
        worker.run().catch((error: unknown) => this.options.onWorkerError?.(error, worker)),
      );
    }
  }

  quiesce(): Promise<void> {
    this.quiescePromise ??= (async () => {
      for (const worker of this.workers) worker.stop();
      await Promise.all(this.runs);
    })();
    return this.quiescePromise;
  }

  stop(): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        await this.quiesce();
      } finally {
        await this.adapter.close();
      }
    })();
    return this.closePromise;
  }
}

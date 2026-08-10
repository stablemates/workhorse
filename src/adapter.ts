import { Queue } from "./queue.js";
import type { Queryable, QueueOptions } from "./types.js";
import { Worker } from "./worker.js";
import type { WorkerOptions } from "./worker.js";

/**
 * Stable runtime surface consumed by framework integrations.
 *
 * Database providers own the conversion from their native database and transaction objects to the
 * core {@link Queryable} protocol. Framework integrations only need the default queue, worker
 * construction, and an idempotent resource shutdown hook.
 */
export interface WorkhorseAdapter<TTransaction = Queryable> {
  readonly database: Queryable;
  readonly queue: Queue;
  forTransaction(transaction: TTransaction): Queue;
  createWorker(options?: WorkerOptions): Worker;
  close(): Promise<void>;
}

export interface WorkhorseAdapterOptions<TTransaction> {
  database: Queryable;
  adaptTransaction: (transaction: TTransaction) => Queryable;
  defaultQueue?: string;
  queueOptions?: QueueOptions;
  close?: () => void | Promise<void>;
}

/** Build one provider-neutral Workhorse runtime around a database adapter. */
export function createWorkhorseAdapter<TTransaction = Queryable>(
  options: WorkhorseAdapterOptions<TTransaction>,
): WorkhorseAdapter<TTransaction> {
  const queue = new Queue(options.database, options.defaultQueue, options.queueOptions);
  let closePromise: Promise<void> | undefined;

  return {
    database: options.database,
    queue,
    forTransaction(transaction) {
      return new Queue(
        options.adaptTransaction(transaction),
        queue.defaultQueue,
        options.queueOptions,
      );
    },
    createWorker(workerOptions) {
      return new Worker(queue, workerOptions);
    },
    close() {
      closePromise ??= Promise.resolve().then(options.close ?? (() => undefined));
      return closePromise;
    },
  };
}

#!/usr/bin/env node
/**
 * The TypeScript probe of the connection budget benchmark (SM-1566). It runs W workers on one pool
 * and holds every claimed task until SIGTERM. `scripts/benchmark-connection-budget.ts` starts it
 * and reads the WH_BENCH_* variables below; the probe does not run on its own.
 */
import { Pool } from "pg";
import { Queue } from "../typescript/core/src/queue.js";
import { Worker } from "../typescript/core/src/worker.js";

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function count(name: string): number {
  const value = Number(setting(name));
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const queueName = setting("WH_BENCH_QUEUE");
const workers = count("WH_BENCH_WORKERS");
const pool = new Pool({
  connectionString: setting("WH_BENCH_DATABASE_URL"),
  application_name: setting("WH_BENCH_APPLICATION_NAME"),
  max: count("WH_BENCH_POOL_SIZE"),
});
// An idle pooled connection that fails must not end the probe; the driver counts what remains.
pool.on("error", (error) => {
  emit({ event: "pool_error", error: String(error) });
});
const queue = new Queue(pool, queueName);

let release!: () => void;
const stopped = new Promise<void>((resolve) => {
  release = resolve;
});

const running = Array.from({ length: workers }, (_, index) => {
  const worker = new Worker(queue, {
    queue: queueName,
    workerId: `wh-bench-typescript-${process.pid}-${index}`,
    concurrency: count("WH_BENCH_CONCURRENCY"),
    heartbeatMs: count("WH_BENCH_HEARTBEAT_MS"),
    leaseMs: count("WH_BENCH_LEASE_MS"),
  });
  // The handler holds its slot until the probe stops or the worker aborts the attempt.
  worker.handle(setting("WH_BENCH_TASK_TYPE"), async (_payload, context) => {
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return null;
  });
  const done = worker.run().catch((error: unknown) => {
    emit({ event: "worker_error", worker: index, error: String(error) });
  });
  return { worker, done };
});
emit({ event: "started", sdk: "typescript", workers });

// The pool state, seen from inside the process. A connection is checked out when the pool counts
// it but it is not idle.
const poolReport = setInterval(() => {
  emit({
    event: "pool",
    total: pool.totalCount,
    idle: pool.idleCount,
    checkedOut: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options.max,
  });
}, 250);

process.once("SIGTERM", () => {
  clearInterval(poolReport);
  // Stop claims first, then let the handlers return.
  for (const { worker } of running) worker.stop();
  release();
  void Promise.all(running.map(({ done }) => done))
    .then(async () => pool.end())
    .then(() => {
      emit({ event: "stopped" });
      process.exit(0);
    });
});

import type { Queue, WorkerProcessWorkerDefinition } from "@workhorse/core";
import {
  DEMO_BATCH_MAX_SIZE,
  DEMO_MAINTENANCE_INTERVAL_MS,
  DEMO_MAINTENANCE_TASK_POLL_MS,
  DEMO_QUEUE,
  DEMO_REGISTRY_INTERVAL_MS,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_WORKER_POLL_MS,
} from "./constants.js";
import type { DemoDatabase } from "./database.js";
import { registerDemoHandlers, type DemoHandlerDependencies } from "./handlers.js";

export interface DemoWorkerDefinitionOptions extends Omit<
  DemoHandlerDependencies,
  "database" | "queue" | "batchMaxSize"
> {
  concurrency: number;
  queue?: string;
  queues?: readonly string[];
  scheduleNamespaces?: readonly string[];
  pollMs?: number;
  registryIntervalMs?: number;
  maintenanceIntervalMs?: number;
  maintenanceTaskPollMs?: number;
  onRegistrationError?: (error: unknown) => void;
}

/** Build the one-Worker definition shared by every demo worker process and the test harness. */
export function createDemoWorkerDefinition(
  database: DemoDatabase,
  queue: Queue,
  options: DemoWorkerDefinitionOptions,
): WorkerProcessWorkerDefinition {
  return {
    options: {
      ...(options.queues ? { queues: options.queues } : { queue: options.queue ?? DEMO_QUEUE }),
      scheduleNamespaces: options.scheduleNamespaces ?? [DEMO_SCHEDULE_NAMESPACE],
      pollMs: options.pollMs ?? DEMO_WORKER_POLL_MS,
      concurrency: options.concurrency,
      maintenanceIntervalMs: options.maintenanceIntervalMs ?? DEMO_MAINTENANCE_INTERVAL_MS,
      maintenanceTaskPollMs: options.maintenanceTaskPollMs ?? DEMO_MAINTENANCE_TASK_POLL_MS,
      registryIntervalMs: options.registryIntervalMs ?? DEMO_REGISTRY_INTERVAL_MS,
      retryDelayMs: (attempt, job) => (job.retryPolicy === null ? attempt * 100 : undefined),
      onRegistrationError: options.onRegistrationError,
    },
    configure(worker) {
      registerDemoHandlers(worker, {
        database,
        queue,
        // A batch cannot hold more members than the worker has execution slots.
        batchMaxSize: Math.min(DEMO_BATCH_MAX_SIZE, options.concurrency),
        durableStepMs: options.durableStepMs,
        durableTimerWaitMs: options.durableTimerWaitMs,
        longRunningJobMs: options.longRunningJobMs,
        onDurableStepOperation: options.onDurableStepOperation,
        onDurableTimerOperation: options.onDurableTimerOperation,
      });
    },
  };
}

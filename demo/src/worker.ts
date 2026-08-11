import {
  defineWorkerProcess,
  type ClaimedJob,
  type WorkerProcessDefinition,
} from "@workhorse/core";
import { createDrizzleAdapter } from "@workhorse/drizzle";
import { Pool } from "pg";
import {
  DEMO_MAINTENANCE_INTERVAL_MS,
  DEMO_MAINTENANCE_TASK_POLL_MS,
  DEMO_QUEUE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_REGISTRY_INTERVAL_MS,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_WORKER_CONCURRENCY,
  DEMO_WORKER_POLL_MS,
} from "./constants.js";
import { createDemoDatabase } from "./database.js";
import { resolveDemoDatabaseUrl } from "./environment.js";
import { registerDemoHandlers } from "./handlers.js";
import { demoLogger } from "./logger.js";

/**
 * The demo's dedicated worker process.
 *
 * This is the production topology the documentation recommends: workers own their own process,
 * their own connection pool, and their own lifecycle, and share nothing with the web tier except
 * PostgreSQL. Run it with `workhorse worker --config <compiled module>`.
 *
 * Two default-queue workers show heterogeneous capacity. A third serial worker owns the partner
 * queue so its seeded backlog drains only as PostgreSQL refills the displayed rate tokens.
 */
const databaseUrl = resolveDemoDatabaseUrl();
const workerPollMs = process.env.WORKHORSE_WORKER_POLL_MS
  ? Number(process.env.WORKHORSE_WORKER_POLL_MS)
  : DEMO_WORKER_POLL_MS;

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const database = createDemoDatabase(pool);
const adapter = createDrizzleAdapter(database, {
  defaultQueue: DEMO_QUEUE,
  close: () => pool.end(),
});

function workerDefinition(
  queue: string,
  concurrency: number,
  scheduleNamespaces: readonly string[] = [],
): WorkerProcessDefinition["workers"][number] {
  return {
    options: {
      queue,
      // No workerId: the demo takes the same generated `<hostname>-<pid>-<random>` identity any
      // deployment gets by default, so the dashboard has to discover the fleet from PostgreSQL.
      scheduleNamespaces,
      pollMs: workerPollMs,
      // Declared once at startup. The demo deliberately offers no runtime concurrency control.
      concurrency,
      maintenanceIntervalMs: DEMO_MAINTENANCE_INTERVAL_MS,
      maintenanceTaskPollMs: DEMO_MAINTENANCE_TASK_POLL_MS,
      registryIntervalMs: DEMO_REGISTRY_INTERVAL_MS,
      // Keep unconfigured demo jobs fast while persisted policies remain PostgreSQL-owned.
      // Returning undefined omits the worker override and lets SQL select the stored policy.
      retryDelayMs: (attempt: number, job: ClaimedJob) =>
        job.retryPolicy === null ? attempt * 100 : undefined,
      onRegistrationError: (error: unknown) =>
        demoLogger.error(
          "workhorse.demo.worker_registration_failed",
          "Worker registration failed; the fleet view will not show this worker",
          error,
        ),
    },
    configure(worker) {
      registerDemoHandlers(worker, { database, queue: adapter.queue });
    },
  };
}

export default defineWorkerProcess({
  adapter: () => adapter,
  workers: [
    ...DEMO_WORKER_CONCURRENCY.map((concurrency) =>
      workerDefinition(DEMO_QUEUE, concurrency, [DEMO_SCHEDULE_NAMESPACE]),
    ),
    workerDefinition(DEMO_RATE_LIMIT_QUEUE, 1),
  ],
  logger: {
    info: (message) => demoLogger.info("workhorse.demo.worker_process", message),
    error: (message, error) =>
      demoLogger.error("workhorse.demo.worker_process_error", message, error),
  },
});

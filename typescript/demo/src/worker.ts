import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { defineWorkerProcess } from "@stablemates/workhorse";
import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { Pool } from "pg";
import {
  DEMO_QUEUE,
  DEMO_RATE_LIMIT_QUEUE,
  DEMO_SCHEDULE_NAMESPACE,
  DEMO_SHARED_QUEUE,
  DEMO_WORKER_CONCURRENCY,
  DEMO_WORKER_POLL_MS,
} from "./constants.js";
import { DEMO_QUEUE_OPTIONS } from "./contracts.js";
import { createDemoDatabase } from "./database.js";
import { resolveDemoDatabaseUrl } from "./environment.js";
import { demoLogger } from "./logger.js";
import { createDemoWorkerDefinition } from "./worker-definition.js";

/**
 * The demo's dedicated worker process.
 *
 * This is the production topology the documentation recommends: workers own their own process,
 * their own connection pool, and their own lifecycle, and share nothing with the web tier except
 * PostgreSQL. Run it with `workhorse worker --config <compiled module>`.
 *
 * The launcher starts this TypeScript worker beside the Python and Go demo workers. This worker
 * owns the application-specific handlers and serves the ordinary and rate-limited queues. All
 * three runtimes also serve one shared queue whose handler has the same contract in every SDK.
 */
const databaseUrl = resolveDemoDatabaseUrl();
const workerPollMs = process.env.WORKHORSE_WORKER_POLL_MS
  ? Number(process.env.WORKHORSE_WORKER_POLL_MS)
  : DEMO_WORKER_POLL_MS;
const workerId = `demo-typescript-${hostname().replaceAll(/[^\w.-]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const database = createDemoDatabase(pool);
const adapter = createDrizzleAdapter(database, {
  defaultQueue: DEMO_QUEUE,
  queueOptions: DEMO_QUEUE_OPTIONS,
  close: () => pool.end(),
});

export default defineWorkerProcess({
  adapter: () => adapter,
  workers: [
    createDemoWorkerDefinition(database, adapter.queue, {
      queues: [DEMO_QUEUE, DEMO_RATE_LIMIT_QUEUE, DEMO_SHARED_QUEUE],
      concurrency: DEMO_WORKER_CONCURRENCY[0],
      workerId,
      scheduleNamespaces: [DEMO_SCHEDULE_NAMESPACE],
      pollMs: workerPollMs,
      onRegistrationError: (error) =>
        demoLogger.error(
          "workhorse.demo.worker_registration_failed",
          "Worker registration failed; the fleet view will not show this worker",
          error,
        ),
    }),
  ],
  logger: {
    info: (message) => demoLogger.info("workhorse.demo.worker_process", message),
    error: (message, error) =>
      demoLogger.error("workhorse.demo.worker_process_error", message, error),
  },
});
